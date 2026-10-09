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
const selection = RunnableConfigSchema.parse({ ...await ConfigStore(source).read(),
  ...(process.env.CUBE_SUBAGENT_SMOKE_MODEL ? {
    gateway: process.env.CUBE_SUBAGENT_SMOKE_GATEWAY,
    model: process.env.CUBE_SUBAGENT_SMOKE_MODEL,
  } : {}),
});
const { permissions: _permissions, ...document } = selection;
const auth = await new AuthStore(source).read();
const root = process.env.CUBE_SUBAGENT_LIVE_ROOT ?? await mkdtemp(path.join(os.tmpdir(), "cube-subagents-live-"));
const project = path.join(root, "project");
const home = CubeHome({ cubeHome: path.join(root, "home"), userHome: root });
let runtime: Awaited<ReturnType<Awaited<ReturnType<typeof prepareCubeRuntime>>["start"]>> | undefined;
// Unlike the TUI, this headless fixture has no terminal handle keeping Node alive.
const keepAlive = setInterval(() => {}, 60000);
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
        toolName: event.event.toolName, decision: event.description.startsWith("DECLINE") ? "decline" : "approve",
        declineReason: "User declined tool execution." });
    }
  });
  await mkdir(path.join(project, ".agents", "agents"), { recursive: true });
  await writeFile(path.join(project, ".agents", "agents", "isolated.md"), "---\ndescription: Isolated file writer\nisolation: worktree\ntools: [read_file, write_file]\n---\nComplete the assigned file task, read it back, report actual evidence. Do not use shell or edit other files.");
  await service.reloadCatalog();
  const parentTools: string[] = []; const errors: string[] = []; const nativeResults: string[] = [];
  const toolNames = new Map<string, string>();
  let questionCancelled = false;
  const stopParent = runtime.subscribe(event => {
    if (event.type === "tool_approval_required") {
      errors.push(`Parent attempted unexpected approval: ${event.toolName}`);
      runtime!.respondToApproval({ toolCallId: event.toolCallId, toolName: event.toolName,
        decision: "decline", declineReason: "Fixture permits delegation only." });
    }
    if (event.type === "tool_start") { parentTools.push(event.toolName); toolNames.set(event.toolCallId, event.toolName); }
    if (event.type === "error") errors.push(event.error.message);
    if (event.type === "tool_end" && toolNames.get(event.toolCallId)?.startsWith("agent-"))
      nativeResults.push(JSON.stringify(event.result).slice(0, 1500));
    if (event.type === "subagent_interaction" && event.event.type === "tool_suspended") {
      questionCancelled = true;
      void runtime!.cancelSuspension(event.target.toolCallId, event.target).catch(error => errors.push(String(error)));
    }
  });
  const delegate = async (role: string, task: string) => {
    const existing = new Set((await service.list(owner)).map(item => item.id));
    await wait(async () => !runtime!.getDisplayState().isRunning);
    console.log(`[smoke] delegate ${role}`);
    const submitted = await runtime!.prompt.submit(`Call agent-${role} exactly once with prompt: ${task}. Delegate it; do not do the task yourself. Do not use other agent tools or repeat the assignment. Report the returned background job ID and end this turn. The result arrives separately; do not poll or wait using tools.`);
    console.log(`[smoke] parent ${role}: ${submitted.kind}`);
    assert.equal(submitted.kind, "submitted", JSON.stringify(submitted));
    let job: Awaited<ReturnType<typeof service.list>>[number] | undefined;
    try {
      await wait(async () => {
        if (errors.length) throw new Error(errors.join("\n"));
        job = (await service.list(owner)).find(item => !existing.has(item.id));
        if (!job && !runtime!.getDisplayState().isRunning) throw new Error(`No accepted job: ${nativeResults.at(-1) ?? "no native result"}`);
        return !!job && ["completed", "failed", "cancelled"].includes(job.status);
      });
    } catch (error) {
      const state = runtime!.getDisplayState();
      throw new Error(`${selection.gateway} ${selection.model}: ${String(error)}; tools=${parentTools.join(",")}; job=${JSON.stringify(job)}; running=${state.isRunning}`);
    }
    assert.ok(job); assert.equal(job.status, "completed", JSON.stringify(await service.get(owner, { id: job.id, view: "result" })));
    assert.ok(parentTools.includes("agent-" + role));
    return job;
  };
  try {
    const explore = await delegate("explore", "Use read_file on fixture.txt; report its exact contents. Do not change files");
    const worker = await delegate("isolated", "Use write_file to create child.txt containing CHILD_OK followed by a newline; read it back and report evidence");
    assert.equal(await readFile(path.join(worker.worktreePath!, "child.txt"), "utf8"), "CHILD_OK\n");
    await assert.rejects(readFile(path.join(project, "child.txt")), /ENOENT/);
    assert.deepEqual(await readFile(path.join(project, ".git", "index")), before);
    assert.ok(approvals > 0);
    const diff = await service.get(owner, { id: worker.id, view: "changes" });
    assert.ok("text" in diff.data && diff.data.text.includes("child.txt"));
    const denied = await delegate("worker", "DECLINE: Use write_file to create denied.txt containing DENIED; report the actual outcome, do not retry or use shell");
    await assert.rejects(readFile(path.join(project, "denied.txt")), /ENOENT/);
    const question = await delegate("worker", "Use ask_user once to ask Continue? After the answer/cancellation acknowledge it; do not ask again");
    assert.ok(questionCancelled);
    let transcript = ""; let cursor: string | undefined;
    do {
      const page = await service.get(owner, { id: question.id, view: "transcript", cursor });
      assert.ok("text" in page.data); transcript += page.data.text; cursor = page.nextCursor;
    } while (cursor);
    assert.match(transcript, /User declined to answer the question/);
    assert.deepEqual(errors, []);
    const ids = [explore, worker, denied, question].map(job => job.id);
    stop(); stopParent();
    await runtime.shutdown(); runtime = undefined;
    runtime = await (await prepareCubeRuntime({ home, workspacePath: project })).start();
    await runtime.thread.resume(parent);
    const restored = await runtime.subagents!.list(owner);
    assert.ok(ids.every(id => restored.some(job => job.id === id)));
    const history = await runtime.subagents!.get(owner, { id: explore.id, view: "result" });
    const native = "text" in history.data ? JSON.parse(history.data.text).threadId : undefined;
    assert.ok(native && !(await runtime.thread.list()).some(thread => thread.id === native));
    await runtime.subagents!.removeWorktree(owner, worker.id, true);
    console.log(`subagents-live-smoke: OK (${selection.gateway}, ${selection.model}); native parent tools, private history, approve/decline, ask cancellation, worktree and restart`);
  } finally { stop(); stopParent(); }
} finally {
  clearInterval(keepAlive);
  await runtime?.shutdown();
  if (!process.env.CUBE_SUBAGENT_LIVE_ROOT) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
}
