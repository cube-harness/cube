Please analyze this codebase and create (or update) an AGENTS.md file that will be given to future instances of you when working in this repository.

    Before writing:
    - If AGENTS.md already exists, treat this as an improvement pass — merge in anything missing, don't blindly overwrite what's already correct.
    - Check for and fold in the important parts of any existing .cursor/rules/, .cursorrules, .github/copilot-instructions.md, or README.md — don't duplicate them elsewhere in the file.

    What to include:
    1. Project Structure — where source, tests, and packages live (this is a monorepo: cube-agent, cube-cli, cube-tui, cube-workspace — note what each package owns and how they depend on each other).
    2. Build/Test/Dev Commands — how to build, lint, typecheck, and run tests, especially how to run a single test file/case. Briefly note what each command does.
    3. Code Style & Naming Conventions — import style, formatting/linting tools in use, naming patterns, error-handling conventions.
    4. Architecture Overview — the big-picture design that requires reading multiple files to understand (e.g. Mastra framework usage, AgentController/Session lifecycle, tool system, workspace config
    model). Focus on what would take a new contributor a while to piece together on their own.
    5. Commit & PR Guidelines — conventions found in git history; PR requirements if any.
    6. (Optional) Security/Config Tips or Agent-Specific Instructions, only if something genuinely repo-specific applies.

    Constraints:
    - Keep it concise — aim for 200–400 words, roughly 20-40 lines. Don't pad.
    - Don't include generic advice ("write unit tests", "don't commit secrets", "handle errors gracefully") — only repo-specific facts.
    - Don't enumerate every file or component; only structure that isn't obvious from `ls`.
    - Don't invent sections like "Common Development Tasks" or "Tips" unless the info is actually drawn from files you read.
    - Use clear Markdown headings. Professional, instructional tone — this is a reference doc, not a tutorial.
    - Prefix the file with:

    # AGENTS.md

    This file provides guidance to AI coding agents when working with code in this repository.