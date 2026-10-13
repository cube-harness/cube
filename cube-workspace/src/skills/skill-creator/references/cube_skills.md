# Cube skill format and invocation

Read this reference when choosing a skill's destination, frontmatter or invocation
behavior. Resource directories are optional; the entrypoint is SKILL.md.

## Locations

- Default project location: `<workspace>/.agents/skills/<name>/SKILL.md`.
- Global only when requested: `~/.cube/skills/<name>/SKILL.md` or
  `~/.agents/skills/<name>/SKILL.md`.
- Preserve an existing supported location when updating a skill.
- Built-in application assets are not a user authoring destination.

Outside-workspace writes may be denied by Cube permissions. A requested global
destination does not grant permission to bypass that denial using a command.

## Frontmatter

```yaml
---
name: sql-review
description: "Use when reviewing SQL queries for correctness or performance."
license: MIT
compatibility: "Requires a connected database only for execution-plan checks."
metadata:
  author: Example Team
user-invocable: true
---
```

`name` and `description` are required strings. Names are 1–64 characters:
lowercase letters, digits and hyphens, no leading/trailing hyphen or consecutive
hyphens. The directory name must match. Descriptions are nonblank and at most
1024 characters. Put detailed workflows in the body, not the discovery text.

Optional fields include `license`, `compatibility`, `metadata` and
`user-invocable`. Quote YAML strings with sensitive punctuation. Preserve existing
metadata when updating; don't add fields simply to fill a template. Additional
frontmatter does not automatically grant features: for example, `allowed-tools`
does not override Cube permissions or provide missing tools.

Cube's native Mastra loader is authoritative for runtime structural acceptance.
The bundled quick checker also catches unfinished scaffold and resource errors;
neither proves behavior on real model requests.

## Invocation and availability

- Native `skill` loads a relevant skill's main instructions.
- Explicit `$name` activates the skill using Cube's existing signal mechanism;
  do not load that same main file a second time.
- `skill_read` reads related files relative to the skill root. References,
  scripts, assets, templates and other resource layouts can be used when needed.
- `skill_search` can search available skill content for relevant details.
- `/skills` changes enable/disable state, persisted in `config.yaml`. Disabled
  skills are not available for new native activation or `$` completion; previous
  activation history is not erased.
- `user-invocable: false` hides user completion; it does not disable native model
  access or create an explicit-only mode.

Changing availability affects subsequent request snapshots, not the active
request. Newly written files still need to become visible to native discovery:
don't promise a reload timing or successful activation you have not observed.
SOUL, AGENTS and memory snapshots have their own thread/reload boundaries.

## Resources and other harnesses

Link conditional references where they become useful; don't load every resource
at activation. A skill can include reusable scripts or output templates without
needing any subagent definition.

Cube does not consume `agents/openai.yaml`, `agents/cube.yaml` or Markdown
agent definitions inside a skill. Preserve such files in a cross-harness user
skill unless removal is requested. They are not part of a new Cube-only scaffold.
For an existing/requested Codex metadata file, read `openai_yaml.md` separately.
