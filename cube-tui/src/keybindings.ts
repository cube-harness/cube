import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  getKeybindings,
  setKeybindings,
  type Keybinding,
  type KeybindingsConfig,
  type KeybindingDefinitions,
} from "@earendil-works/pi-tui";

declare module "@earendil-works/pi-tui" {
  interface Keybindings {
    "cube.turn.interrupt": true;
    "cube.app.exit": true;
    "cube.transcript.toggle": true;
    "cube.approval.approve": true;
    "cube.approval.approvePrefix": true;
    "cube.approval.decline": true;
    "cube.history.previous": true;
    "cube.history.next": true;
  }
}

export const CUBE_KEYBINDINGS = {
  "cube.turn.interrupt": {
    defaultKeys: "escape",
    description: "Cancel the next queued prompt or interrupt the active agent turn",
  },
  "cube.app.exit": {
    defaultKeys: "ctrl+c",
    description: "Exit Cube when no work remains",
  },
  "cube.transcript.toggle": {
    defaultKeys: "ctrl+t",
    description: "Toggle expanded tool transcripts",
  },
  "cube.approval.approve": {
    defaultKeys: ["y", "shift+y", "1"],
    description: "Approve the pending tool call",
  },
  "cube.approval.approvePrefix": {
    defaultKeys: ["p", "shift+p", "2"],
    description: "Approve and remember the tool",
  },
  "cube.approval.decline": {
    defaultKeys: ["n", "shift+n", "3"],
    description: "Decline the pending tool call",
  },
  "cube.history.previous": {
    defaultKeys: "up",
    description: "Browse previous prompt in history",
  },
  "cube.history.next": {
    defaultKeys: "down",
    description: "Browse next prompt in history",
  },
} as const satisfies KeybindingDefinitions;

const DEFINITIONS = {
  ...TUI_KEYBINDINGS,
  ...CUBE_KEYBINDINGS,
} satisfies KeybindingDefinitions;

export const createCubeKeybindings = (
  overrides: KeybindingsConfig = {},
): KeybindingsManager => new KeybindingsManager(DEFINITIONS, overrides);

export const installCubeKeybindings = (
  overrides: KeybindingsConfig = {},
): KeybindingsManager => {
  const manager = createCubeKeybindings(overrides);
  setKeybindings(manager);
  return manager;
};

export const matchesBinding = (data: string, binding: Keybinding): boolean =>
  getKeybindings().matches(data, binding);

const DISPLAY_NAMES: Record<string, string> = {
  up: "↑",
  down: "↓",
  enter: "Enter",
  escape: "Esc",
  pageUp: "PgUp",
  pageDown: "PgDn",
};

export const formatBinding = (binding: Keybinding): string =>
  getKeybindings()
    .getKeys(binding)
    .map((key) => DISPLAY_NAMES[key] ?? key)
    .join("/");

// Package bootstrap: every exported Cube component observes the same registry,
// including consumers that instantiate a picker without creating CubeApp.
installCubeKeybindings();
