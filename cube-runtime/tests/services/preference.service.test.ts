import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore, Store, createBootstrap, HomeManager as Home, WorkspaceManager } from "@cube/workspace";
import { createCubeSkills } from "../../../cube-agent/src/skills.js";
import { PreferenceService } from "../../src/services/preference.service.js";

test("builtin toggles survive versioned installation paths and preserve unrelated disabled entries", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cube-builtin-preference-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = new Home({ cubeHome: path.join(directory, "home"), userHome: directory });
  await createBootstrap(home).run();
  const workspace = new WorkspaceManager(home, directory);
  const installations = ["0.1.8", "0.1.9"].map(version => path.join(directory, version, "skills"));
  for (const assets of installations) {
    const dir = path.join(assets, "cube-background");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), "---\nname: cube-background\ndescription: Background commands\n---\nInstructions");
  }
  const unrelated = path.join(directory, "unavailable", "SKILL.md");
  await ConfigStore(home).update(config => ({ ...config, skills: { disabled: [unrelated] } }));
  const first = await createCubeSkills(home, workspace, [unrelated], { builtinPath: installations[0] });
  const service = new PreferenceService(home, { theme: "default", appTitle: [], statusLine: [] }, first);
  const choice = (await first.list())[0]!;
  await service.setSkillsEnabled([{ path: choice.path, enabled: false }]);
  const saved = await ConfigStore(home).read();
  assert.deepEqual(saved.skills.disabled, [unrelated, "builtin:cube-background"]);
  const second = await createCubeSkills(home, workspace, saved.skills.disabled, { builtinPath: installations[1] });
  const updated = (await second.list())[0]!;
  assert.notEqual(updated.path, choice.path);
  assert.equal(updated.enabled, false);
  const reopened = new PreferenceService(home, { theme: "default", appTitle: [], statusLine: [] }, second);
  await reopened.setSkillsEnabled([{ path: updated.path, enabled: true }]);
  assert.deepEqual((await ConfigStore(home).read()).skills.disabled, [unrelated]);
  assert.equal((await second.list())[0]!.enabled, true);
  const fail = t.mock.method(Store.prototype, "write", async () => { throw new Error("disk full"); });
  await assert.rejects(reopened.setSkillsEnabled([{ path: updated.path, enabled: false }]), /disk full/);
  assert.equal((await second.list())[0]!.enabled, true);
  fail.mock.restore();
});

test("skill toggles persist serially and a failed write keeps catalog availability unchanged", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cube-skill-preference-"));
  const home = new Home({ cubeHome: directory, userHome: directory });
  try {
    await createBootstrap(home).run();
    for (const name of ["review", "build"]) {
      const skill = path.join(home.getSkillDir(), name);
      await mkdir(skill, { recursive: true });
      await writeFile(path.join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill\n---\nInstructions`);
    }
    const skills = await createCubeSkills(home, new WorkspaceManager(home, directory), [], { builtinPath: path.join(directory, "empty-builtins") });
    const service = new PreferenceService(home, { theme: "default", appTitle: ["model"], statusLine: ["model"] }, skills);
    const choices = await service.listSkills();
    const diskWrite = t.mock.method(Store.prototype, "write");
    const setDisabled = t.mock.method(skills, "setDisabled");
    await service.setSkillsEnabled(choices.map(({ path }) => ({ path, enabled: false })));
    assert.equal(diskWrite.mock.callCount(), 1);
    assert.equal(setDisabled.mock.callCount(), 1);
    diskWrite.mock.restore();
    setDisabled.mock.restore();
    const saved = await ConfigStore(home).read();
    assert.equal(saved.skills.disabled.length, 2);
    assert.equal(saved.theme, "default");
    const reopened = await createCubeSkills(home, new WorkspaceManager(home, directory), saved.skills.disabled, { builtinPath: path.join(directory, "empty-builtins") });
    assert.ok((await reopened.list()).every((skill) => !skill.enabled));
    const write = t.mock.method(Store.prototype, "write", async () => { throw new Error("disk write failed"); });
    await assert.rejects(service.setSkillsEnabled([{ path: choices[0]!.path, enabled: true }]), /disk write failed/);
    assert.ok((await service.listSkills()).every((skill) => !skill.enabled));
    write.mock.restore();
    await service.setSkillsEnabled([{ path: choices[0]!.path, enabled: true }]);
    assert.equal((await service.listSkills()).filter((skill) => skill.enabled).length, 1);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("PreferenceService persists each owned field and returns defensive array copies", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cube-preference-service-"));
  const home = new Home({ cubeHome: directory });
  await createBootstrap(home).run();
  const initialTitle = ["model", "workspace"];
  const initialStatusLine = ["model", "threadId"];
  const service = new PreferenceService(home, {
    theme: "default",
    appTitle: initialTitle,
    statusLine: initialStatusLine,
  });

  try {
    initialTitle.push("mutated-outside");
    initialStatusLine.push("mutated-outside");
    assert.deepEqual(service.get(), {
      theme: "default",
      appTitle: ["model", "workspace"],
      statusLine: ["model", "threadId"],
    });

    const title = ["model", "threadId"];
    const statusLine = ["workspace", "agentMd"];
    await service.setTheme("dracula");
    await service.setTitle(title);
    await service.setStatusLine(statusLine);
    title.push("mutated-after-set");
    statusLine.push("mutated-after-set");

    const first = service.get();
    first.appTitle.push("mutated-return");
    first.statusLine.push("mutated-return");
    assert.deepEqual(service.get(), {
      theme: "dracula",
      appTitle: ["model", "threadId"],
      statusLine: ["workspace", "agentMd"],
    });

    const config = await ConfigStore(home).read();
    assert.equal(config.theme, "dracula");
    assert.deepEqual(config.app_title, ["model", "threadId"]);
    assert.deepEqual(config.status_line, ["workspace", "agentMd"]);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
