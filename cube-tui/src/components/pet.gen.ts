export const PET_STATES = ["idle", "prompting", "working", "thinking", "responding", "waiting"] as const;
export type PetState = (typeof PET_STATES)[number];

// Drawing ported from cube-pet. Existing disk frames are never version-invalidated.
export const PET_GEN_VERSION = 2;

export interface PetPalette {
  top: string; front: string; side: string; outline: string; face: string; accent: string;
}
export const DEFAULT_PALETTE: PetPalette = {
  top: "#7DD3FC", front: "#38BDF8", side: "#0284C7",
  outline: "#0C4A6E", face: "#F8FAFC", accent: "#FDE68A",
};
export interface PetAnimation { fps: number; frames: string[] }

const S = 25;       // art grid
const K = 2;        // art pixel -> K output pixels. Size = 25*K px: 3 -> 75px, 2 -> 50px
const W = S * K;    // frame size in px
const NONE = 255;
const COLORS = ["top", "front", "side", "outline", "face", "accent"] as const;
type Color = (typeof COLORS)[number];
const ci = (c: Color) => COLORS.indexOf(c);
type Pt = [number, number];

// ---- art ------------------------------------------------------------------
function body(): Uint8Array {
  const g = new Uint8Array(S * S).fill(NONE);
  const put = (x: number, y: number, c: Color) => { g[y * S + x] = ci(c); };
  for (let y = 10; y <= 22; y++) for (let x = 3; x <= 18; x++) put(x, y, "front");
  for (let i = 1; i <= 4; i++) for (let x = 3 + i; x <= 18 + i; x++) put(x, 10 - i, "top");
  for (let c = 1; c <= 4; c++) for (let y = 10 - c; y <= 22 - c; y++) put(18 + c, y, "side");
  return g;
}

const rect = (xs: number[], ys: number[]): Pt[] => xs.flatMap((x) => ys.map((y): Pt => [x, y]));
const EYES: Record<string, Pt[]> = {
  open:  rect([7, 8, 13, 14], [14, 15, 16]),
  blink: rect([7, 8, 13, 14], [15]),
  up:    rect([8, 9, 14, 15], [13, 14, 15]),
  down:  rect([7, 8, 13, 14], [16, 17]),
  happy: [6, 12].flatMap((x): Pt[] => [[x, 16], [x + 1, 15], [x + 2, 16]]),
  // prompting: left eye looks down-left, right eye shut (wink)
  wink:  [...rect([6, 7], [15, 16, 17]), [13, 16], [14, 16], [15, 16]],
};
const MOUTH: Record<string, Pt[]> = {
  small: [[10, 19], [11, 19]],
  left:  [[9, 20], [10, 20]],
  o:     [[10, 19], [11, 19], [10, 20], [11, 20]],
  wide:  [[9, 19], [10, 19], [11, 19], [12, 19], [10, 20], [11, 20]],
};
const QMARK = ["###", "..#", ".#.", "...", ".#."];

interface FrameSpec {
  eyes: keyof typeof EYES; mouth: keyof typeof MOUTH;
  dx?: number; dy?: number; dots?: number; qmark?: boolean;
}

/** Returns a W*W array of palette indices (NONE = transparent). dx/dy are written for K=3 and scaled to K. */
function drawFrame({ eyes, mouth, dx = 0, dy = 0, dots = 0, qmark = false }: FrameSpec): Uint8Array {
  const g = body();
  for (const [x, y] of EYES[eyes]) g[y * S + x] = ci("face");
  for (const [x, y] of MOUTH[mouth]) g[y * S + x] = ci("face");

  const edge: number[] = []; // 1px outline outside the silhouette
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (g[y * S + x] !== NONE) continue;
    const nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
    if (nb.some(([nx, ny]) => nx >= 0 && ny >= 0 && nx < S && ny < S && g[ny * S + nx] !== NONE)) edge.push(y * S + x);
  }
  for (const i of edge) g[i] = ci("outline");

  const glyph = new Uint8Array(S * S).fill(NONE); // does not move with the body
  for (let i = 0; i < dots; i++) glyph[2 * S + 8 + i * 3] = ci("accent");
  if (qmark) QMARK.forEach((row, r) => [...row].forEach((ch, c) => { if (ch === "#") glyph[r * S + 11 + c] = ci("accent"); }));

  const out = new Uint8Array(W * W).fill(NONE);
  const blit = (layer: Uint8Array, ox: number, oy: number) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const c = layer[y * S + x];
      if (c === NONE) continue;
      for (let j = 0; j < K; j++) for (let i = 0; i < K; i++) {
        const px = x * K + i + ox, py = y * K + j + oy;
        if (px >= 0 && py >= 0 && px < W && py < W) out[py * W + px] = c;
      }
    }
  };
  blit(g, Math.round((dx * K) / 3), Math.round((dy * K) / 3));
  blit(glyph, 0, 0);
  return out;
}

// ---- sixel ----------------------------------------------------------------
const hex = (h: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];

/** Transparent Sixel (P2=1: unpainted pixels stay transparent). */
export function encodeSixel(px: Uint8Array, w: number, h: number, palette: PetPalette): string {
  const used = [...new Set(px)].filter((c) => c !== NONE).sort((a, b) => a - b);
  let out = `\x1bP9;1;0q"1;1;${w};${h}`;
  for (const c of used) {
    const [r, g, b] = hex(palette[COLORS[c]]).map((v) => Math.round((v * 100) / 255));
    out += `#${c};2;${r};${g};${b}`;
  }
  for (let top = 0; top < h; top += 6) {
    for (const c of used) {
      const bits = new Uint8Array(w);
      let any = false;
      for (let x = 0; x < w; x++) {
        let v = 0;
        for (let k = 0; k < 6; k++) {
          const y = top + k;
          if (y < h && px[y * w + x] === c) v |= 1 << k;
        }
        bits[x] = v;
        any ||= v !== 0;
      }
      if (!any) continue;
      let s = `#${c}`;
      for (let i = 0; i < w; ) {
        let j = i;
        while (j < w && bits[j] === bits[i]) j++;
        const ch = String.fromCharCode(63 + bits[i]);
        s += j - i > 3 ? `!${j - i}${ch}` : ch.repeat(j - i);
        i = j;
      }
      out += s + "$";
    }
    out += "-";
  }
  return out + "\x1b\\";
}

// ---- animations -------------------------------------------------------------
const bob = (n: number, amp: number) =>
  Array.from({ length: n }, (_, i) => Math.round((amp * (1 - Math.cos((2 * Math.PI * i) / n))) / 2));
const sway = (n: number, amp: number) =>
  Array.from({ length: n }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * i) / n)));

function specs(): Record<PetState, { fps: number; frames: FrameSpec[] }> {
  const idleBob = bob(12, 3);
  const thinkSway = sway(12, 2), thinkBob = bob(12, 2);
  const thinkDots = [1, 1, 2, 2, 3, 3, 3, 3, 2, 2, 1, 1];
  const waitBob = bob(8, 2), promptBob = bob(10, 2), talkBob = bob(8, 1);
  const talk = ["small", "o", "wide", "o", "small", "wide", "o", "small"];
  return {
    idle: { fps: 6, frames: idleBob.map((dy, i) => ({ eyes: i === 9 ? "blink" : "open", mouth: "small", dy })) },
    prompting: { fps: 6, frames: promptBob.map((dy) => ({ eyes: "wink", mouth: "left", dy })) },
    working: { fps: 12, frames: bob(8, 2).map((dy) => ({ eyes: "happy", mouth: "small", dy })) },
    thinking: { fps: 6, frames: thinkDots.map((dots, i) => ({ eyes: "up", mouth: "small", dx: thinkSway[i], dy: thinkBob[i], dots })) },
    responding: { fps: 8, frames: talk.map((mouth, i) => ({ eyes: "open", mouth, dy: talkBob[i] })) },
    waiting: { fps: 5, frames: waitBob.map((dy, i) => ({ eyes: i < 6 ? "up" : "open", mouth: "small", dy, qmark: i < 6 })) },
  };
}

export function generateAnimations(palette: PetPalette = DEFAULT_PALETTE): Record<PetState, PetAnimation> {
  const out = {} as Record<PetState, PetAnimation>;
  for (const [state, { fps, frames }] of Object.entries(specs()) as [PetState, ReturnType<typeof specs>[PetState]][]) {
    out[state] = { fps, frames: frames.map((f) => encodeSixel(drawFrame(f), W, W, palette)) };
  }
  return out;
}

export const FRAME_SIZE_PX = W;
