import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import { HomeManager } from "../../cube-workspace/src/home-manager.js";
import { prepareCubeRuntime, toRuntimeNotice, type CubeBootstrap } from "@cube/runtime";
import { OnBoardScreen } from "../src/screens/on-board.screen.js";

// The installed pi-tui does not export VirtualTerminal. Exercise its real renderer
// against the public Terminal interface, recording every write and sending keys.
const recordingTerminal = () => {
  const writes: string[] = [];
  let input: (data: string) => void = () => undefined;
  const terminal: Terminal = {
    start: (onInput) => { input = onInput; }, stop: () => undefined,
    drainInput: async () => undefined, write: (data) => { writes.push(data); },
    columns: 60, rows: 30, kittyProtocolActive: false,
    moveBy: () => undefined, hideCursor: () => undefined, showCursor: () => undefined,
    clearLine: () => undefined, clearFromCursor: () => undefined, clearScreen: () => undefined,
    setTitle: () => undefined, setProgress: () => undefined,
  };
  return { terminal, writes, input: (data: string) => input(data) };
};

test("Escape closes xAI login and flushes a cancellation system message before onboarding stops", async t => {
  const terminal = recordingTerminal();
  const tui = new TuiMainScreen(terminal.terminal);
  const screen = new OnBoardScreen(tui);
  t.after(() => screen.stopTerminal());
  let cancelled = 0;
  const gateway = {
    listChoices: async () => [{ gatewayId: "oauth/xai", group: "oauth", provider: "xai", configured: false }],
    beginGrokLogin: async () => ({
      authorizationUrl: "https://accounts.x.ai/oauth2/device?user_code=TEST-CODE",
      expiresAt: Date.now() + 1800000, completion: new Promise(() => undefined),
      cancel: async () => { cancelled++; },
    }),
  } as unknown as CubeBootstrap["gateway"];
  const pending = screen.pickGateway(gateway);
  await new Promise(resolve => setImmediate(resolve));
  terminal.input("\r");
  terminal.input("\r");
  await new Promise(resolve => setImmediate(resolve));
  tui.renderNow();
  assert.match(terminal.writes.join(""), /Sign in to xAI/);
  terminal.writes.length = 0;
  terminal.input("\x1b");
  assert.equal(await pending, null);
  screen.stopTerminal();
  assert.equal(cancelled, 1);
  const finalFrame = terminal.writes.join("");
  assert.match(finalFrame, /xAI sign-in cancelled/);
  assert.doesNotMatch(finalFrame, /Sign in to xAI|https:|Expires in|Waiting for/);
});

test("temporary-home onboarding renders separately, masks keys, and recovers from rejected credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-onboard-"));
  const home = new HomeManager({ cubeHome: path.join(root, ".cube") });
  const terminal = recordingTerminal();
  const screen = new OnBoardScreen(new TuiMainScreen(terminal.terminal));
  try {
    const bootstrap = await prepareCubeRuntime({ home, workspacePath: root,
      fetch: async () => new Response("sensitive-server-response", { status: 401 }) });
    assert.equal(bootstrap.readiness.ready, false);
    const before = await readFile(home.getAuthPath(), "utf8");
    const configBefore = await readFile(home.getConfigPath(), "utf8");
    screen.mount();
    const pending = screen.pickGateway(bootstrap.gateway);
    await new Promise((resolve) => setTimeout(resolve, 40));
    terminal.input("\r"); // API key
    terminal.input("\r"); // Google -> masked input
    for (const char of "synthetic-secret") terminal.input(char);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.match(terminal.writes.join(""), /Set up Cube/);
    assert.doesNotMatch(terminal.writes.join(""), /synthetic-secret|new thread|Working \(/);
    const failed = assert.rejects(pending, /credential was rejected/);
    terminal.input("\r");
    await failed;
    screen.showNotice(toRuntimeNotice(new Error("Google credential was rejected.")));
    const retry = screen.waitForRetry();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.match(terminal.writes.join(""), /Google credential was rejected/);
    assert.doesNotMatch(terminal.writes.join(""), /sensitive-server-response|Fatal TUI|CLIENT_CLOSED/);
    terminal.input("\x1b");
    assert.equal(await retry, false);
    assert.equal(await readFile(home.getAuthPath(), "utf8"), before);
    assert.equal(await readFile(home.getConfigPath(), "utf8"), configBefore);
  } finally {
    screen.stopTerminal();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
