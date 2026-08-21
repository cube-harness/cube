#!/usr/bin/env node
import { startTui } from "./index.js";

startTui().catch((err: unknown) => {
  console.error("Fatal TUI Error:", err);
  process.exit(1);
});
