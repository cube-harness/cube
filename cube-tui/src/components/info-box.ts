import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import chalk, { type ChalkInstance } from "chalk";
import { appTheme } from "../themes/app.theme.js";

const CUBE_ICON = [
  "   _______   ",
  "  /\\      \\  ",
  " /  \\      \\ ",
  "/    \\______\\",
  "\\    /      /",
  " \\  /      / ",
  "  \\/______/  ",
];

export interface InfoBoxContent {
  model?: string;
  workspace?: string;
  agentMd?: string;
  threadTitle?: string;
  threadId?: string;
}

export type InforBoxContent = InfoBoxContent;

export class InfoBox implements Component {
  invalidate = () => {};

  private model: string = "cube-agent";
  private workspace: string = "D:/cube";
  private agentMd: string = "AGENT.md (active)";
  private threadTitle?: string;
  private threadId: string = "thread_default";

  private paddingX: number = 2;
  private paddingY: number = 1;
  private borderColor?: string;
  private titleColor?: string;

  constructor(
    private title: string = "Cube Information",
    content?: InfoBoxContent,
  ) {
    if (content) {
      this.setInfo(content);
    }
  }

  setTitle(title: string) {
    this.title = title;
  }

  setBorderColor(color: string) {
    this.borderColor = color;
  }

  setTitleColor(color: string) {
    this.titleColor = color;
  }

  getModel(): string {
    return this.model;
  }

  getWorkspace(): string {
    return this.workspace;
  }

  getAgentMd(): string {
    return this.agentMd;
  }

  getThreadTitle(): string | undefined {
    return this.threadTitle;
  }

  getThreadId(): string {
    return this.threadId;
  }

  setInfo(info: InfoBoxContent) {
    if (info.model !== undefined) this.model = info.model;
    if (info.workspace !== undefined) this.workspace = info.workspace;
    if (info.agentMd !== undefined) this.agentMd = info.agentMd;
    if ("threadTitle" in info) this.threadTitle = info.threadTitle;
    if (info.threadId !== undefined) this.threadId = info.threadId;
  }

  render = (width: number): string[] => {
    const [light, dark] = appTheme.bannerGradient;

    const borderChalk = this.borderColor
      ? ((chalk[this.borderColor as keyof ChalkInstance] ?? appTheme.ui.border) as ChalkInstance)
      : appTheme.ui.border;

    const titleChalk = this.titleColor
      ? ((chalk[this.titleColor as keyof ChalkInstance] ?? appTheme.ui.primary.bold) as ChalkInstance)
      : appTheme.ui.primary.bold;

    const contentLines: string[] = [
      `${appTheme.ui.muted("Model        :")} ${appTheme.ui.text(this.model)}`,
      `${appTheme.ui.muted("Workspace    :")} ${appTheme.ui.text(this.workspace)}`,
      `${appTheme.ui.muted("AGENT.md     :")} ${appTheme.ui.text(this.agentMd)}`,
    ];

    if (this.threadTitle) {
      contentLines.push(
        `${appTheme.ui.muted("Thread Title :")} ${appTheme.ui.text(this.threadTitle)}`,
      );
    }

    contentLines.push(
      `${appTheme.ui.muted("Thread ID    :")} ${appTheme.ui.text(this.threadId)}`,
    );

    // Tạo gradient cho Cube Icon giống Banner cũ
    const iconHeight = CUBE_ICON.length;
    const coloredIcon = CUBE_ICON.map((line, i) => {
      const t = Math.max(0, Math.min(1, i / Math.max(iconHeight - 1, 1)));
      // Hàm nội suy màu hex nhanh
      const colorHex = interpolateHex(light, dark, t);
      return chalk.hex(colorHex)(line);
    });

    const cubeWidth = CUBE_ICON[0].length;
    const gap = 2; // Khoảng cách giữa hình cube và phần thông tin

    // Tính toán độ rộng lớn nhất của phần text thông tin bên phải
    let maxTextWidth = 0;
    for (const line of contentLines) {
      const w = visibleWidth(line);
      if (w > maxTextWidth) maxTextWidth = w;
    }

    const formattedTitle = ` ${this.title} `;
    const titleWidth = visibleWidth(formattedTitle);

    const innerWidth = this.paddingX * 2 + cubeWidth + gap + maxTextWidth;
    const idealBoxWidth = Math.max(innerWidth + 2, titleWidth + 6);
    const boxWidth = Math.min(width, idealBoxWidth);
    const effectiveInnerWidth = boxWidth - 2;

    const rightDashCount = Math.max(0, boxWidth - titleWidth - 3);
    const topLine = borderChalk("╭─") + titleChalk(formattedTitle) + borderChalk("─".repeat(rightDashCount)) + borderChalk("╮");
    const bottomLine = borderChalk("╰") + borderChalk("─".repeat(boxWidth - 2)) + borderChalk("╯");

    const renderedLines: string[] = [topLine];

    // Padding Y ở trên
    for (let i = 0; i < this.paddingY; i++) {
      renderedLines.push(`${borderChalk("│")}${" ".repeat(effectiveInnerWidth)}${borderChalk("│")}`);
    }

    // Gộp Cube (bên trái) và Text (bên phải) theo từng dòng
    const totalRows = Math.max(coloredIcon.length, contentLines.length);
    const padXStr = " ".repeat(this.paddingX);
    const gapStr = " ".repeat(gap);

    for (let i = 0; i < totalRows; i++) {
      const cubeLine = coloredIcon[i] ?? " ".repeat(cubeWidth);
      let textLine = contentLines[i] ?? "";

      const maxAllowedTextWidth = Math.max(0, effectiveInnerWidth - (this.paddingX * 2) - cubeWidth - gap);
      if (visibleWidth(textLine) > maxAllowedTextWidth) {
        textLine = truncateToWidth(textLine, maxAllowedTextWidth);
      }

      const combinedLeft = `${padXStr}${cubeLine}${gapStr}${textLine}`;
      const combinedVisWidth = visibleWidth(combinedLeft);

      const rightSpaceCount = Math.max(0, effectiveInnerWidth - combinedVisWidth);
      const rightPad = " ".repeat(rightSpaceCount);

      renderedLines.push(`${borderChalk("│")}${combinedLeft}${rightPad}${borderChalk("│")}`);
    }

    // Padding Y ở dưới
    for (let i = 0; i < this.paddingY; i++) {
      renderedLines.push(`${borderChalk("│")}${" ".repeat(effectiveInnerWidth)}${borderChalk("│")}`);
    }

    renderedLines.push(bottomLine);
    return renderedLines;
  };
}

// Hàm hỗ trợ nội suy màu gradient
const interpolateHex = (from: string, to: string, t: number): string => {
  const a = parseInt(from.slice(1), 16);
  const b = parseInt(to.slice(1), 16);
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${[r, g, bl].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};

export const InforBox = InfoBox;