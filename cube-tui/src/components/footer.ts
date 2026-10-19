// cube-tui/src/components/footer.ts
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { appTheme } from "../themes/app.theme.js";
import type { InfoBoxContent } from "./info-box.js";

export class Footer implements Component {
  invalidate = () => {};

  private model: string = "cube-agent";
  private workspace: string = "D:/cube";
  private agentMd: string = "AGENT.md (active)";
  private threadTitle?: string;
  private threadId: string = "thread_default";
  private status: string = "Idle";
  private backgroundCount = 0;
  private subagentCount = 0;
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

  getStatus(): string {
    return this.status;
  }

  setActivityCounts(background: number, subagents: number): void {
    this.backgroundCount = background;
    this.subagentCount = subagents;
  }

  setInfo(info: InfoBoxContent) {
    if (info.model !== undefined) this.model = info.model;
    if (info.workspace !== undefined) this.workspace = info.workspace;
    if (info.agentMd !== undefined) this.agentMd = info.agentMd;
    if ("threadTitle" in info) this.threadTitle = info.threadTitle;
    if (info.threadId !== undefined) this.threadId = info.threadId;
  }

  render(width: number): string[] {
    const boxWidth = Math.max(width, 0);
    const divider = appTheme.ui.muted(" • ");

    const parts: string[] = [];
    for (const key of this.statusLine) {
      if (key === "model" && this.model) parts.push(appTheme.ui.primary(this.model));
      else if (key === "workspace" && this.workspace) parts.push(appTheme.ui.primary(this.workspace));
      else if (key === "agentMd" && this.agentMd) parts.push(appTheme.ui.primary(this.agentMd));
      else if (key === "threadTitle" && this.threadTitle) parts.push(appTheme.ui.primary(this.threadTitle));
      else if (key === "threadId" && this.threadId) parts.push(appTheme.ui.primary(this.threadId));
      else if (key === "status" && this.status) parts.push(appTheme.ui.primary(this.status));
    }

    const activities: string[] = [];
    if (this.backgroundCount > 0) activities.push(`(${this.backgroundCount}) background running`);
    if (this.subagentCount > 0) activities.push(`(${this.subagentCount}) subagent running`);
    const left = truncateToWidth(appTheme.ui.muted(activities.join(" · ")), boxWidth);
    const right = truncateToWidth(
      parts.join(divider),
      Math.max(0, boxWidth - visibleWidth(left) - (left ? 1 : 0)),
    );
    const padding = " ".repeat(Math.max(0, boxWidth - visibleWidth(left) - visibleWidth(right)));
    return [left + padding + right];
  }
}
