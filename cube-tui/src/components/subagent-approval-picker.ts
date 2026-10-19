import { SelectList, type Component, type Focusable } from "@earendil-works/pi-tui";
import { ApprovalPicker, type ToolApprovalDecision } from "./approval-picker.js";
import { KeyHint } from "./key-hint.js";
import { formatBinding, matchesBinding } from "../keybindings.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";

export interface SubagentApprovalRequest {
  id: string;
  agent: string;
  description?: string;
  toolName: string;
  args: unknown;
  directory?: string;
  onDecision(decision: ToolApprovalDecision): void;
}

export class SubagentApprovalPicker implements Component, Focusable {
  focused = true;
  private list!: SelectList;
  private approval?: ApprovalPicker;
  private readonly hint = new KeyHint([
    { key: `${formatBinding("tui.select.up")}/${formatBinding("tui.select.down")}`, label: "Select subagent" },
    { key: `${formatBinding("tui.select.cancel")}/${formatBinding("cube.subagent.approvals")}`, label: "Close without deciding" },
  ]);

  constructor(
    requests: SubagentApprovalRequest[],
    private readonly onClose: () => void,
  ) {
    this.setRequests(requests);
  }

  setRequests(requests: SubagentApprovalRequest[]): void {
    const selected = this.list?.getSelectedItem()?.value;
    this.list = new SelectList(requests.map(request => ({
      value: request.id, label: `${request.description ?? request.agent} · ${request.toolName}`,
    })), 5, createSelectListTheme());
    this.list.setSelectedIndex(Math.max(0, requests.findIndex(request => request.id === selected)));
    const select = () => {
      const request = requests.find(request => request.id === this.list.getSelectedItem()?.value);
      this.approval = request && new ApprovalPicker({
        ...request,
        title: `${request.agent} needs approval for ${request.toolName}`,
      });
    };
    this.list.onSelectionChange = select;
    select();
  }

  handleInput(data: string): void {
    if (matchesBinding(data, "tui.select.cancel")) this.onClose();
    else if ((["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown"] as const)
      .some(key => matchesBinding(data, key))) this.list.handleInput(data);
    else this.approval?.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
    this.approval?.invalidate();
    this.hint.invalidate();
  }

  render(width: number): string[] {
    return [
      ...this.list.render(width), "",
      ...(this.approval?.render(width) ?? []), "",
      ...this.hint.render(width),
    ];
  }
}
