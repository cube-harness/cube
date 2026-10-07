import {
  Key,
  ScrollView,
  SelectList,
  Text,
  fuzzyFilter,
  getKeybindings,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { BackgroundService, BackgroundJobSummary, BackgroundJobDetail } from "@cube/runtime";
import { appTheme } from "../themes/app.theme.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";
import { SearchBar } from "./search-bar.js";
import { KeyHint } from "./key-hint.js";

const key = (job: BackgroundJobSummary) => job.id;
const elapsed = (job: BackgroundJobSummary) =>
  `${Math.max(0, Math.floor(((job.completedAt ?? Date.now()) - job.createdAt) / 1000))}s`;
const status = (job: BackgroundJobSummary) => {
  const label = job.status;
  return (
    label === "completed"
      ? appTheme.status.success
      : ["pending", "running", "suspended", "cancelled", "unattached"].includes(label)
        ? appTheme.status.warning
        : appTheme.status.error
  )(label);
};

export class TaskPicker implements Component, Focusable {
  private readonly search = new SearchBar();
  private readonly output = new Text("", 0, 0);
  private readonly logs = new ScrollView(this.output, { follow: "end" });
  private width = 80;
  private jobs: BackgroundJobSummary[] = [];
  private list!: SelectList;
  private detail?: BackgroundJobDetail;
  private disposed = false;
  private loading = false;
  private generation = 0;
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;

  get focused(): boolean {
    return this.search.focused;
  }
  set focused(value: boolean) {
    this.search.focused = value;
  }

  constructor(
    private readonly service: BackgroundService,
    private readonly options: {
      onClose(): void;
      onChange(): void;
      onError(error: unknown): void;
      logHeight(): number;
    },
  ) {
    this.rebuild();
    this.unsubscribe = service.subscribe(() => {
      void this.refresh();
    });
    this.timer = setInterval(() => {
      this.rebuild();
      this.options.onChange();
    }, 1000);
    this.timer.unref();
    void this.refresh();
  }

  private rebuild(selected = this.list?.getSelectedItem()?.value): void {
    const visible = fuzzyFilter(
      this.jobs,
      this.search.getQuery(),
      (job) => `${job.title} ${job.status}`,
    );
    this.list = new SelectList(
      visible.map((job) => {
        const right = `${appTheme.ui.muted(elapsed(job).padStart(7))}  ${status(job)}`;
        const available = Math.max(1, this.width - 4 - visibleWidth(right) - 2);
        const left = truncateToWidth(
          `${new Date(job.createdAt).toLocaleTimeString([], { hour12: false })}  ${job.title}`,
          available,
        );
        return {
          value: key(job),
          label: `${left}${" ".repeat(Math.max(0, available - visibleWidth(left)) + 2)}${right}`,
        };
      }),
      10,
      {
        ...createSelectListTheme(),
        noMatch: () =>
          appTheme.ui.muted(
            this.jobs.length ? "No matching jobs." : "No background tasks or processes.",
          ),
      },
    );
    this.list.setSelectedIndex(
      Math.max(
        0,
        visible.findIndex((job) => key(job) === selected),
      ),
    );
    this.list.onSelect = (item) => {
      void this.inspect(item.value);
    };
    this.list.onCancel = this.options.onClose;
  }

  private async refresh(): Promise<void> {
    if (this.disposed || this.loading) return;
    const generation = ++this.generation;
    try {
      const jobs = await this.service.list();
      const detail = this.detail ? await this.service.get(this.detail) : undefined;
      if (this.disposed || generation !== this.generation) return;
      this.jobs = jobs;
      this.detail = detail;
      this.rebuild();
      this.options.onChange();
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.options.onError(error);
        this.options.onClose();
      }
    }
  }

  private async inspect(value: string): Promise<void> {
    const job = this.jobs.find((job) => key(job) === value);
    if (!job) return;
    const generation = ++this.generation;
    try {
      const detail = await this.service.get(job);
      if (!this.disposed && generation === this.generation) {
        this.detail = detail;
        this.logs.scrollToEnd();
        this.options.onChange();
      }
    } catch (error) {
      if (!this.disposed) this.options.onError(error);
    }
  }

  private async stop(): Promise<void> {
    const job =
      this.detail ?? this.jobs.find((job) => key(job) === this.list.getSelectedItem()?.value);
    if (!job?.canStop || this.loading) return;
    this.loading = true;
    ++this.generation;
    this.options.onChange();
    try {
      await this.service.stop(job);
    } catch (error) {
      if (!this.disposed) this.options.onError(error);
    } finally {
      this.loading = false;
      if (!this.disposed) void this.refresh();
    }
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.cancel") || matchesKey(data, Key.ctrl("c"))) {
      ++this.generation;
      if (this.detail) this.detail = undefined;
      else this.options.onClose();
    } else if (matchesKey(data, "k")) {
      void this.stop();
    } else if (this.detail) {
      if (matchesKey(data, Key.up)) this.logs.scrollBy(-1);
      else if (matchesKey(data, Key.down)) this.logs.scrollBy(1);
      else if (matchesKey(data, Key.pageUp)) this.logs.scrollBy(-this.logs.viewportHeight);
      else if (matchesKey(data, Key.pageDown)) this.logs.scrollBy(this.logs.viewportHeight);
      else if (matchesKey(data, Key.home)) this.logs.scrollToStart();
      else if (matchesKey(data, Key.end)) this.logs.scrollToEnd();
    } else if (
      (
        [
          "tui.select.up",
          "tui.select.down",
          "tui.select.pageUp",
          "tui.select.pageDown",
          "tui.select.confirm",
        ] as const
      ).some((binding) => keys.matches(data, binding))
    ) {
      this.list.handleInput(data);
    } else {
      this.search.handleInput(data);
      this.rebuild();
    }
    this.options.onChange();
  }

  dispose(): void {
    this.disposed = true;
    ++this.generation;
    clearInterval(this.timer);
    this.unsubscribe();
  }

  invalidate(): void {
    this.list.invalidate();
    this.search.invalidate();
  }

  render(width: number): string[] {
    if (this.width !== width) {
      this.width = width;
      this.rebuild();
    }
    const job = this.detail;
    if (!job)
      return [
        ...new Text(appTheme.ui.text.bold("Background Tasks & Processes"), 0, 0).render(width),
        ...this.search.render(width),
        "",
        ...this.list.render(width),
        "",
        ...new KeyHint([
          { key: "↑/↓", label: "Navigate" },
          { key: "Enter", label: "Live log" },
          { key: "k", label: "Kill" },
          { key: "Esc", label: "Close" },
        ]).render(width),
      ];
    const rows = [
      `${appTheme.ui.text.bold("Task")} · ${status(job)} · ${appTheme.ui.muted(elapsed(job))}`,
      job.title,
      job.reason && `Reason: ${job.reason}`,
      job.cwd && `Directory: ${job.cwd}`,
      job.threadId && `Thread: ${job.threadId}${job.ownerDeleted ? " (deleted)" : ""}`,
      `Started: ${new Date(job.createdAt).toLocaleString()}`,
      job.completedAt && `Finished: ${new Date(job.completedAt).toLocaleString()}`,
      job.exitCode != null && `Exit code: ${job.exitCode}`,
      !job.canStop && "Read-only",
      "",
    ].filter((line): line is string => typeof line === "string");
    this.output.setText(job.output || "No output yet.");
    const logs = this.logs.render(width).map((line) => appTheme.ui.muted(line));
    this.logs.updateLayout(logs.length, Math.max(1, this.options.logHeight()), () =>
      this.options.onChange(),
    );
    return [
      ...rows.map((line) => truncateToWidth(line, width)),
      ...logs.slice(this.logs.scrollTop, this.logs.scrollTop + this.logs.viewportHeight),
      ...(job.truncated ? [appTheme.ui.muted("Output truncated.")] : []),
      "",
      ...new KeyHint([
        { key: "↑/↓", label: "Scroll log" },
        ...(job.canStop ? [{ key: "k", label: this.loading ? "Stopping…" : "Kill" }] : []),
        { key: "Esc", label: "Back" },
      ]).render(width),
    ];
  }
}
