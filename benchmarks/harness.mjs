import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";

// Installed before Cube imports, also preloaded in packaged smoke processes.
export let networkAttempts = 0;
const denyNetwork = () => {
  networkAttempts++;
  throw new Error("Network is disabled in Cube benchmarks.");
};
globalThis.fetch = async () => denyNetwork();
http.request = http.get = https.request = https.get = denyNetwork;
net.Socket.prototype.connect = denyNetwork;
syncBuiltinESMExports();
process.on("beforeExit", () => { if (networkAttempts) process.exitCode = 1; });

export const quick = process.argv.includes("--quick");
export const samples = [];

export async function measure(name, operation, verify, options = {}) {
  const iterations = quick ? Math.min(3, options.iterations ?? 100) : (options.iterations ?? 100);
  const warmup = quick ? Math.min(1, options.warmup ?? 10) : (options.warmup ?? 10);
  const timings = [];
  for (let index = 0; index < warmup + iterations; index++) {
    await options.prepare?.(index);
    const start = performance.now();
    const result = await operation(index);
    const elapsed = performance.now() - start;
    // Assertions, setup and disposal are outside the timed interval.
    await verify(result, index);
    assert.equal(networkAttempts, 0, `${name} attempted network access`);
    if (index >= warmup) timings.push(elapsed);
  }
  timings.sort((a, b) => a - b);
  const at = (percentile) => timings[Math.ceil(timings.length * percentile) - 1];
  samples.push({ name, medianMs: at(0.5), p95Ms: at(0.95), iterations, warmup });
}

export function report(details = {}) {
  assert.equal(networkAttempts, 0);
  const result = {
    environment: {
      node: process.version, platform: process.platform, arch: process.arch,
      os: os.release(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
    },
    ...details, networkAttempts, samples,
  };
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Cube local benchmark · ${result.environment.node} · ${process.platform}/${process.arch}`);
    console.log("No inference/network; assertions and fixture setup are not timed.");
    console.table(samples.map((sample) => ({
      operation: sample.name, "median ms": sample.medianMs.toFixed(3),
      "p95 ms": sample.p95Ms.toFixed(3), n: sample.iterations, warmup: sample.warmup,
    })));
    console.log(JSON.stringify({ ...result, samples: undefined }, null, 2));
  }
}
