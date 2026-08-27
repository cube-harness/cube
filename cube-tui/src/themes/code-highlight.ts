import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import bash from "highlight.js/lib/languages/bash";
import sql from "highlight.js/lib/languages/sql";
import csharp from "highlight.js/lib/languages/csharp";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import type { ColorTheme } from "./color.schema.js";

/**
 * Curated language set instead of the full `highlight.js` bundle (~192 langs):
 * this is a CLI, so startup cost matters, and this list is exactly Vy's stack
 * (TS/JS monorepo, Python tooling, JSON/YAML config, Bash scripts, C#/ABP,
 * SQL, XML/HTML, CSS). Add more `registerLanguage` calls here as needed.
 */
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["js", "jsx", "mjs", "cjs"], { languageName: "javascript" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
hljs.registerAliases(["cs", "dotnet"], { languageName: "csharp" });
hljs.registerAliases(["html"], { languageName: "xml" });
hljs.registerAliases(["yml"], { languageName: "yaml" });

/**
 * Token role → theme hue map. Deliberately does NOT touch success/warning/error
 * (SIGNAL tier is reserved for state/alert, per color.schema.ts's own rule that
 * CONTENT must never reuse a SIGNAL hex) and does NOT touch user/system/tool
 * (ACTOR tier) — reusing `tool`'s hue for e.g. function names would visually
 * conflate "the agent just invoked a tool" (the ⚙ tool: indicator elsewhere in
 * this UI) with "this is a function identifier inside a code snippet", a
 * collision specific to a coding-agent UI that a generic editor theme wouldn't
 * have to worry about. Everything below stays inside the existing CONTENT/
 * STRUCTURAL budget (primary, secondary, codeAccent, muted, assistant, border):
 *
 *   primary.bold   — keyword (control flow: const/function/if/return/def...)
 *   secondary      — built_in / type / attr (identifier-ish: type names, object keys)
 *   secondary.bold — title (function/class name being declared)
 *   codeAccent     — string / regexp / subst (literal data — same hue as inline `code`)
 *   codeAccent.bold— number / literal (numeric & true/false/null literals)
 *   muted.italic   — comment (universal convention: de-emphasized + slanted)
 *   muted          — meta (preprocessor/shebang-ish lines)
 *   muted.strikethrough — deletion (diff `-` lines inside a fenced code block)
 *   assistant      — everything else (params, property, variable, plain text)
 *   border         — punctuation (braces/commas/colons — chrome, not content)
 */
const TOKEN_STYLE: Record<string, (t: ColorTheme) => (s: string) => string> = {
  keyword: (t) => t.primary.bold,
  built_in: (t) => t.secondary,
  type: (t) => t.secondary,
  attr: (t) => t.secondary,
  title: (t) => t.secondary.bold,
  string: (t) => t.codeAccent,
  subst: (t) => t.codeAccent,
  regexp: (t) => t.codeAccent,
  symbol: (t) => t.codeAccent,
  number: (t) => t.codeAccent.bold,
  literal: (t) => t.codeAccent.bold,
  comment: (t) => t.muted.italic,
  meta: (t) => t.muted,
  deletion: (t) => t.muted.strikethrough,
  punctuation: (t) => t.border,
  emphasis: (t) => t.assistant.italic,
  strong: (t) => t.assistant.bold,
};

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
};

const decodeEntities = (s: string): string =>
  s.replace(/&amp;|&lt;|&gt;|&quot;|&#x27;|&#39;/g, (m) => ENTITIES[m]);

/**
 * highlight.js's own HTML output is well-formed by construction (it only ever
 * emits <span class="..."> / </span> around escaped text, never arbitrary
 * markup), so a regex walk is safe here — this is not a general HTML parser.
 * Nesting (e.g. `<span class="hljs-string">...<span class="hljs-subst">`
 * for template-literal interpolation) is handled with a class stack; the
 * innermost open span wins for each text run, same as CSS cascading.
 */
function renderHighlightedHtml(html: string, theme: ColorTheme): string {
  const classStack: string[] = [];
  let out = "";

  const spanOrText = /<span class="([^"]+)">|<\/span>|[^<]+/g;
  let match: RegExpExecArray | null;

  while ((match = spanOrText.exec(html))) {
    const token = match[0];
    if (token.startsWith('<span class="')) {
      classStack.push(match[1]);
    } else if (token === "</span>") {
      classStack.pop();
    } else {
      const text = decodeEntities(token);
      const activeClass = classStack[classStack.length - 1];
      const role = activeClass?.split(" ")[0]?.replace(/^hljs-/, "");
      const styler = (role && TOKEN_STYLE[role]) || ((t: ColorTheme) => t.assistant);
      out += styler(theme)(text);
    }
  }
  return out;
}

/**
 * Takes an explicit `ColorTheme` (rather than reading a global) so callers
 * that need to render a NON-active theme — the theme-picker's live preview,
 * previewing whichever theme the cursor is hovering — get correctly-colored
 * code blocks too. `createMarkdownTheme(theme)` in pi-tui.theme.ts closes
 * over this to satisfy MarkdownTheme["highlightCode"]'s fixed
 * `(code, lang?) => string[]` shape.
 */
export const createHighlightCode = (theme: ColorTheme) => {
  /**
   * Matches MarkdownTheme["highlightCode"]: (code, lang?) => string[], one
   * entry per source line, with NO indent prefix — pi-tui's Markdown renderer
   * prepends `codeBlockIndent` itself (see markdown.js: `${indent}${hlLine}`),
   * so adding it here would double it up.
   */
  return (code: string, lang?: string): string[] => {
    const language = lang && hljs.getLanguage(lang) ? lang : undefined;

    let html: string;
    try {
      html = language
        ? hljs.highlight(code, { language }).value
        : hljs.highlightAuto(code).value;
    } catch {
      // Unknown/unsupported language, or a highlight.js internal error on
      // malformed input — fall back to plain, unhighlighted code rather than
      // dropping the code block entirely.
      return code.split("\n").map((line) => theme.assistant(line));
    }

    return renderHighlightedHtml(html, theme).split("\n");
  };
};