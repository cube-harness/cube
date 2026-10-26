# Skills

Load reusable workflows explicitly and control which skills the model can see.

<a id="sources"></a>

## Skill Sources

A skill is a directory containing SKILL.md with YAML frontmatter and Markdown instructions. `<workspace>` means the directory where Cube was started; `~` means your OS user home. Cube reads these sources:

- **Project:** `<workspace>/.agents/skills/<name>/SKILL.md`, `<workspace>/.cube/skills/<name>/SKILL.md`, `<workspace>/.claude/skills/<name>/SKILL.md` and `<workspace>/.codex/skills/<name>/SKILL.md`. These skills belong to that workspace, not every project on your machine.
- **Global:** `~/.cube/skills/<name>/SKILL.md` and `~/.agents/skills/<name>/SKILL.md`. These are available across workspaces.
- **Built-in:** Cube's packaged application assets, including skill-creator, cube-background, cube-delegation and cube-memory. This is not a destination for your own skill files.

In the current implementation, an enabled global skill wins over a same-named project skill during activation. Enabled user skills shadow built-ins. Do not assume project-over-global precedence; use distinct names or disable the unwanted source in /skills. Multiple distinct same-named skills within one level can be ambiguous to the native loader rather than resolved by folder order. /skills shows source/path information. Invalid YAML or metadata makes the affected skill unavailable; check logs and the file.

<a id="activation"></a>

## Activate with $

Use $skill-name in a prompt, with autocomplete, to explicitly activate a skill. Cube keeps your visible prompt readable and loads the selected SKILL.md instructions into model context. It does not replace your typed mention with the whole file in the message list.

Activated main instructions are already loaded; the model should use skill_read for related references, scripts, assets, templates or other files within that skill. The skill tool loads another related skill whose instructions are not yet in context. Skill search can locate relevant skill resources. /skill-name is not an application command.

**Prompt**

```text
Use $skill-creator to create a project skill for our test workflow.
```

<a id="enable-disable"></a>

## Enable & Disable

Run /skills, search for a skill, use Space to stage a toggle and Enter to apply all staged changes. Disabled skills disappear from both $ autocomplete and the model's available_skills catalog; they are not merely hidden from the picker.

The picker stores canonical SKILL.md paths or builtin:`<name>` keys in skills.disabled. Applying changes affects subsequent turns without restarting. It can change the prompt/tool prefix and reduce provider prompt-cache reuse; this is an intentional tradeoff.

Skill checks use native discovery with a refresh cooldown, not an immediate filesystem watcher. Newly added skills inside registered source directories can appear on a later catalog check; content edits are read on later activation snapshots, not retroactively applied to completed requests. If you create a project source directory that did not exist when Cube started, restart Cube so it is registered. /reload does not rebuild the project's skill-source directory list.

**config.yaml · prefer /skills to avoid path mistakes**

```yaml
skills:
  disabled:
    - builtin:cube-delegation
    - 'D:\Projects\my-app\.agents\skills\example\SKILL.md'
```

<a id="creating"></a>

## Creating Skills

Cube includes skill-creator, cube-background, cube-delegation and cube-memory. Activate skill-creator for the authoring workflow, validation and supporting assets instead of copying an unrelated agent's skill format blindly.

Choose the scope before writing. skill-creator defaults to a project skill at `<workspace>/.agents/skills/<name>/SKILL.md`; request global scope explicitly to use `~/.cube/skills/<name>/SKILL.md` or `~/.agents/skills/<name>/SKILL.md`. The other supported project locations above use the same format. When updating an existing skill, preserve its supported location unless you ask to move it. A global destination does not bypass workspace_only or tool approvals; see [permissions](/docs/tools-permissions#policy).

The skill directory name must match the frontmatter name. name and description are required. Optional native metadata includes license, compatibility, metadata and user-invocable. user-invocable: false hides $ autocomplete but does not disable model access; use /skills to disable a skill. Additional metadata does not grant tools or override permissions.

Keep the main instructions focused and place related references, scripts, assets, templates or other resources in files read only when needed. These folders are optional. Cube does not consume agents/openai.yaml, agents/cube.yaml or agents/*.md inside a skill; a skill does not require creating a subagent. Configure custom subagents in their separate [role directories](/docs/subagents#custom-agents).

**Project example: `<workspace>/.agents/skills/project-tests/SKILL.md` — project-tests is an example name, not a required location/name**

```markdown
---
name: project-tests
description: Run the project's tests and report actual failures when the user requests verification.
---

# Project Tests
Read package.json to find the test command. Run it with execute_command,
respect approvals, and report the actual exit code and failures.
Use references/testing.md only when more project-specific detail is needed.
```

<a id="related-config"></a>

## config.yaml Reference

Settings related to this guide. Merge examples into your existing file; omitted settings use Cube defaults. See [applying changes](/docs/configuration#defaults).

| Field | Type / range | Default | Behavior |
| --- | --- | --- | --- |
| `skills.disabled` | Non-empty string[] | `[]` | Disabled SKILL.md paths, or builtin:`<name>` for a built-in skill. /skills writes canonical identifiers; a bare skill name is not a replacement for its path. |
