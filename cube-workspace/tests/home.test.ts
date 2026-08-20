import assert from "node:assert/strict";
import test from "node:test";
import { Home, CubeHome, createBootstrap, ConfigStore, SoulStore } from "../src/index.js";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const createTestHome = async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cube-home-test-"));
  const home = new Home({ cubeHome: tmp });
  await home.ensure();
  return { home, tmp };
};

test("Home resolves correct directory paths", async () => {
  const { home, tmp } = await createTestHome();
  try {
    assert.equal(home.getRoot(), path.resolve(tmp));
    assert.equal(home.getMemoryDir(), path.join(path.resolve(tmp), "memories"));
    assert.equal(home.getLogDir(), path.join(path.resolve(tmp), "logs"));
    assert.equal(home.getConfigPath(), path.join(path.resolve(tmp), "config.yaml"));
    assert.equal(home.getSoulPath(), path.join(path.resolve(tmp), "SOUL.md"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("Bootstrap seeds all template files into new home", async () => {
  const { home, tmp } = await createTestHome();
  try {
    const bootstrap = createBootstrap(home);
    await bootstrap.run();

    assert.ok(existsSync(home.getConfigPath()));
    assert.ok(existsSync(home.getSoulPath()));
    assert.ok(existsSync(home.getAuthPath()));
    assert.ok(existsSync(home.getMcpPath()));
    assert.ok(existsSync(home.getWorkspacePath()));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("ConfigStore and SoulStore can read seeded config", async () => {
  const { home, tmp } = await createTestHome();
  try {
    await createBootstrap(home).run();

    const config = await ConfigStore(home).read();
    assert.equal(config.version, 1);
    assert.ok(config.model);

    const soul = await SoulStore(home).read();
    assert.ok(soul.length > 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
