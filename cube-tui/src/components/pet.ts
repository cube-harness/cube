import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import {
  Container, ProcessTerminal, getCellDimensions, truncateToWidth, visibleWidth, type TUI,
} from "@earendil-works/pi-tui";
import {
  FRAME_SIZE_PX, PET_GEN_VERSION, PET_STATES, generateAnimations,
  type PetAnimation, type PetState,
} from "./pet.gen.js";
import type { WorkingIndicatorState } from "./working-indicator.js";
import { appTheme } from "../themes/app.theme.js";

type Animations = Record<PetState, PetAnimation>;
type Manifest = { version: unknown; states: Record<PetState, { fps: number; frames: string[] }> };
type PetFrame = { row: number; bottom: number; col: number; cols: number; rows: number; frame: string };

/** Optional cache. Never invalidate, delete, or overwrite an existing pet. */
export async function ensurePetFrames(dir: string): Promise<Animations | null> {
  try {
    let manifest: Manifest;
    try {
      manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      const generated = generateAnimations();
      await mkdir(dir, { recursive: true });
      manifest = { version: PET_GEN_VERSION, states: {} as Manifest["states"] };
      for (const state of PET_STATES) {
        const animation = generated[state];
        const frames = animation.frames.map((_, i) => `${state}_${String(i).padStart(2, "0")}.six`);
        for (const [i, name] of frames.entries()) {
          await writeFile(join(dir, name), animation.frames[i], { encoding: "latin1", flag: "wx" })
            .catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
        }
        manifest.states[state] = { fps: animation.fps, frames };
      }
      // Publish the manifest only after all frames exist; parallel launches may already have it.
      await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" })
        .catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    }
    const animations = {} as Animations;
    for (const state of PET_STATES) {
      const entry = manifest.states?.[state];
      if (!entry || !Number.isFinite(entry.fps) || entry.fps <= 0 || entry.fps > 30 ||
          !Array.isArray(entry.frames) || !entry.frames.length || entry.frames.length > 60 ||
          !entry.frames.every(name => typeof name === "string" && /^[\w-]+\.six$/.test(name))) return null;
      const frames = await Promise.all(entry.frames.map(name => readFile(join(dir, name), "latin1")));
      // Keep malformed cache/control sequences out of the terminal. Only 50px Sixel frames.
      if (!frames.every(frame => /^\x1bP[\d;]*q"1;1;50;50[\x20-\x7e]+\x1b\\$/.test(frame))) return null;
      animations[state] = { fps: entry.fps, frames };
    }
    return animations;
  } catch {
    // Decoration failure must not block chat or leak logs into the terminal.
    return null;
  }
}

export function supportsSixel(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CUBE_PET === "off") return false;
  if (env.CUBE_PET === "sixel") return true;
  if (env.TMUX || env.STY || env.ZELLIJ) return false;
  const term = env.TERM ?? "";
  return !!env.WT_SESSION || env.TERM_PROGRAM === "WezTerm" ||
    term.startsWith("foot") || term.includes("mlterm") || term.includes("sixel");
}

/** Keep Sixel out of pi-tui's text/image diff; paint it last inside the same synchronized frame. */
export class PetTerminal extends ProcessTerminal {
  private pet?: PetFrame;
  private paintedPet?: PetFrame;

  clearPet(): void { this.pet = undefined; }

  override write(data: string): void {
    if (data.includes("\x1b[2J") || data.includes("\x1b[?1049l")) {
      this.clearPet();
      this.paintedPet = undefined;
    }
    data = data.replace(/\x1b_cube-pet;(\d+);(\d+);(\d+);(\d+);([A-Za-z0-9+/=]+)\x1b\\/g,
      (_, rise, col, cols, rows, frame, offset: number) => {
        const anchor = [...data.slice(0, offset).matchAll(/\x1b\[(\d+);\d+H/g)].at(-1);
        const row = Number(anchor?.[1]) - Number(rise);
        this.pet = row >= 1 && row + Number(rows) - 1 <= this.rows
          ? { row, bottom: Number(anchor?.[1]), col: Number(col), cols: Number(cols), rows: Number(rows),
              frame: Buffer.from(frame, "base64").toString("latin1") }
          : undefined;
        return "";
      });
    if (data.startsWith("\x1b[?2026h") && data.endsWith("\x1b[?2026l")) {
      const old = this.paintedPet;
      if (old && (!this.pet || old.row !== this.pet.row || old.col !== this.pet.col ||
          old.cols !== this.pet.cols || old.rows !== this.pet.rows)) {
        // Erase the previous placement BEFORE text repaint, not over the new picker/card.
        let erase = "\x1b7\x1b[0m";
        const cols = Math.min(old.cols, this.columns - old.col + 1);
        for (let i = 0; cols > 0 && i < old.rows && old.row + i <= this.rows; i++) {
          const row = old.row + i;
          const clear = `\x1b[${row};${old.col}H\x1b[${cols}X`;
          // pi-tui can skip unchanged rows: restore their surface ourselves after erasing Sixel.
          erase += this.pet && row >= this.pet.row && row <= this.pet.bottom
            ? chalk.bgHex(appTheme.surface.background)(clear) : clear;
        }
        data = data.slice(0, 8) + erase + "\x1b8" + data.slice(8);
      }
      this.paintedPet = this.pet;
    }
    if (this.pet && data.startsWith("\x1b[?2026h") && data.endsWith("\x1b[?2026l")) {
      const { row, col, cols, rows, frame } = this.pet;
      let draw = "\x1b7\x1b[0m";
      let clear = "";
      for (let i = 0; i < rows; i++) clear += `\x1b[${row + i};${col}H\x1b[${cols}X`;
      draw += chalk.bgHex(appTheme.surface.background)(clear);
      draw += `\x1b[${row};${col}H${frame}\x1b8`;
      data = data.slice(0, -8) + draw + "\x1b[?2026l";
    }
    super.write(data);
  }
}

/** Separate content/pet regions sharing a continuous surface; the pet never covers text. */
export class PetPanel extends Container {
  private animations: Animations | null = null;
  private activity: PetState = "idle";
  private state: PetState = "idle";
  private changedAt = Date.now();
  private running = false;
  private visible = false;
  private timer?: NodeJS.Timeout;
  private lastFrame = -1;

  constructor(
    private readonly tui: TUI,
    private readonly dir: string | undefined,
    private readonly getPrompt: () => string,
    private readonly getTopRow: () => number,
  ) { super(); }

  async start(): Promise<void> {
    if (!this.dir || !supportsSixel() || this.running) return;
    this.running = true;
    this.animations ??= await ensurePetFrames(this.dir);
    if (!this.running || !this.animations) return;
    this.timer = setInterval(() => {
      if (!this.visible) return;
      const frame = this.frameIndex();
      if (frame !== this.lastFrame) this.tui.requestRender();
    }, 1000 / Math.max(...Object.values(this.animations).map(animation => animation.fps)));
    this.timer.unref();
    this.tui.requestRender();
  }

  sync(indicator: WorkingIndicatorState): void {
    const phases: Record<WorkingIndicatorState["phase"], PetState> = {
      idle: "idle", thinking: "thinking", streaming: "responding", tool: "working",
      approval: "waiting", input: "waiting", subagent: "working", memory: "thinking",
    };
    this.activity = indicator.phase === "thinking" && indicator.message === "Working"
      ? "working" : phases[indicator.phase];
  }

  stop(): void {
    this.running = false;
    this.visible = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.tui.terminal instanceof PetTerminal) this.tui.terminal.clearPet();
  }

  private frameIndex(): number {
    const animation = this.animations![this.state];
    return Math.floor((Date.now() - this.changedAt) * animation.fps / 1000) % animation.frames.length;
  }

  override render(width: number): string[] {
    const cell = getCellDimensions();
    const cols = Math.ceil(FRAME_SIZE_PX / cell.widthPx);
    // Sixel uses six-pixel bands, even when the raster height is not divisible by six.
    const rows = Math.ceil(Math.ceil(FRAME_SIZE_PX / 6) * 6 / cell.heightPx);
    this.visible = this.tui.terminal instanceof PetTerminal && !!this.animations && this.running && width - cols >= 30 &&
      this.tui.terminal.rows >= rows + 5;
    if (!this.visible) {
      if (this.tui.terminal instanceof PetTerminal) this.tui.terminal.clearPet();
      return super.render(width);
    }

    const next = this.activity === "idle" && this.getPrompt().trim() ? "prompting" : this.activity;
    if (next !== this.state) {
      this.state = next;
      this.changedAt = Date.now();
    }
    const leftWidth = width - cols;
    const lines = super.render(leftWidth).map(line => truncateToWidth(line, leftWidth, ""));
    const top = this.getTopRow();
    while (lines.length < top + rows) lines.push(chalk.bgHex(appTheme.surface.background)(" ".repeat(leftWidth)));
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const padding = " ".repeat(width - visibleWidth(line));
      // Extend each existing row's background, including the selected autocomplete row.
      const background = [...line.matchAll(/\x1b\[48;(?:2;\d+;\d+;\d+|5;\d+)m/g)].at(-1)?.[0];
      const tail = background ? background + padding + "\x1b[49m"
        : i >= top ? chalk.bgHex(appTheme.surface.background)(padding) : padding;
      lines[i] = line + "\x1b[0m" + tail;
    }
    this.lastFrame = this.frameIndex();
    // Cached frames may end with blank-band advances; trim for display, never rewrite cache.
    const frame = this.animations![this.state].frames[this.lastFrame].replace(/-+\x1b\\$/, "\x1b\\");
    const rise = lines.length - 1 - top;
    const col = leftWidth + 1;
    // Zero-width APC carries the frame without pretending to be a Kitty image.
    // PetTerminal consumes it after every text row has been repainted.
    lines[lines.length - 1] += `\x1b_cube-pet;${rise};${col};${cols};${rows};${Buffer.from(frame, "latin1").toString("base64")}\x1b\\`;
    return lines;
  }
}
