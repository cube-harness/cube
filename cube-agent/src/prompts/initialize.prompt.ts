export const INITIALIZE_PROMPT = `Please analyze this codebase and create or update AGENTS.md at the workspace root to guide future coding agents.

Before writing, inspect the actual project structure, build/config files and relevant source code.
If AGENTS.md already exists, preserve correct guidance and improve it rather than blindly overwriting it.
Read applicable README.md, .cursor/rules/, .cursorrules and .github/copilot-instructions.md when present; avoid duplicating existing guidance.

Include only verified, project-specific facts:
- Project structure, important modules and their responsibilities.
- Build, development, lint, typecheck and test commands, including running a single test where supported.
- Code style, naming conventions and architecture that is not obvious from a file listing.
- Commit/PR conventions when evidenced by repository history or documentation.

Keep it concise: aim for 200–400 words. Omit unsupported sections and generic advice.
Do not assume any language, framework, package names or monorepo structure. Do not invent commands or claim verification you did not perform.
Use the available file tools and follow the existing approval policy. Do not modify unrelated files.
Start with # AGENTS.md and a brief statement that the file guides coding agents working in this repository.
After writing, briefly report the path and what changed.`;
