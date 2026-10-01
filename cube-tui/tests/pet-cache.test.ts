import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePetFrames } from "../src/components/pet.js";

test("pet generates missing cache once and reuses user-edited frames regardless of version", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cube-pet-"));
  const dir = join(scratch, "cache", "tui-pet", "cube");
  try {
    const first = await ensurePetFrames(dir);
    assert.ok(first);
    assert.deepEqual(Object.keys(first), ["idle", "prompting", "working", "thinking", "responding", "waiting"]);
    assert.ok((await readdir(dir)).includes("manifest.json"));
    for (const animation of Object.values(first)) {
      assert.ok(animation.fps > 0 && animation.frames.length > 0);
      assert.ok(animation.frames.every(frame => frame.startsWith('\x1bP9;1;0q"1;1;50;50') && frame.endsWith("\x1b\\")));
    }
    const path = join(dir, "manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.version = "user-edited";
    manifest.states.idle.fps = 2;
    const framePath = join(dir, manifest.states.idle.frames[0]);
    const frame = '\x1bP9;1;0q"1;1;50;50#0;2;100;0;0#0!50~-\x1b\\';
    await writeFile(framePath, frame, "latin1");
    await writeFile(path, JSON.stringify(manifest));
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(framePath, old, old);
    const cached = await ensurePetFrames(dir);
    assert.ok(cached);
    assert.equal(cached.idle.fps, 2);
    assert.equal(cached.idle.frames[0], frame);
    assert.equal(await readFile(path, "utf8"), JSON.stringify(manifest));
    assert.equal((await stat(framePath)).mtimeMs, old.getTime());
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("bad or incomplete pet cache is optional and never overwritten", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cube-pet-"));
  try {
    await ensurePetFrames(scratch);
    const path = join(scratch, "manifest.json");
    await writeFile(path, "not json");
    assert.equal(await ensurePetFrames(scratch), null);
    assert.equal(await readFile(path, "utf8"), "not json");
    await writeFile(path, JSON.stringify({ states: { idle: { fps: 6, frames: ["../outside.six"] } } }));
    assert.equal(await ensurePetFrames(scratch), null);
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("unwritable pet directory cannot block startup", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cube-pet-"));
  try {
    const blocked = join(scratch, "file-not-directory");
    await writeFile(blocked, "keep");
    assert.equal(await ensurePetFrames(join(blocked, "cube")), null);
    assert.equal(await readFile(blocked, "utf8"), "keep");
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
