// cube-tui/src/themes/syntax.theme.ts
import chalk, { type ChalkInstance } from "chalk";

export interface SyntaxTokens {
  keyword: ChalkInstance;
  function: ChalkInstance;
  type: ChalkInstance;
  string: ChalkInstance;
  number: ChalkInstance;
  boolean: ChalkInstance;
  comment: ChalkInstance;
  variable: ChalkInstance;
  parameter: ChalkInstance;
  constant: ChalkInstance;
  property: ChalkInstance;
  punctuation: ChalkInstance;
  operator: ChalkInstance;
  diffAdded: ChalkInstance;
  diffAddedBg: ChalkInstance;
  diffRemoved: ChalkInstance;
  diffRemovedBg: ChalkInstance;
  diffMeta: ChalkInstance;
}

export interface SyntaxTheme {
  id: string;
  name: string;
  isDark: boolean;
  tokens: SyntaxTokens;
}

export const SYNTAX_THEMES: Record<string, SyntaxTheme> = {
  default: {
    id: "default",
    name: "Default",
    isDark: true,
    tokens: {
      keyword: chalk.hex("#EBBBFF").bold,
      function: chalk.hex("#92DAFE"),
      type: chalk.hex("#FDEEAD"),
      string: chalk.hex("#D1F1A9"),
      number: chalk.hex("#FDC08C"),
      boolean: chalk.hex("#EBBBFF").bold,
      comment: chalk.hex("#94A3B8").italic,
      variable: chalk.hex("#E2E8F0"),
      parameter: chalk.hex("#FDEEAD").italic,
      constant: chalk.hex("#F472B6"),
      property: chalk.hex("#7DD3FC"),
      punctuation: chalk.hex("#94A3B8"),
      operator: chalk.hex("#94A3B8"),
      diffAdded: chalk.hex("#34D399"),
      diffAddedBg: chalk.bgHex("#133621"),
      diffRemoved: chalk.hex("#FB7185"),
      diffRemovedBg: chalk.bgHex("#3A141A"),
      diffMeta: chalk.hex("#38BDF8"),
    },
  },
  dracula: {
    id: "dracula",
    name: "Dracula",
    isDark: true,
    tokens: {
      keyword: chalk.hex("#FF79C6").bold,
      function: chalk.hex("#50FA7B"),
      type: chalk.hex("#8BE9FD").italic,
      string: chalk.hex("#F1FA8C"),
      number: chalk.hex("#BD93F9"),
      boolean: chalk.hex("#BD93F9").bold,
      comment: chalk.hex("#6272A4").italic,
      variable: chalk.hex("#F8F8F2"),
      parameter: chalk.hex("#FFB86C").italic,
      constant: chalk.hex("#BD93F9"),
      property: chalk.hex("#FFB86C"),
      punctuation: chalk.hex("#F8F8F2"),
      operator: chalk.hex("#FF79C6"),
      diffAdded: chalk.hex("#50FA7B"),
      diffAddedBg: chalk.bgHex("#193822"),
      diffRemoved: chalk.hex("#FF5555"),
      diffRemovedBg: chalk.bgHex("#3B1824"),
      diffMeta: chalk.hex("#8BE9FD"),
    },
  },
  "tokyo-night": {
    id: "tokyo-night",
    name: "Tokyo Night",
    isDark: true,
    tokens: {
      keyword: chalk.hex("#BB9AF7").bold,
      function: chalk.hex("#7AA2F7"),
      type: chalk.hex("#7DCFFF").italic,
      string: chalk.hex("#9ECE6A"),
      number: chalk.hex("#FF9E64"),
      boolean: chalk.hex("#FF9E64").bold,
      comment: chalk.hex("#565F89").italic,
      variable: chalk.hex("#C0CAF5"),
      parameter: chalk.hex("#E0AF68").italic,
      constant: chalk.hex("#E0AF68"),
      property: chalk.hex("#7AA2F7"),
      punctuation: chalk.hex("#9AA5CE"),
      operator: chalk.hex("#89DDFF"),
      diffAdded: chalk.hex("#9ECE6A"),
      diffAddedBg: chalk.bgHex("#1E3820"),
      diffRemoved: chalk.hex("#F7768E"),
      diffRemovedBg: chalk.bgHex("#381926"),
      diffMeta: chalk.hex("#7AA2F7"),
    },
  },
  catppuccin: {
    id: "catppuccin",
    name: "Catppuccin Mocha",
    isDark: true,
    tokens: {
      keyword: chalk.hex("#CBA6F7").bold,
      function: chalk.hex("#89B4FA"),
      type: chalk.hex("#F9E2AF").italic,
      string: chalk.hex("#A6E3A1"),
      number: chalk.hex("#FAB387"),
      boolean: chalk.hex("#FAB387").bold,
      comment: chalk.hex("#6C7086").italic,
      variable: chalk.hex("#CDD6F4"),
      parameter: chalk.hex("#FAB387").italic,
      constant: chalk.hex("#F5C2E7"),
      property: chalk.hex("#89DCEB"),
      punctuation: chalk.hex("#BAC2DE"),
      operator: chalk.hex("#89DCEB"),
      diffAdded: chalk.hex("#A6E3A1"),
      diffAddedBg: chalk.bgHex("#1C3A24"),
      diffRemoved: chalk.hex("#F38BA8"),
      diffRemovedBg: chalk.bgHex("#3E1A26"),
      diffMeta: chalk.hex("#89B4FA"),
    },
  },
  "rose-pine": {
    id: "rose-pine",
    name: "Rosé Pine",
    isDark: true,
    tokens: {
      keyword: chalk.hex("#31748F").bold,
      function: chalk.hex("#EBBCBA"),
      type: chalk.hex("#9CCFD8").italic,
      string: chalk.hex("#F6C177"),
      number: chalk.hex("#EB6F92"),
      boolean: chalk.hex("#EB6F92").bold,
      comment: chalk.hex("#6E6A86").italic,
      variable: chalk.hex("#E0DEF4"),
      parameter: chalk.hex("#EBBCBA").italic,
      constant: chalk.hex("#C4A7E7"),
      property: chalk.hex("#9CCFD8"),
      punctuation: chalk.hex("#908CAA"),
      operator: chalk.hex("#EB6F92"),
      diffAdded: chalk.hex("#9CCFD8"),
      diffAddedBg: chalk.bgHex("#1A2D33"),
      diffRemoved: chalk.hex("#EB6F92"),
      diffRemovedBg: chalk.bgHex("#3D1926"),
      diffMeta: chalk.hex("#C4A7E7"),
    },
  },
  nord: {
    id: "nord",
    name: "Nord",
    isDark: true,
    tokens: {
      keyword: chalk.hex("#81A1C1").bold,
      function: chalk.hex("#88C0D0"),
      type: chalk.hex("#8FBCBB").italic,
      string: chalk.hex("#A3BE8C"),
      number: chalk.hex("#D08770"),
      boolean: chalk.hex("#D08770").bold,
      comment: chalk.hex("#616E88").italic,
      variable: chalk.hex("#D8DEE9"),
      parameter: chalk.hex("#D08770").italic,
      constant: chalk.hex("#EBCB8B"),
      property: chalk.hex("#88C0D0"),
      punctuation: chalk.hex("#ECEFF4"),
      operator: chalk.hex("#81A1C1"),
      diffAdded: chalk.hex("#A3BE8C"),
      diffAddedBg: chalk.bgHex("#1F3325"),
      diffRemoved: chalk.hex("#BF616A"),
      diffRemovedBg: chalk.bgHex("#361E22"),
      diffMeta: chalk.hex("#88C0D0"),
    },
  },
  "one-dark": {
    id: "one-dark",
    name: "One Dark Pro",
    isDark: true,
    tokens: {
      keyword: chalk.hex("#C678DD").bold,
      function: chalk.hex("#61AFEF"),
      type: chalk.hex("#E5C07B").italic,
      string: chalk.hex("#98C379"),
      number: chalk.hex("#D19A66"),
      boolean: chalk.hex("#D19A66").bold,
      comment: chalk.hex("#5C6370").italic,
      variable: chalk.hex("#ABB2BF"),
      parameter: chalk.hex("#E5C07B").italic,
      constant: chalk.hex("#E5C07B"),
      property: chalk.hex("#E06C75"),
      punctuation: chalk.hex("#ABB2BF"),
      operator: chalk.hex("#56B6C2"),
      diffAdded: chalk.hex("#98C379"),
      diffAddedBg: chalk.bgHex("#1E3622"),
      diffRemoved: chalk.hex("#E06C75"),
      diffRemovedBg: chalk.bgHex("#381A22"),
      diffMeta: chalk.hex("#61AFEF"),
    },
  },
  gruvbox: {
    id: "gruvbox",
    name: "Gruvbox Dark",
    isDark: true,
    tokens: {
      keyword: chalk.hex("#FB4934").bold,
      function: chalk.hex("#FABD2F"),
      type: chalk.hex("#8EC07C").italic,
      string: chalk.hex("#B8BB26"),
      number: chalk.hex("#D3869B"),
      boolean: chalk.hex("#D3869B").bold,
      comment: chalk.hex("#928374").italic,
      variable: chalk.hex("#EBDBB2"),
      parameter: chalk.hex("#FE8019").italic,
      constant: chalk.hex("#FE8019"),
      property: chalk.hex("#83A598"),
      punctuation: chalk.hex("#EBDBB2"),
      operator: chalk.hex("#8EC07C"),
      diffAdded: chalk.hex("#B8BB26"),
      diffAddedBg: chalk.bgHex("#263614"),
      diffRemoved: chalk.hex("#FB4934"),
      diffRemovedBg: chalk.bgHex("#3D1614"),
      diffMeta: chalk.hex("#83A598"),
    },
  },
  "solarized-dark": {
    id: "solarized-dark",
    name: "Solarized Dark",
    isDark: true,
    tokens: {
      keyword: chalk.hex("#859900").bold,
      function: chalk.hex("#268BD2"),
      type: chalk.hex("#B58900").italic,
      string: chalk.hex("#2AA198"),
      number: chalk.hex("#D33682"),
      boolean: chalk.hex("#D33682").bold,
      comment: chalk.hex("#586E75").italic,
      variable: chalk.hex("#839496"),
      parameter: chalk.hex("#CB4B16").italic,
      constant: chalk.hex("#CB4B16"),
      property: chalk.hex("#268BD2"),
      punctuation: chalk.hex("#93A1A1"),
      operator: chalk.hex("#859900"),
      diffAdded: chalk.hex("#859900"),
      diffAddedBg: chalk.bgHex("#143516"),
      diffRemoved: chalk.hex("#DC322F"),
      diffRemovedBg: chalk.bgHex("#3B1418"),
      diffMeta: chalk.hex("#268BD2"),
    },
  },
  "github-dark": {
    id: "github-dark",
    name: "GitHub Dark",
    isDark: true,
    tokens: {
      keyword: chalk.hex("#FF7B72").bold,
      function: chalk.hex("#D2A8FF"),
      type: chalk.hex("#FFA657").italic,
      string: chalk.hex("#A5D6FF"),
      number: chalk.hex("#79C0FF"),
      boolean: chalk.hex("#79C0FF").bold,
      comment: chalk.hex("#8B949E").italic,
      variable: chalk.hex("#C9D1D9"),
      parameter: chalk.hex("#FFA657").italic,
      constant: chalk.hex("#79C0FF"),
      property: chalk.hex("#79C0FF"),
      punctuation: chalk.hex("#C9D1D9"),
      operator: chalk.hex("#FF7B72"),
      diffAdded: chalk.hex("#7EE787"),
      diffAddedBg: chalk.bgHex("#133821"),
      diffRemoved: chalk.hex("#FFA198"),
      diffRemovedBg: chalk.bgHex("#3D1B20"),
      diffMeta: chalk.hex("#79C0FF"),
    },
  },
  monokai: {
    id: "monokai",
    name: "Monokai Pro",
    isDark: true,
    tokens: {
      keyword: chalk.hex("#F92672").bold,
      function: chalk.hex("#A6E22E"),
      type: chalk.hex("#66D9EF").italic,
      string: chalk.hex("#E6DB74"),
      number: chalk.hex("#AE81FF"),
      boolean: chalk.hex("#AE81FF").bold,
      comment: chalk.hex("#75715E").italic,
      variable: chalk.hex("#F8F8F2"),
      parameter: chalk.hex("#FD971F").italic,
      constant: chalk.hex("#FD971F"),
      property: chalk.hex("#A6E22E"),
      punctuation: chalk.hex("#F8F8F2"),
      operator: chalk.hex("#F92672"),
      diffAdded: chalk.hex("#A6E22E"),
      diffAddedBg: chalk.bgHex("#223816"),
      diffRemoved: chalk.hex("#F92672"),
      diffRemovedBg: chalk.bgHex("#3D1420"),
      diffMeta: chalk.hex("#66D9EF"),
    },
  },
  cyberpunk: {
    id: "cyberpunk",
    name: "Cyberpunk",
    isDark: true,
    tokens: {
      keyword: chalk.hex("#FFE600").bold,
      function: chalk.hex("#FF007F"),
      type: chalk.hex("#00FF66").italic,
      string: chalk.hex("#00F0FF"),
      number: chalk.hex("#FFA657"),
      boolean: chalk.hex("#FFA657").bold,
      comment: chalk.hex("#7A7A8C").italic,
      variable: chalk.hex("#E0E0E0"),
      parameter: chalk.hex("#FFA657").italic,
      constant: chalk.hex("#FF007F"),
      property: chalk.hex("#00F0FF"),
      punctuation: chalk.hex("#00F0FF"),
      operator: chalk.hex("#FFE600"),
      diffAdded: chalk.hex("#00FF66"),
      diffAddedBg: chalk.bgHex("#003816"),
      diffRemoved: chalk.hex("#FF0055"),
      diffRemovedBg: chalk.bgHex("#400015"),
      diffMeta: chalk.hex("#00F0FF"),
    },
  },
};

let activeSyntaxTheme: SyntaxTheme = SYNTAX_THEMES.default;

const THEME_ALIASES: Record<string, string> = {
  tokyo: "tokyo-night",
  tokyonight: "tokyo-night",
  rose: "rose-pine",
  rosepine: "rose-pine",
  "rosé-pine": "rose-pine",
  solarized: "solarized-dark",
  solarizeddark: "solarized-dark",
  onedark: "one-dark",
  atom: "one-dark",
  github: "github-dark",
  githubdark: "github-dark",
  mocha: "catppuccin",
  cat: "catppuccin",
  dark: "default",
  cyan: "default",
  "default-cyan": "default",
};

export const setSyntaxTheme = (id: string): void => {
  const normalized = id.toLowerCase().trim().replace(/_/g, "-");
  const targetId = THEME_ALIASES[normalized] || normalized;
  if (SYNTAX_THEMES[targetId]) {
    activeSyntaxTheme = SYNTAX_THEMES[targetId];
  }
};

export const getSyntaxTheme = (): SyntaxTheme => activeSyntaxTheme;

export const getAvailableSyntaxThemes = (): Array<{ id: string; name: string }> => {
  return Object.values(SYNTAX_THEMES).map((t) => ({
    id: t.id,
    name: t.name,
  }));
};
