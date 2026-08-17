// cube-tui/src/components/footer.ts
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { getTheme } from "../themes/color.schema.js";
import type { InfoBoxContent } from "./info-box.js";

export class Footer implements Component {
  invalidate = () => {};

  private model: string = "cube-agent";
  private workspace: string = "D:/cube";
  private agentMd: string = "AGENT.md (active)";
  private threadId: string = "thread_default";

  constructor(info?: InfoBoxContent) {
    if (info) {
      this.setInfo(info);
    }
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

    // Chỉ hiển thị giá trị thuần túy (không kèm nhãn prefix): model │ workspace │ agentMd │ threadId
    const fullLine = `${theme.primary(this.model)}${divider}${theme.primary(this.workspace)}${divider}${theme.primary(this.agentMd)}${divider}${theme.primary(this.threadId)}`;

    return [truncateToWidth(fullLine, boxWidth)];
  }
}
