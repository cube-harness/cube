// Opt-in integration: real credentials are read only; all runtime writes stay in this fixture.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AuthStore, ConfigStore, CubeHome, CubeWorkspace, RunnableConfigSchema, createBootstrap } from "@cube/workspace";
import { prepareCubeRuntime } from "../src/bootstrap.js";

// SQLite's native transaction handles on Windows are released at process exit.
if (process.platform === "win32" && !process.env.CUBE_SUBAGENT_LIVE_ROOT) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-subagents-live-"));
  try {
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", import.meta.filename], {
      env: { ...process.env, CUBE_SUBAGENT_LIVE_ROOT: root }, windowsHide: true, timeout: 360000,
    });
    assert.equal(result.stderr, "");
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    process.stdout.write(result.stdout);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
} else {
const source = CubeHome();
const selection = RunnableConfigSchema.parse(await ConfigStore(source).read());
const { permissions: _permissions, ...document } = selection;
const auth = await new AuthStore(source).read();
const root = process.env.CUBE_SUBAGENT_LIVE_ROOT ?? await mkdtemp(path.join(os.tmpdir(), "cube-subagents-live-"));
const project = path.join(root, "project");
const home = CubeHome({ cubeHome: path.join(root, "home"), userHome: root });
let runtime: Awaited<ReturnType<Awaited<ReturnType<typeof prepareCubeRuntime>>["start"]>> | undefined;
const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: project, windowsHide: true });
const wait = async (check: () => Promise<boolean>) => {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error("Real provider subagent did not settle within two minutes");
};
try {
  await mkdir(project); await createBootstrap(home).run();
  await git("init"); await git("config", "user.name", "Cube Smoke");
  await git("config", "user.email", "cube@example.invalid");
  await writeFile(path.join(project, "fixture.txt"), "ORIGINAL_FIXTURE\n");
  await git("add", "fixture.txt"); await git("commit", "-m", "fixture");
  const before = await readFile(path.join(project, ".git", "index"));
  const [strategy, provider] = selection.gateway.split("/");
  await new AuthStore(home).update(current => ({ ...current,
    ...(strategy === "api_key" ? { api_keys: { [provider!]: auth.api_keys[provider as keyof typeof auth.api_keys] } } : {}),
    ...(strategy === "oauth" ? { oauth: { [provider!]: auth.oauth[provider as keyof typeof auth.oauth] } } : {}),
  }));
  await ConfigStore(home).update(() => ({ ...document,
    memory: { ...selection.memory, durable: { ...selection.memory.durable, enabled: false },
      generate_title: { ...selection.memory.generate_title, enabled: false } },
    subagents: { ...selection.subagents, timeout_ms: 90000 } }));
  await copyFile(source.getModelCatalogPath(), home.getModelCatalogPath());
  await CubeWorkspace(home, project).setTrust(true);
  const startup = await prepareCubeRuntime({ home, workspacePath: project });
  runtime = await startup.start();
  const parent = await runtime.thread.ensureForPrompt("Subagent integration fixture");
  const owner = { projectRoot: runtime.workspaceRoot, parentThreadId: parent };
  const service = runtime.subagents!;
  let approvals = 0;
  const stop = runtime.subscribe(event => {
    if (event.type === "subagent_interaction" && event.event.type === "tool_approval_required") {
      approvals++;
      runtime!.respondToApproval({ target: event.target, toolCallId: event.target.toolCallId,
        toolName: event.event.toolName, decision: event.description === "decline write" ? "decline" : "approve",
        declineReason: "User declined tool execution." });
    }
  });
  const spawned = await service.spawn(owner, { tasks: [
    { agent: "explore", description: "read fixture", task: "Use read_file to read fixture.txt and report its exact contents. Do not edit anything." },
    { agent: "worker", description: "isolated write", isolation: "worktree", task: "Use write_file to create child.txt containing CHILD_OK followed by a newline. Read it back and report the result. Do not use shell tools or edit other files." },
  ] });
  await wait(async () => (await service.list(owner)).filter(item => spawned.agents.some(spawned => spawned.id === item.id))
    .every(item => ["completed", "failed", "cancelled"].includes(item.status)));
  for (const child of spawned.agents) {
    const view = await service.get(owner, { id: child.id, view: "result" });
    assert.equal(view.status, "completed", JSON.stringify(view));
    assert.ok("text" in view.data && JSON.parse(view.data.text).text.trim());
    assert.equal((await service.get(owner, { id: child.id, view: "transcript" })).truncated, false);
  }
  const worker = spawned.agents[1]!;
  assert.equal(await readFile(path.join(worker.worktreePath!, "child.txt"), "utf8"), "CHILD_OK\n");
  await assert.rejects(readFile(path.join(project, "child.txt")), /ENOENT/);
  assert.deepEqual(await readFile(path.join(project, ".git", "index")), before);
  assert.ok(approvals > 0);
  const changes = await service.get(owner, { id: worker.id, view: "changes" });
  assert.ok("text" in changes.data && /child.txt/.test(changes.data.text));
  await service.send(owner, { id: worker.id, message: "Use write_file to create denied.txt with DENIED. Do not use shell. Report the actual outcome." });
  // Switch this child's label only for the human decision, not its persisted role.
  let denied = false;
  stop();
  const stopDecline = runtime.subscribe(event => {
    if (event.type === "subagent_interaction" && event.event.type === "tool_approval_required") {
      denied = true;
      runtime!.respondToApproval({ target: event.target, toolCallId: event.target.toolCallId, toolName: event.event.toolName,
        decision: "decline", declineReason: "User declined tool execution." });
    }
  });
  await wait(async () => denied && (await service.list(owner)).find(item => item.id === worker.id)!.status === "completed");
  await assert.rejects(readFile(path.join(worker.worktreePath!, "denied.txt")), /ENOENT/);
  const interrupted = (await service.spawn(owner, { agent: "explore", description: "interrupt fixture",
    task: "Read fixture.txt, list files and inspect their contents carefully." })).agents[0]!;
  await service.interrupt(owner, interrupted.id);
  await wait(async () => !(await service.list(owner)).find(item => item.id === interrupted.id)!.canInterrupt);
  stopDecline();
  await runtime.shutdown(); runtime = undefined;
  runtime = await (await prepareCubeRuntime({ home, workspacePath: project })).start();
  await runtime.thread.resume(parent);
  assert.equal((await runtime.subagents!.list(owner)).length, 3);
  assert.ok(!(await runtime.thread.list()).some(item => item.id === worker.id));
  await runtime.subagents!.removeWorktree(owner, worker.id, true);
  assert.equal(await readFile(path.join(project, "fixture.txt"), "utf8"), "ORIGINAL_FIXTURE\n");
  const parentTools: string[] = [];
  const errors: string[] = [];
  const stopParent = runtime.subscribe(event => {
    if (event.type === "tool_start") parentTools.push(event.toolName);
    if (event.type === "error") errors.push(event.error.message);
  });
  try {
    const submitted = await runtime.prompt.submit("Use spawn_agent exactly once with agent explore, description parent delegation, " +
      "and task: Read fixture.txt with read_file and report its exact contents without changing anything. " +
      "Use single mode, isolation none. Do not read the file yourself or spawn more children. Report the returned ID.");
    assert.equal(submitted.kind, "submitted", JSON.stringify(submitted));
    await wait(async () => {
      const children = await runtime!.subagents!.list(owner);
      return children.length === 4 && children.filter(child => !spawned.agents.some(original => original.id === child.id) && child.id !== interrupted.id)
        .every(child => child.status === "completed") && !runtime!.subagents!.isBusy();
    });
    assert.ok(parentTools.includes("spawn_agent"), "real parent model must invoke the exposed tool");
    assert.deepEqual(errors, []);
  } finally { stopParent(); }
  console.log("subagents-live-smoke: parent delegation verified");
  let questionCancelled = false;
  let questionError: unknown;
  const stopQuestion = runtime.subscribe(event => {
    if (event.type === "subagent_interaction" && event.event.type === "tool_suspended" && event.event.toolName === "ask_user") {
      questionCancelled = true;
      void runtime!.cancelSuspension(event.target.toolCallId, event.target).catch(error => { questionError = error; });
    }
  });
  try {
    const question = (await runtime.subagents!.spawn(owner, { agent: "explore", description: "cancel question",
      task: "Use ask_user exactly once to ask whether the user wants a detailed report. After their answer or cancellation, " +
        "acknowledge the actual outcome in your final response. Do not edit files or repeat the question." })).agents[0]!;
    await wait(async () => questionCancelled && (await runtime!.subagents!.list(owner)).find(child => child.id === question.id)?.status === "completed");
    console.log("subagents-live-smoke: child question cancellation continued");
    assert.equal(questionError, undefined);
    let transcript = "";
    let cursor: string | undefined;
    let pages = 0;
    do {
      assert.ok(++pages <= 100, "Transcript pagination did not terminate");
      const page = await runtime.subagents!.get(owner, { id: question.id, view: "transcript", cursor });
      assert.ok("text" in page.data);
      transcript += page.data.text;
      cursor = page.nextCursor;
    } while (cursor);
    assert.ok(/User declined to answer the question/.test(transcript),
      `Decline missing from ${pages} transcript pages (${transcript.length} chars)`);
  } finally { stopQuestion(); }
  console.log(`subagents-live-smoke: OK (${selection.gateway}, ${selection.model})`);
} finally {
  await runtime?.shutdown();
  if (!process.env.CUBE_SUBAGENT_LIVE_ROOT)
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
}
