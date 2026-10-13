import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinSkillsPath } from "@cube/workspace";
import { resolveAgentSkills } from "@mastra/core/skills";

const exec = promisify(execFile);

test("creator helpers initialize without metadata/overwrites and validate resources with native-compatible fields", async t => {
  const root = await mkdtemp(join(tmpdir(), "cube-creator-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = await getBuiltinSkillsPath();
  const init = join(assets, "skill-creator", "scripts", "init_skill.mjs");
  const validate = join(assets, "skill-creator", "scripts", "quick_validate.mjs");
  const run = (script: string, ...args: string[]) => exec(process.execPath, [script, ...args], { cwd: root, windowsHide: true });
  await run(init, "My Review", "--path", ".agents/skills", "--resources", "references,scripts,assets", "--examples");
  const directory = join(root, ".agents", "skills", "my-review");
  assert.deepEqual((await readdir(directory)).sort(), ["SKILL.md", "assets", "references", "scripts"]);
  const scaffold = await readFile(join(directory, "SKILL.md"), "utf8");
  await assert.rejects(run(validate, directory), /unfinished TODO/);
  await assert.rejects(run(init, "my-review", "--path", ".agents/skills"), /EEXIST/);
  assert.equal(await readFile(join(directory, "SKILL.md"), "utf8"), scaffold);
  await assert.rejects(run(init, "bad", "--path", "unused", "--resources", "unknown"), /Unknown resource/);
  await assert.rejects(run(init, "bad", "--path", "../outside"), /outside the current/);
  const text = '---\r\nname: my-review\r\ndescription: "Use when: reviewing queries"\r\ncompatibility: Cube\r\nmetadata:\r\n  team: example\r\nuser-invocable: false\r\ncustom-field: preserved\r\n---\r\n# Review\r\nRead [schema](references/schema.md) when reviewing queries.\r\n```markdown\r\n[TODO: This is a quoted example, not an unfinished scaffold.]\r\n```\r\n';
  await writeFile(join(directory, "SKILL.md"), text);
  await assert.rejects(run(validate, directory), /Missing relative resource/);
  await writeFile(join(directory, "references", "schema.md"), "# Query schema\nRead-only query examples.\n");
  assert.match((await run(validate, directory)).stdout, /Authoring checks passed/);
  assert.equal((await resolveAgentSkills([join(root, ".agents", "skills")]).list())[0]?.name, "my-review");
  await writeFile(join(directory, "SKILL.md"), text.replace("name: my-review", "name: different"));
  await assert.rejects(run(validate, directory), /directory name/);
  await writeFile(join(directory, "SKILL.md"), text.replace('"Use when: reviewing queries"', "invalid: YAML"));
  await assert.rejects(run(validate, directory), /Nested mappings|YAML|mapping/i);
});
