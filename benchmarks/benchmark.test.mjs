import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("internal benchmark completes offline and reports validated local operations", () => {
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "benchmarks/internal-latency.ts", "--quick", "--json",
  ], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    timeout: 90_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const report = JSON.parse(result.stdout);
  assert.equal(report.networkAttempts, 0);
  assert.ok(report.environment.node);
  for (const name of [
    "workspace.load", "skills.discover", "sqlite.read.100", "runtime.submit",
    "runtime.command", "runtime.queue.cancel.100", "instructions.inject",
    "skills.inject", "context.prune.100", "render.cold.40x120", "render.cached.40x120",
  ]) {
    const metric = report.samples.find((sample) => sample.name === name);
    assert.ok(metric, `Missing metric: ${name}`);
    assert.ok(metric.iterations > 0);
    assert.ok(Number.isFinite(metric.medianMs) && metric.medianMs >= 0);
    assert.ok(metric.p95Ms >= metric.medianMs);
  }
});

test("caught network attempts still fail a benchmark process", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    const guard = await import('./benchmarks/harness.mjs');
    try { await fetch('http://127.0.0.1:9'); } catch {}
    try { (await import('node:http')).request('http://127.0.0.1:9'); } catch {}
    console.log(guard.networkAttempts);
  `], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8", timeout: 5000, windowsHide: true,
  });
  assert.equal(result.stdout.trim(), "2", result.stderr);
  assert.equal(result.status, 1, "a swallowed network error must not produce a successful run");
});
