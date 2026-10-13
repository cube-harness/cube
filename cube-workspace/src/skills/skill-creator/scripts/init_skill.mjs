#!/usr/bin/env node
// Adapted from OpenAI's Codex skill-creator (Apache-2.0) for Node and Cube. See ../license.txt.
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const usage = "node init_skill.mjs <skill-name> --path <directory> [--resources scripts,references,assets] [--examples]";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      path: { type: "string" },
      resources: { type: "string", default: "" },
      examples: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(usage);
  } else {
    if (positionals.length !== 1 || !values.path) throw new Error(usage);
    const rawName = positionals[0];
    const name = rawName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!name || name.length > 64) throw new Error("Skill name must contain letters/digits and be at most 64 characters after normalization.");
    const resources = [...new Set(values.resources.split(",").map(value => value.trim()).filter(Boolean))];
    if (resources.some(value => !["scripts", "references", "assets"].includes(value)))
      throw new Error("Unknown resource type; use scripts,references,assets.");
    if (values.examples && !resources.length) throw new Error("--examples requires --resources.");

    const requested = path.resolve(values.path);
    let ancestor = requested;
    let resolved;
    while (!resolved) {
      try { resolved = await realpath(ancestor); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        ancestor = path.dirname(ancestor);
      }
    }
    const parent = path.resolve(resolved, path.relative(ancestor, requested));
    const relative = path.relative(await realpath(process.cwd()), parent);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("Output path is outside the current working directory. Use authorized file tools for other destinations.");

    const directory = path.join(parent, name);
    const template = await readFile(new URL("../assets/skill-template.md", import.meta.url), "utf8");
    await mkdir(parent, { recursive: true });
    await mkdir(directory); // Existing directories, including symlinks, must never be overwritten.
    const title = name.split("-").map(word => word[0].toUpperCase() + word.slice(1)).join(" ");
    await writeFile(path.join(directory, "SKILL.md"), template.replaceAll("{{skill_name}}", name).replaceAll("{{skill_title}}", title), { flag: "wx" });
    const examples = {
      scripts: ["example.mjs", `// Replace this helper with the reusable operation ${name} needs, or remove it.\nconsole.log("Example helper only; no task was performed.");\n`],
      references: ["api_reference.md", `# Reference for ${title}\n\n[TODO: Add maintained task-specific constraints or schemas; remove if not needed.]\n`],
      assets: ["example_asset.txt", "Replace this placeholder with an output template or asset; remove if not needed.\n"],
    };
    for (const resource of resources) {
      const target = path.join(directory, resource);
      await mkdir(target);
      if (values.examples) {
        const [file, content] = examples[resource];
        await writeFile(path.join(target, file), content, { flag: "wx" });
      }
    }
    if (name !== rawName) console.log(`Normalized skill name: ${rawName} → ${name}`);
    console.log(`Created scaffold: ${directory}\nComplete the TODOs, link needed resources, run quick_validate.mjs and verify native loading. The scaffold is not a finished skill.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
