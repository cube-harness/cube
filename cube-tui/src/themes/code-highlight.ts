// cube-tui/src/themes/code-highlight.ts
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import bash from "highlight.js/lib/languages/bash";
import sql from "highlight.js/lib/languages/sql";
import pgsql from "highlight.js/lib/languages/pgsql";
import csharp from "highlight.js/lib/languages/csharp";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import kotlin from "highlight.js/lib/languages/kotlin";
import swift from "highlight.js/lib/languages/swift";
import php from "highlight.js/lib/languages/php";
import ruby from "highlight.js/lib/languages/ruby";
import markdown from "highlight.js/lib/languages/markdown";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import nginx from "highlight.js/lib/languages/nginx";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import powershell from "highlight.js/lib/languages/powershell";
import scss from "highlight.js/lib/languages/scss";
import less from "highlight.js/lib/languages/less";
import lua from "highlight.js/lib/languages/lua";
import protobuf from "highlight.js/lib/languages/protobuf";
import makefile from "highlight.js/lib/languages/makefile";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import { appTheme } from "./app.theme.js";
import type { SyntaxTheme } from "./syntax.theme.js";
import { getSyntaxTheme } from "./syntax.theme.js";

/**
 * Curated comprehensive language set for full polyglot coding, database queries, and configs:
 * TS/JS, Python, Rust, Go, C/C++, Java, Kotlin, Swift, PHP, Ruby, SQL/PostgreSQL, MongoDB,
 * Bash/PowerShell, JSON/YAML/TOML, XML/HTML, CSS/SCSS/LESS, Docker, Nginx, GraphQL, Proto, Makefile, Markdown, Diff.
 */
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("pgsql", pgsql);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("php", php);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("nginx", nginx);
hljs.registerLanguage("graphql", graphql);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("scss", scss);
hljs.registerLanguage("less", less);
hljs.registerLanguage("lua", lua);
hljs.registerLanguage("protobuf", protobuf);
hljs.registerLanguage("makefile", makefile);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);

// Aliases
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["js", "jsx", "mjs", "cjs", "mongo", "mongodb", "bson"], { languageName: "javascript" });
hljs.registerAliases(["py", "py3", "python3"], { languageName: "python" });
hljs.registerAliases(["sh", "shell", "zsh", "env"], { languageName: "bash" });
hljs.registerAliases(["ps1", "pwsh"], { languageName: "powershell" });
hljs.registerAliases(["cs", "dotnet"], { languageName: "csharp" });
hljs.registerAliases(["cc", "cxx", "h", "hpp"], { languageName: "cpp" });
hljs.registerAliases(["rs"], { languageName: "rust" });
hljs.registerAliases(["golang"], { languageName: "go" });
hljs.registerAliases(["kt", "kts"], { languageName: "kotlin" });
hljs.registerAliases(["rb"], { languageName: "ruby" });
hljs.registerAliases(["md", "mkd"], { languageName: "markdown" });
hljs.registerAliases(["docker"], { languageName: "dockerfile" });
hljs.registerAliases(["gql"], { languageName: "graphql" });
hljs.registerAliases(["toml"], { languageName: "ini" });
hljs.registerAliases(["proto"], { languageName: "protobuf" });
hljs.registerAliases(["make"], { languageName: "makefile" });
hljs.registerAliases(["html", "svg"], { languageName: "xml" });
hljs.registerAliases(["yml"], { languageName: "yaml" });
hljs.registerAliases(["jsonc", "json5", "jsonl", "ndjson", "geojson"], { languageName: "json" });
hljs.registerAliases(["patch"], { languageName: "diff" });
hljs.registerAliases(["postgres", "postgresql"], { languageName: "pgsql" });
hljs.registerAliases(["mysql", "sqlite"], { languageName: "sql" });

/**
 * Resolves token styling based on precise class combination (e.g. "title class_" vs "title function_").
 */
const resolveTokenStyle = (rawClass: string, st: SyntaxTheme): ((s: string) => string) => {
  const classes = rawClass.split(" ");
  if (classes.includes("class_") || classes.includes("type") || classes.includes("built_in") || classes.includes("regexp")) {
    return st.tokens.type;
  }
  if (classes.includes("function_") || classes.includes("title")) {
    return st.tokens.function;
  }
  if (classes.includes("keyword") || classes.includes("selector-tag") || classes.includes("name")) {
    return st.tokens.keyword;
  }
  if (classes.includes("string") || classes.includes("code")) {
    return st.tokens.string;
  }
  if (classes.includes("number")) {
    return st.tokens.number;
  }
  if (classes.includes("literal")) {
    return st.tokens.boolean;
  }
  if (classes.includes("comment") || classes.includes("doctag") || classes.includes("quote")) {
    return st.tokens.comment;
  }
  if (classes.includes("params") || classes.includes("attr") || classes.includes("selector-attr")) {
    return st.tokens.parameter ?? st.tokens.property;
  }
  if (classes.includes("symbol") || classes.includes("constant") || classes.includes("selector-pseudo")) {
    return st.tokens.constant;
  }
  if (classes.includes("meta")) {
    return st.tokens.diffMeta ?? st.tokens.type;
  }
  if (classes.includes("addition")) {
    return st.tokens.diffAdded ?? st.tokens.string;
  }
  if (classes.includes("deletion")) {
    return st.tokens.diffRemoved ?? st.tokens.keyword;
  }
  if (classes.includes("punctuation") || classes.includes("tag")) {
    return st.tokens.punctuation;
  }
  if (classes.includes("operator")) {
    return st.tokens.operator;
  }
  if (classes.includes("property")) {
    return st.tokens.property;
  }
  return st.tokens.variable;
};

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
};

const decodeEntities = (html: string): string =>
  html.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (match) => ENTITIES[match] ?? match);

/**
 * Parses highlight.js HTML output containing `<span class="hljs-TOKEN">...</span>`
 * and applies Chalk styling according to the provided SyntaxTheme.
 */
export const highlightToAnsi = (html: string, st: SyntaxTheme): string => {
  let result = "";
  let i = 0;
  const styleStack: Array<(s: string) => string> = [];

  while (i < html.length) {
    if (html.startsWith("<span class=\"hljs-", i)) {
      const classStart = i + '<span class="hljs-'.length;
      const classEnd = html.indexOf('"', classStart);
      if (classEnd === -1) {
        result += html[i++];
        continue;
      }

      const rawClass = html.slice(classStart, classEnd);
      const styleFn = resolveTokenStyle(rawClass, st);

      styleStack.push(styleFn);
      i = html.indexOf(">", classEnd) + 1;
    } else if (html.startsWith("</span>", i)) {
      styleStack.pop();
      i += "</span>".length;
    } else {
      const nextTag = html.indexOf("<", i);
      const textChunk = nextTag === -1 ? html.slice(i) : html.slice(i, nextTag);
      const decoded = decodeEntities(textChunk);

      const activeStyle = styleStack[styleStack.length - 1];
      result += activeStyle ? activeStyle(decoded) : decoded;

      i = nextTag === -1 ? html.length : nextTag;
    }
  }

  return result;
};

/**
 * Creates a code highlighter function compatible with pi-tui's MarkdownTheme.highlightCode.
 */
export const createHighlightCode = (
  theme?: SyntaxTheme,
): ((code: string, lang?: string) => string[]) => {
  return (code: string, lang?: string): string[] => {
    const st = theme ?? getSyntaxTheme();
    const effectiveLang = lang && hljs.getLanguage(lang) ? lang : undefined;

    if (effectiveLang === "diff") {
      const lines = code.split("\n");
      return lines.map((line) => {
        if (/^\s*\d*\s*\+/.test(line) || line.startsWith("+")) {
          return st.tokens.diffAddedBg(st.tokens.diffAdded(line));
        }
        if (/^\s*\d*\s*\-/.test(line) || line.startsWith("-")) {
          return st.tokens.diffRemovedBg(st.tokens.diffRemoved(line));
        }
        if (line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ")) {
          return st.tokens.diffMeta(line);
        }
        return st.tokens.variable(line);
      });
    }

    let highlightedHtml: string;
    try {
      if (effectiveLang) {
        highlightedHtml = hljs.highlight(code, { language: effectiveLang, ignoreIllegals: true }).value;
      } else {
        highlightedHtml = hljs.highlightAuto(code).value;
      }
    } catch {
      highlightedHtml = code;
    }

    return highlightedHtml.split("\n").map((lineHtml) => highlightToAnsi(lineHtml, st));
  };
};
