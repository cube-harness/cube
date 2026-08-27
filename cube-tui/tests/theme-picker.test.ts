import assert from "node:assert/strict";
import test from "node:test";
import {
  ThemePickerOverlay,
  type ThemePickerItem,
} from "../src/components/theme-picker.js";

const sampleThemes: ThemePickerItem[] = [
  { id: "default", name: "Default Cyan" },
  { id: "dracula", name: "Dracula" },
  { id: "nord", name: "Nord" },
  { id: "cyberpunk", name: "Cyberpunk Neon" },
];

test("ThemePickerOverlay renders 2-column layout within width limit", () => {
  const overlay = new ThemePickerOverlay({
    themes: sampleThemes,
    currentThemeId: "default",
    onSelect: () => {},
    onCancel: () => {},
  });

  const lines = overlay.render(100);
  assert.equal(lines.length > 0, true);
  for (const line of lines) {
    assert.equal(line.length <= 150, true);
  }
});

test("ThemePickerOverlay supports keyboard navigation and Enter to select", () => {
  let selected = "";
  const overlay = new ThemePickerOverlay({
    themes: sampleThemes,
    currentThemeId: "default",
    onSelect: (t) => {
      selected = t;
    },
    onCancel: () => {},
  });

  // Navigate down to Dracula
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\r");

  assert.equal(selected, "dracula");
});

test("ThemePickerOverlay triggers onCancel when Escape is pressed", () => {
  let cancelled = false;
  const overlay = new ThemePickerOverlay({
    themes: sampleThemes,
    currentThemeId: "default",
    onSelect: () => {},
    onCancel: () => {
      cancelled = true;
    },
  });

  overlay.handleInput("\x1b");
  assert.equal(cancelled, true);
});
