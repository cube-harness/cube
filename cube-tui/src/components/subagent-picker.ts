import { Key, ScrollView, SelectList, Text, fuzzyFilter, getKeybindings, matchesKey,
  truncateToWidth, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import type { SubagentService, SubagentOwner, SubagentSummary, SubagentView, FileMutationResult } from "@cube/runtime";
import { SearchBar } from "./search-bar.js";
import { KeyHint } from "./key-hint.js";
import { appTheme } from "../themes/app.theme.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";
import { renderToolDiff } from "./tool-diff.js";

type View = SubagentView["view"];
const state = (child: SubagentSummary) => (child.status === "completed" ? appTheme.status.success
  : child.status === "failed" ? appTheme.status.error : appTheme.status.warning)(child.status);

export class SubagentPicker implements Component, Focusable {
  private readonly search = new SearchBar();
  private readonly text = new Text("", 0, 0);
  private diff?: FileMutationResult;
  private readonly scroll = new ScrollView({ render: width => this.diff ? renderToolDiff(this.diff, width, true) : this.text.render(width),
    invalidate: () => this.text.invalidate() }, { follow: "none" });
  private list!: SelectList;
  private children: SubagentSummary[] = [];
  private detail?: SubagentView;
  private selected?: string;
  private view: View = "result";
  private generation = 0;
  private detailGeneration = 0;
  private disposed = false;
  private width = 80;
  private confirming = false;
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  get focused() { return this.search.focused; }
  set focused(value: boolean) { this.search.focused = value; }

  constructor(private readonly service: SubagentService, private readonly owner: SubagentOwner,
    private readonly options: { onClose(): void; onChange(): void; onError(error: unknown): void; height(): number }) {
    this.rebuild();
    this.unsubscribe = service.subscribe(() => { void this.refresh(); });
    this.timer = setInterval(() => { this.rebuild(); this.options.onChange(); }, 1000);
    this.timer.unref();
    void this.refresh();
  }
  private rebuild() {
    const selected = this.list?.getSelectedItem()?.value;
    const visible = fuzzyFilter(this.children, this.search.getQuery(), child => `${child.agent} ${child.description} ${child.status}`);
    this.list = new SelectList(visible.map(child => {
      const seconds = Math.max(0, Math.floor(((child.completedAt ?? Date.now()) - (child.startedAt ?? child.createdAt)) / 1000));
      const right = `${appTheme.ui.muted(`${seconds}s`)}  ${state(child)}`;
      const available = Math.max(1, this.width - visibleWidth(right) - 6);
      const left = truncateToWidth(`${child.description} · ${child.agent}${child.isolation === "worktree" ? child.checkoutAvailable ? " · worktree" : " · removed" : ""}`, available);
      return { value: child.id, label: `${left}${" ".repeat(Math.max(0, available - visibleWidth(left)) + 2)}${right}` };
    }), 10, { ...createSelectListTheme(), noMatch: () => appTheme.ui.muted("No child agents for this thread.") });
    this.list.setSelectedIndex(Math.max(0, visible.findIndex(child => child.id === selected)));
    this.list.onSelect = item => { this.selected = item.value; void this.inspect("result"); };
    this.list.onCancel = this.options.onClose;
  }
  private async refresh() {
    const generation = ++this.generation;
    try {
      const children = await this.service.list(this.owner);
      if (this.disposed || generation !== this.generation) return;
      const previous = this.children.find(child => child.id === this.selected);
      this.children = children; this.rebuild(); this.options.onChange();
      const selected = children.find(child => child.id === this.selected);
      if (this.detail && selected && !this.detail.nextCursor &&
        ((previous?.status !== selected.status && ["completed", "failed", "cancelled"].includes(selected.status)) || previous?.checkoutAvailable !== selected.checkoutAvailable))
        await this.inspect(this.view);
    } catch (error) { if (!this.disposed) this.options.onError(error); }
  }
  private async inspect(view: View, next = false) {
    if (!this.selected) return;
    const generation = ++this.detailGeneration;
    try {
      const detail = await this.service.get(this.owner, { id: this.selected, view,
        ...(next && this.detail?.nextCursor ? { cursor: this.detail.nextCursor } : {}) });
      if (this.disposed || generation !== this.detailGeneration) return;
      this.view = view; this.detail = detail;
      this.diff = undefined;
      let content = "text" in detail.data ? detail.data.unavailable ?? detail.data.text : JSON.stringify(detail.data, null, 2);
      if ("text" in detail.data && !detail.data.unavailable) {
        try {
          const parsed = JSON.parse(detail.data.text);
          if (view === "result") content = parsed.text || parsed.error || parsed.unavailable || content;
          if (view === "changes" && typeof parsed.diff === "string" && Array.isArray(parsed.files)) {
            const patches = parsed.diff.split(/(?=^diff --git )/m).filter(Boolean);
            this.diff = { kind: "file_changes", status: "applied", summary: "Changes relative to captured baseline",
              changes: parsed.files.map((file: { path: string; status: string; added: number | null; removed: number | null }, index: number) => ({
                path: file.path, operation: file.status === "A" ? "add" : file.status === "D" ? "delete" : "update",
                status: "applied", added: file.added ?? 0, removed: file.removed ?? 0, diff: patches[index] ?? "", truncated: false,
              })) };
            if (!parsed.files.length) content = "No changes from captured baseline.";
          }
        } catch { /* Oversized JSON evidence stays readable page by page without dropping fragments. */ }
      }
      this.text.setText(content);
      this.scroll.scrollToStart(); this.options.onChange();
    } catch (error) { if (!this.disposed) this.options.onError(error); }
  }
  private async act(remove: boolean) {
    const id = this.selected ?? this.list.getSelectedItem()?.value;
    if (!id) return;
    try {
      if (remove) await this.service.removeWorktree(this.owner, id, true);
      else await this.service.interrupt(this.owner, id);
      if (!this.disposed) { this.confirming = false; await this.refresh(); }
    } catch (error) { if (!this.disposed) this.options.onError(error); }
  }
  handleInput(data: string) {
    if (this.confirming) {
      if (matchesKey(data, "y")) void this.act(true);
      else if (matchesKey(data, "n") || matchesKey(data, Key.escape)) this.confirming = false;
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      ++this.generation; ++this.detailGeneration;
      if (this.detail) { this.detail = undefined; this.selected = undefined; }
      else this.options.onClose();
    } else if (this.detail) {
      if (matchesKey(data, "r")) void this.inspect("result");
      else if (matchesKey(data, "t")) void this.inspect("transcript");
      else if (matchesKey(data, "d")) void this.inspect("changes");
      else if (matchesKey(data, "s")) void this.inspect("status");
      else if (matchesKey(data, "n") && this.detail.nextCursor) void this.inspect(this.view, true);
      else if (matchesKey(data, "k")) void this.act(false);
      else if (matchesKey(data, "x")) this.confirming = true;
      else if (matchesKey(data, Key.up)) this.scroll.scrollBy(-1);
      else if (matchesKey(data, Key.down)) this.scroll.scrollBy(1);
      else if (matchesKey(data, Key.pageUp)) this.scroll.scrollBy(-this.scroll.viewportHeight);
      else if (matchesKey(data, Key.pageDown)) this.scroll.scrollBy(this.scroll.viewportHeight);
    } else {
      const keys = getKeybindings();
      if ((["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown", "tui.select.confirm"] as const)
        .some(binding => keys.matches(data, binding))) this.list.handleInput(data);
      else { this.search.handleInput(data); this.rebuild(); }
    }
    this.options.onChange();
  }
  render(width: number): string[] {
    if (this.width !== width) { this.width = width; this.rebuild(); }
    const title = truncateToWidth(appTheme.ui.text.bold("Subagents"), width);
    if (!this.detail) return [title, ...this.search.render(width), "", ...this.list.render(width), "",
      ...new KeyHint([{ key: "↑/↓", label: "Navigate" }, { key: "Enter", label: "Inspect" }, { key: "Esc", label: "Close" }]).render(width)];
    const child = this.children.find(child => child.id === this.selected);
    const content = this.scroll.render(width).map(line => this.diff ? line : appTheme.ui.muted(line));
    this.scroll.updateLayout(content.length, Math.max(1, this.options.height()), this.options.onChange);
    return [title, truncateToWidth(`${child?.description ?? this.selected} · ${this.view}${child ? ` · ${state(child)}` : ""}`, width), "",
      ...content.slice(this.scroll.scrollTop, this.scroll.scrollTop + this.scroll.viewportHeight), "",
      ...(this.confirming ? [truncateToWidth(appTheme.status.warning("Discard all unintegrated/generated worktree content? y / n"), width)] :
        new KeyHint([{ key: "s/r/t/d", label: "Status/Result/Transcript/Diff" },
          ...(this.detail.nextCursor ? [{ key: "n", label: "Next page" }] : []),
          { key: "k", label: "Interrupt" }, { key: "x", label: "Remove worktree" }, { key: "Esc", label: "Back" }]).render(width))];
  }
  invalidate() { this.list.invalidate(); this.search.invalidate(); }
  dispose() { this.disposed = true; ++this.generation; ++this.detailGeneration; clearInterval(this.timer); this.unsubscribe(); }
}
