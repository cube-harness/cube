import type { Component } from "@earendil-works/pi-tui";
import chalk from "chalk";
import fs from "fs";
import path from "path";
import { appTheme } from "../themes/app.theme.js";

const FALLBACK_WORDMARK = [
  "                                                                                 ",
  " ██████╗██╗   ██╗██████╗ ███████╗     █████╗  ██████╗ ███████╗███╗   ██╗████████╗",
  "██╔════╝██║   ██║██╔══██╗██╔════╝    ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝",
  "██║     ██║   ██║██████╔╝█████╗      ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ",
  "██║     ██║   ██║██╔══██╗██╔══╝      ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ",
  "╚██████╗╚██████╔╝██████╔╝███████╗    ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ",
  " ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝    ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ",
];

let WORDMARK: string[] = FALLBACK_WORDMARK;

try {
  // Hỗ trợ cả khi chạy dev (ts-node/node) lẫn khi build binary (tìm asset cạnh file binary hoặc thư mục gốc)
  const possiblePaths = [
    path.join(process.cwd(), "cube.txt"),
    path.join(path.dirname(process.execPath), "assets/cube.txt"),
    path.join(path.dirname(process.execPath), "cube.txt"),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      const fileContent = fs.readFileSync(p, "utf-8");
      const lines = fileContent.split(/\r?\n/);
      if (lines.length > 0) {
        WORDMARK = lines;
        break;
      }
    }
  }
} catch (error) {
  // Giữ fallback an toàn tuyệt đối cho one-liner
}

const interpolateHex = (from: string, to: string, t: number): string => {
  const a = parseInt(from.slice(1), 16);
  const b = parseInt(to.slice(1), 16);
  const ar = (a >> 16) & 255,
    ag = (a >> 8) & 255,
    ab = a & 255;
  const br = (b >> 16) & 255,
    bg = (b >> 8) & 255,
    bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${[r, g, bl].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};

const gradientLines = (lines: string[], from: string, to: string): string[] => {
  const total = Math.max(lines.length - 1, 1);
  return lines.map((line, i) => {
    const color = interpolateHex(from, to, i / total);
    return chalk.hex(color)(line);
  });
};

export class Banner implements Component {
  invalidate = () => {};
  render = (_width: number): string[] => {
    const [light, dark] = appTheme.bannerGradient;

    const wordmark = gradientLines(WORDMARK, light, dark);

    return [...wordmark, ""];
  };
}