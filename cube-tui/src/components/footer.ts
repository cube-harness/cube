// cube-tui/src/components/footer.ts
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getTheme } from "../themes/color.schema.js";
import type { InfoBoxContent } from "./info-box.js";

export class Footer implements Component {
  invalidate = () => {};

  private model: string = "cube-agent";
  private workspace: string = "D:/cube";
  private agentMd: string = "AGENT.md (active)";
  private threadId: string = "thread_default";
  private status: string = "Idle";
  private statusLine: string[] = ["model", "workspace", "agentMd", "threadId"];

  constructor(info?: InfoBoxContent, statusLine?: string[]) {
    if (info) {
      this.setInfo(info);
    }
    if (statusLine && statusLine.length > 0) {
      this.statusLine = statusLine;
    }
  }

  setStatusLine(statusLine: string[]) {
    if (statusLine && statusLine.length > 0) {
      this.statusLine = statusLine;
    }
  }

  getStatusLine(): string[] {
    return [...this.statusLine];
  }

  setStatus(status: string) {
    this.status = status;
  }

  setInfo(info: InfoBoxContent) {
    if (info.model !== undefined) this.model = info.model;
    if (info.workspace !== undefined) this.workspace = info.workspace;
    if (info.agentMd !== undefined) this.agentMd = info.agentMd;
    if (info.threadId !== undefined) this.threadId = info.threadId;
  }

  render(width: number): string[] {
    const theme = getTheme();
    const boxWidth = Math.max(width, 20);
    const divider = theme.muted(" • ");

    const parts: string[] = [];
    for (const key of this.statusLine) {
      if (key === "model" && this.model) parts.push(theme.primary(this.model));
      else if (key === "workspace" && this.workspace) parts.push(theme.primary(this.workspace));
      else if (key === "agentMd" && this.agentMd) parts.push(theme.primary(this.agentMd));
      else if (key === "threadId" && this.threadId) parts.push(theme.primary(this.threadId));
      else if (key === "status" && this.status) parts.push(theme.primary(this.status));
    }

    const fullLine = parts.join(divider);
    const truncated = truncateToWidth(fullLine, boxWidth);
    const visible = visibleWidth(truncated);
    const padding = " ".repeat(Math.max(0, boxWidth - visible));
    return [padding + truncated];
  }
}
