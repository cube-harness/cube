Analyze this codebase and create (or update) an AGENTS.md file at the
project root, covering:

1. Build/lint/test commands — especially how to run a SINGLE test
   (not just the full suite)
2. Code style conventions: import order, formatting, types, naming
   conventions, error handling
3. Monorepo/package structure if applicable (what each package does,
   dependency direction between them)
4. Any non-obvious setup quirks or gotchas (e.g. commands that must
   run before building, required environment variables)

Constraints:
- Keep it to roughly 20-30 lines. This file is meant for YOU (the
  agent) to read in future sessions, not a human-facing README —
  prioritize information density over prose.
- If the repo has Cursor rules (.cursor/rules/ or .cursorrules) or
  Copilot rules (.github/copilot-instructions.md), read them and
  fold in anything relevant.
- If AGENTS.md already exists in the current directory: READ it
  first, then improve/update it in place — don't overwrite wholesale,
  don't remove information that's still accurate.
- ONLY use information found in this repo itself (source code, config
  files, package.json/Cargo.toml/pyproject.toml, etc.). Do NOT read or
  pull content from any global config files outside the project
  directory (e.g. ~/.cube/, ~/.config/...), even if you have access —
  those may contain personal information and should never end up
  committed to the repo.
- If the current directory is a sub-package in a monorepo, create/
  update that package's AGENTS.md, not the root one.