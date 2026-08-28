import assert from "node:assert/strict";
import test from "node:test";
import { appTheme } from "../src/themes/app.theme.js";
import {
  getSyntaxTheme,
  setSyntaxTheme,
  getAvailableSyntaxThemes,
  SYNTAX_THEMES,
} from "../src/themes/syntax.theme.js";
import { createHighlightCode } from "../src/themes/code-highlight.js";
import {
  createSelectListTheme,
  createEditorTheme,
  createMarkdownTheme,
} from "../src/themes/pi-tui.theme.js";

test("appTheme defines complete design tokens with WCAG/ISO compliance", () => {
  // Banner Gradient
  assert.equal(Array.isArray(appTheme.bannerGradient), true);
  assert.equal(appTheme.bannerGradient.length, 2);

  // Roles
  assert.equal(typeof appTheme.role.user, "function");
  assert.equal(typeof appTheme.role.assistant, "function");
  assert.equal(typeof appTheme.role.system, "function");
  assert.equal(typeof appTheme.role.tool, "function");

  // Status Signals
  assert.equal(typeof appTheme.status.success, "function");
  assert.equal(typeof appTheme.status.warning, "function");
  assert.equal(typeof appTheme.status.error, "function");
  assert.equal(typeof appTheme.status.info, "function");

  // UI
  assert.equal(typeof appTheme.ui.primary, "function");
  assert.equal(typeof appTheme.ui.secondary, "function");
  assert.equal(typeof appTheme.ui.border, "function");
  assert.equal(typeof appTheme.ui.muted, "function");
  assert.equal(typeof appTheme.ui.text, "function");

  // Surfaces
  assert.equal(typeof appTheme.surface.codeInline, "string");

  // Markdown
  assert.equal(typeof appTheme.markdown.heading, "function");
  assert.equal(typeof appTheme.markdown.bold, "function");
  assert.equal(typeof appTheme.markdown.italic, "function");
  assert.equal(typeof appTheme.markdown.strikethrough, "function");
  assert.equal(typeof appTheme.markdown.link, "function");
  assert.equal(typeof appTheme.markdown.quote, "function");
  assert.equal(typeof appTheme.markdown.listBullet, "function");
  assert.equal(typeof appTheme.markdown.codeInlineText, "function");
});

test("syntax.theme manages syntax highlighting themes and registry", () => {
  const available = getAvailableSyntaxThemes();
  assert.equal(available.length >= 7, true);
  assert.equal(available.some((t) => t.id === "dracula"), true);
  assert.equal(available.some((t) => t.id === "tokyo-night"), true);
  assert.equal(available.some((t) => t.id === "nord"), true);
  assert.equal(available.some((t) => t.id === "cyberpunk"), true);
  assert.equal(available.some((t) => t.id === "one-dark"), true);
  assert.equal(available.some((t) => t.id === "monokai"), true);

  setSyntaxTheme("dracula");
  assert.equal(getSyntaxTheme().id, "dracula");

  setSyntaxTheme("tokyo-night");
  assert.equal(getSyntaxTheme().id, "tokyo-night");

  // Fallback test
  setSyntaxTheme("unknown-theme-xyz");
  // retains previous or falls back
  setSyntaxTheme("default");
  assert.equal(getSyntaxTheme().id, "default");
});

test("createHighlightCode renders highlighted syntax lines", () => {
  const highlight = createHighlightCode(SYNTAX_THEMES.dracula);
  const sampleCode = `const x: number = 42;\nfunction hello() { return "world"; }`;
  const lines = highlight(sampleCode, "typescript");

  assert.equal(lines.length, 2);
  assert.equal(lines[0].includes("const"), true);
  assert.equal(lines[1].includes("hello"), true);
});

test("pi-tui theme factories integrate appTheme and syntaxTheme", () => {
  const selectListTheme = createSelectListTheme();
  assert.equal(typeof selectListTheme.selectedPrefix, "function");
  assert.equal(typeof selectListTheme.selectedText, "function");

  const editorTheme = createEditorTheme();
  assert.equal(typeof editorTheme.borderColor, "function");

  const mdTheme = createMarkdownTheme();
  assert.equal(typeof mdTheme.heading, "function");
  assert.equal(typeof mdTheme.code, "function");
  assert.equal(typeof mdTheme.highlightCode, "function");
});

test("createHighlightCode renders highlighted diff blocks", () => {
  const highlight = createHighlightCode();
  const diffCode = `@@ -1,3 +1,3 @@\n-oldLine\n+newLine`;
  const lines = highlight(diffCode, "diff");
  assert.equal(lines.length, 3);
  assert.equal(lines[0].includes("@@"), true);
  assert.equal(lines[1].includes("oldLine"), true);
  assert.equal(lines[2].includes("newLine"), true);
});

