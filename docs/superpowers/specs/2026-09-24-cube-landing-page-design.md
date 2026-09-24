# Cube CLI Landing Page — Design Specification

**Date:** 2026-09-24  
**Status:** Approved  
**Target Repository:** `D:\cube-landing`  
**Target Audience:** Software developers, DevOps engineers, and AI engineers seeking a fast, autonomous coding agent in their terminal.

---

## 1. Executive Summary

This document specifies the technical design, user experience, visual theme, and component architecture for the official landing page of **Cube CLI** — an autonomous agentic AI coding assistant built for the terminal.

The landing page showcases Cube's modern terminal user interface (differential rendering), multi-gateway model support (OAuth, API Keys, Local inference), atomic code operations, and frictionless Windows x64 one-liner installation.

---

## 2. Technical Stack

- **Framework:** Next.js 15 (App Router, React 19, TypeScript)
- **Styling:** Tailwind CSS v4 + Custom Cyberpunk / Terminal Dark theme utilities
- **Icons:** `lucide-react`
- **Animation:** `framer-motion` (for scroll-triggered animations and fluid layout transitions)
- **Deployment & Distribution Target:** Static export / Node.js web server, standalone build
- **Package Manager:** `pnpm`

---

## 3. Visual Design System

### 3.1 Color Palette
- **Backgrounds:**
  - Base: `#08090C` (Obsidian Deep)
  - Surface / Cards: `#0F1117` (Charcoal Slate) with `border border-white/[0.08]`
  - Hover Surface: `#161922` with subtle cyan glow (`0 0 20px rgba(0, 240, 255, 0.1)`)
  - Floating Nav: `backdrop-blur-md bg-[#08090C]/80 border-b border-white/[0.06]`
- **Neon Accents & Semantics:**
  - Primary / Terminal Cyan: `#00F0FF` (CTA buttons, active links, typing cursors)
  - Success / Emerald: `#10B981` (Copy success, verified checkmarks, status indicators)
  - Reasoning / Amber: `#F59E0B` (AI thinking blocks, model latency, warnings)
  - Gateway / Violet: `#A855F7` (OAuth badges, model routing highlights)
  - Text Primary: `#F3F4F6` (Gray 100)
  - Text Secondary: `#9CA3AF` (Gray 400)
  - Text Muted: `#6B7280` (Gray 500)

### 3.2 Typography
- **Headings & Body:** Modern clean sans-serif (`Geist Sans` or `Inter`) with tight tracking on headings.
- **Code & Terminal:** Monospaced font (`JetBrains Mono` or `Geist Mono`) for commands, logs, and simulator text.

### 3.3 Textures & Visual Flair
- Subtle radial dot-grid background: `bg-[radial-gradient(#1e293b_1px,transparent_1px)] [background-size:24px_24px]`
- High-contrast glowing borders on hover with smooth transition.
- macOS/Linux/Windows hybrid terminal window frame with red/yellow/green indicator dots.

---

## 4. Page Architecture & Section Breakdown

### 4.1 Header / Navigation Bar (`Navbar`)
- **Left:** Cube Logo (Geometric 3D cube neon glyph + bold "CUBE" typography) + version badge (`v1.0.0`).
- **Center:** Smooth-scroll anchor links: `Features`, `Gateways`, `Commands`, `FAQ`.
- **Right:**
  - GitHub link (with star counter placeholder).
  - Quick "Install" CTA button (scrolls to install widget or copies command).

### 4.2 Hero Section (`Hero` + `InstallBox`)
- **Announcement Badge:**
  `🚀 Cube v1.0.0 is live • Zero Data Retention • Native Windows x64 Distribution`
- **Main Headline:**
  `The Autonomous Coding Agent Built for Your Terminal.`
- **Subheadline:**
  *Differential-rendering TUI, multi-gateway model routing (Claude, Grok, Gemini, OpenAI, Ollama), local SQLite memory, and atomic workspace mutations — engineered for pure developer speed.*
- **One-Liner Install Widget (`InstallBox`):**
  - Styled terminal input displaying the PowerShell one-liner:
    ```powershell
    irm https://pub-3313f2900e0948b5849dc47c989406ab.r2.dev/install.ps1 | iex
    ```
  - **One-click Copy Button:**
    - Copies command to clipboard via `navigator.clipboard.writeText`.
    - Triggers visual feedback: green checkmark icon, "Copied to clipboard!" label, and emerald pulse animation.
  - Sub-caption: `Windows x64 Native • Zero dependencies required • Installs in ~2 seconds`.

### 4.3 Animated Terminal Simulator (`TerminalSimulator`)
- **Behavior:**
  - **No play/pause buttons.** Driven entirely by **Intersection Observer** (`framer-motion` `useInView`).
  - Automatically begins typing and streaming when scrolled into view.
  - Automatically resets and replays from the beginning when the user scrolls away and returns.
- **Header:**
  - Window dots (`● ● ●`).
  - Title: `cube — ~/my-project`.
  - Live status indicator: `● Connected (Grok 4.7)`.
- **Scenario Tabs (Manual toggle available):**
  1. **Fix Upstream Bug:**
     - Prompt: `Fix the upstream gateway timeout in oauth.service.ts`
     - Step 1: Amber Thinking block (`Thinking (Reasoning for 2.4s)`).
     - Step 2: Tool call `read_file` inspection.
     - Step 3: Tool call `edit_file` with colored diff additions/deletions.
     - Step 4: Verification `✔ Patched successfully in 1.4s`.
  2. **Model Gateway Selection:**
     - Prompt: `/gateway`
     - Step 1: Terminal renders interactive selection menu (`OAuth`, `API Key`, `Local Ollama`).
     - Step 2: Selects `OAuth/xAI Grok`.
     - Step 3: Seamlessly authenticated and ready.
  3. **Context Discovery (`AGENTS.md`):**
     - Prompt: `What are the testing conventions for this repo?`
     - Step 1: Discovers and reads `.agents/AGENTS.md` automatically.
     - Step 2: Returns exact project-specific testing commands.

### 4.4 Benefit-Driven Features Bento Grid (`FeaturesGrid`)
Six high-impact developer cards:
1. **Flicker-Free Terminal Experience:** Modern console UI powered by differential rendering. Zero screen tearing, instant keyboard navigation, and rich Markdown.
2. **Bring Your Own AI (Save Costs):** Sign in directly with existing Claude, ChatGPT, or Grok subscriptions via OAuth — no expensive per-token API markups.
3. **Autonomous Task Execution:** Understands full codebases, reasons through multi-step refactors, executes tests, and edits code with full human approval controls.
4. **Instant Codebase Context:** Discovers project rules and conventions (`AGENTS.md`) across your directory tree automatically without prompt gymnastics.
5. **Safe & Reversible Edits:** Every file mutation provides colored diff previews and atomic writes, ensuring your project code never gets corrupted.
6. **100% Local & Privacy-First:** Credentials and chat history reside exclusively on your machine (`~/.cube`). Direct connection to model providers with zero middleman proxies.

### 4.5 Multi-Gateway Ecosystem Showcase (`GatewaySection`)
Three interactive tabs with feature breakdowns:
- **OAuth Tier:** Claude Code, ChatGPT Codex, Grok CLI, Google Antigravity. Browser-based PKCE authentication.
- **Direct API Key Tier:** 15+ providers (OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, Groq, Mistral, Moonshot, Alibaba).
- **100% Offline Local Tier:** Zero network traffic with Ollama & LM Studio.

### 4.6 Slash Command Palette (`CommandPalette`)
Interactive explorer highlighting key terminal commands:
- `/gateway` — Switch model providers and authentication methods.
- `/model` & `/effort` — Select active model and tune thinking token budgets.
- `/status` — Live inspection of context window usage and subscription rate limits.
- `/resume` & `/fork` — Navigate and branch conversation threads.
- `/theme` — On-the-fly terminal syntax highlighting customizer.

### 4.7 FAQ Accordion (`FaqSection`)
Smooth expandable accordions covering:
- Supported platforms (Windows x64 native, WSL/Linux roadmap).
- API key vs OAuth subscription flexibility.
- Data privacy & Zero Data Retention guarantee.
- How updates work (2-second safe upgrade without data loss).

### 4.8 Final CTA & Footer (`Footer`)
- Final "Ready to upgrade your terminal workflow?" banner with secondary copy-to-install box.
- Links: GitHub repository, Documentation, Release notes, MIT License, Socials.

---

## 5. File Structure in `D:\cube-landing`

```text
D:\cube-landing\
├── public/
│   ├── favicon.ico
│   └── og-image.png
├── src/
│   ├── app/
│   │   ├── globals.css         # Tailwind directives & cyberpunk themes
│   │   ├── layout.tsx          # Root layout with fonts & metadata
│   │   └── page.tsx            # Main assembled page
│   ├── components/
│   │   ├── layout/
│   │   │   ├── navbar.tsx      # Top sticky header
│   │   │   └── footer.tsx      # Bottom footer
│   │   ├── hero/
│   │   │   ├── hero.tsx        # Hero headline & callout
│   │   │   └── install-box.tsx # One-click copy install widget
│   │   ├── terminal/
│   │   │   ├── terminal-simulator.tsx # In-view auto-play terminal engine
│   │   │   └── scenarios.ts    # Scripted interactive demo data
│   │   ├── features/
│   │   │   └── features-grid.tsx # 6 benefit cards
│   │   ├── gateways/
│   │   │   └── gateway-section.tsx # OAuth vs API vs Local
│   │   ├── commands/
│   │   │   └── command-palette.tsx # Interactive slash commands
│   │   └── faq/
│   │       └── faq-accordion.tsx # Expandable Q&A
│   ├── lib/
│   │   └── utils.ts            # ClassName merging helpers (clsx, twMerge)
├── package.json
├── tsconfig.json
└── tailwind.config.ts
```

---

## 6. Verification & Quality Gates

1. **Build Verification:** Run `pnpm build` in `D:\cube-landing` to ensure zero TypeScript errors and successful production compilation.
2. **Animation Verification:** Validate that `TerminalSimulator` plays cleanly on scroll into viewport and resets when scrolled away.
3. **Clipboard Verification:** Confirm the copy button successfully writes the PowerShell one-liner into system clipboard with visual confirmation.
4. **Mobile Responsiveness:** Ensure all grids, terminal windows, and tables collapse gracefully on mobile viewports (`< 768px`).
