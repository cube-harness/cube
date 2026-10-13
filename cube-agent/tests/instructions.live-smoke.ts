// Opt-in provider behavior check. Real credentials are read-only; all artifacts stay in a temporary home.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AuthStore, ConfigStore, CubeHome, CubeWorkspace, RunnableConfigSchema, createBootstrap, ModelCatalogStore } from "@cube/workspace";
import { createCubeMastra } from "../src/bootstrap.js";
import { configureCubePermissions } from "../src/permission.js";
import { BackgroundService } from "../../cube-runtime/src/services/background.service.js";

if (process.platform === "win32" && !process.env.CUBE_INSTRUCTION_SMOKE_ROOT) {
  const root = await mkdtemp(join(tmpdir(), "cube-instruction-smoke-"));
  try {
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", import.meta.filename], {
      env: { ...process.env, CUBE_INSTRUCTION_SMOKE_ROOT: root }, windowsHide: true, timeout: 240000,
    });
    process.stdout.write(result.stdout);
    assert.equal(result.stderr, "");
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
} else {
  const source = CubeHome();
  const auth = await new AuthStore(source).read();
  const provider = (process.env.CUBE_INSTRUCTION_SMOKE_PROVIDER ?? "google") as keyof typeof auth.api_keys;
  const credential = auth.api_keys[provider];
  assert.ok(credential, "Selected API credential required");
  const sourceConfig = await ConfigStore(source).read();
  const catalog = await ModelCatalogStore(source).read();
  const models = catalog.api_key[provider]?.models ?? [];
  const selected = process.env.CUBE_INSTRUCTION_SMOKE_MODEL ?? (provider === "google" ? models.find(model =>
    /^google\/gemini-3\.[0-9]+-flash$/.test(model.modelId) && model.tool_call)?.modelId
    : sourceConfig.gateway === `api_key/${provider}` ? sourceConfig.model : undefined);
  assert.ok(selected && models.some(model => model.modelId === selected), "Choose a cataloged chat model");
  const root = process.env.CUBE_INSTRUCTION_SMOKE_ROOT ?? await mkdtemp(join(tmpdir(), "cube-instruction-smoke-"));
  const home = CubeHome({ cubeHome: join(root, "home"), userHome: root });
  const project = join(root, "project"); await mkdir(project);
  await createBootstrap(home).run();
  await new AuthStore(home).update(current => ({ ...current, api_keys: { [provider]: credential } }));
  await writeFile(join(project, "notes.md"), "# Fixture\nFeature A uses a fixed deadline. Feature B queues independent work.\n");
  const config = RunnableConfigSchema.parse({ gateway: `api_key/${provider}`, model: selected,
    model_config: provider === "google" ? { reasoning_effort: "low" } : sourceConfig.model_config,
    memory: { durable: { enabled: false }, generate_title: { enabled: false } },
    permissions: { require_approval_for: [], deny_for: ["write_file", "edit_file", "apply_patch"] },
    background_tasks: { timeout_ms: 15000 },
  });
  const composition = await createCubeMastra(home, CubeWorkspace(home, project), config);
  const session = await composition.controller.createSession({ resourceId: project });
  const keepAlive = setInterval(() => {}, 1000);
  const errors: string[] = [], calls: string[] = [], assignments: string[] = [];
  const background = new BackgroundService({
    history: () => composition.mastra.getStorage()!.getStore("backgroundTasks"), processes: composition.tools.processes,
    workspaceRoot: project, currentThread: () => session.thread.getId(), notice: message => errors.push(message),
    redact: composition.redact, drain: composition.drain, continueProcess: composition.continueProcess,
  });
  composition.tools.setTaskHandler(async (input, thread) => {
    if (input.action === "list") return { tasks: await background.list(thread) };
    if (input.action === "kill") await background.stop(input, thread);
    return background.get(input, thread);
  });
  // This verifies the parent's real delegation decision, not a child's implementation.
  let acceptedJob = "";
  composition.subagents.setDispatch(async request => { assignments.push(request.role); acceptedJob = randomUUID(); return { id: acceptedJob }; });
  const stop = session.subscribe(event => {
    if (event.type === "tool_start") calls.push(event.toolName);
    if (event.type === "error") errors.push(event.error.message);
    if (event.type === "tool_suspended") void session.cancelSuspension(event.toolCallId);
  });
  const turn = async (prompt: string) => {
    calls.length = 0; assignments.length = 0;
    await session.thread.clearAndReleaseLock(); await session.thread.create({ id: randomUUID() });
    await session.followUp({ content: prompt }); await composition.drain();
    assert.deepEqual(errors, []);
  };
  try {
    await configureCubePermissions(session, config.permissions);
    await turn("Read notes.md and briefly explain the difference between Feature A and B.");
    assert.ok(calls.includes("read_file")); assert.deepEqual(assignments, []);
    console.log(JSON.stringify({ case: "ordinary lookup without delegation", model: selected, calls }));
    await turn("Use the explore subagent to synthesize notes.md. Give it the relevant task and return the accepted job ID.");
    assert.deepEqual(assignments, ["explore"]);
    console.log(JSON.stringify({ case: "explicit delegation", model: selected, calls }));
    // Controlled child failure, real parent model: a failed report is not absence of evidence.
    const childId = acceptedJob;
    composition.tools.setSubagentHandler(async input => {
      assert.equal(input.action, "get");
      assert.ok("id" in input && input.id === childId);
      assert.ok("view" in input && input.view === "transcript");
      return { id: childId, status: "failed", data: { text: "Search saved PARTIAL_EVIDENCE_429 before upstream quota failure." }, truncated: false };
    });
    await composition.deliverSubagentResult({ id: childId, agent: "explore", projectRoot: project,
      parentThreadId: session.thread.getId()!, pendingDelivery: "subagent-" + childId,
      status: "failed", error: "HTTP 429: upstream rate limited" }, false);
    calls.length = 0; assignments.length = 0;
    await session.followUp({ content: "Read the saved partial transcript of the failed child and report what evidence was actually recovered. Do not retry the assignment." });
    await composition.drain();
    assert.ok(calls.includes("manage_subagent"));
    assert.ok(!calls.includes("manage_task"));
    assert.deepEqual(assignments, []); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ case: "failed child evidence via correct tool", model: selected, calls }));
    await turn('Run this command in the background: node -e "setTimeout(()=>console.log(\'BEHAVIOR_BUILD_OK\'),2500)". While it runs, read notes.md and summarize it.');
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const jobs = await background.list();
      if (jobs.some(job => job.status === "completed") && !session.run.isRunning()) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await background.drain(); await composition.drain();
    assert.ok((await background.list()).some(job => job.status === "completed"));
    assert.ok(JSON.stringify(await session.thread.listMessages({ threadId: session.thread.getId()! })).includes("BEHAVIOR_BUILD_OK"));
    assert.ok(calls.filter(name => name === "manage_task").length <= 1, `Repeated polling: ${calls.join(",")}`);
    assert.deepEqual(assignments, []); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ case: "background completion without polling loop", model: selected, calls }));
  } finally {
    stop(); session.abort(); await background.shutdown(); await composition.shutdown(); clearInterval(keepAlive);
    if (!process.env.CUBE_INSTRUCTION_SMOKE_ROOT) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
