import type { Component } from "@earendil-works/pi-tui";
import chalk from "chalk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
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
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const pkgRoot = path.resolve(__dirname, "../..");
   const possiblePaths = [
        path.join(pkgRoot, "asset", "cube.txt"),
        path.join(pkgRoot, "assets", "cube.txt"),
        path.join(process.cwd(), "cube-tui", "asset", "cube.txt"),
        path.join(process.cwd(), "cube.txt"),
      ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      const fileContent = fs.readFileSync(p, "utf-8");
      // Khôi phục mã ESC nếu file lưu dạng literal "\x1b" hoặc "[" thiếu ESC
      const parsedContent = fileContent
        .replace(/\\x1b\[/g, "\x1b[")
        .replace(/(^|[^\x1b])\[([0-9;]+m)/g, "$1\x1b[$2");

      // Chuyển toàn bộ màu xanh ANSI (34/44/94) sang mã TrueColor #38BDF8 (Primary)
      const themedContent = parsedContent.replace(/\x1b\[([0-9;]+)m/g, (_, codes: string) => {
        const parts = codes.split(";");
        const newParts: string[] = [];
        for (const c of parts) {
          if (c === "34" || c === "36") {
            // Foreground Primary: #38BDF8
            newParts.push("38", "2", "56", "189", "248");
          } else if (c === "94" || c === "96") {
            // Bright Foreground Primary: #7DD3FC
            newParts.push("38", "2", "125", "211", "252");
          } else if (c === "44" || c === "46") {
            // Background Blue Shadow: #075985 (sky-800)
            newParts.push("48", "2", "7", "89", "133");
          } else {
            newParts.push(c);
          }
        }
        return `\x1b[${newParts.join(";")}m`;
      });

      const lines = themedContent.split(/\r?\n/);
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
    // Nếu banner đã có sẵn mã màu ANSI 3D thì in nguyên bản để không bị gradient đè bẹp màu
    const hasAnsi = WORDMARK.some((line) => /\x1b\[[0-9;]*m/.test(line));
    if (hasAnsi) {
      return [...WORDMARK, ""];
    }

    const [light, dark] = appTheme.bannerGradient;
    const wordmark = gradientLines(WORDMARK, light, dark);
    return [...wordmark, ""];
  };
}