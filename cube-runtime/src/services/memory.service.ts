import type { CubeContext, CompactResult, Session } from "@cube/agent";

export class MemoryService {
  private pending?: Promise<CompactResult>;
  private abortController?: AbortController;
  private closing = false;

  constructor(
    private readonly session: Session,
    private readonly context: Pick<
      CubeContext,
      "compactManual" | "cancel" | "drain" | "isCompacting"
    >,
  ) {}

  isBusy(): boolean {
    return this.pending !== undefined || this.context.isCompacting();
  }
  isManual(): boolean {
    return this.pending !== undefined;
  }
  cancel(): void {
    this.abortController?.abort();
    this.context.cancel();
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.cancel();
    await this.pending?.catch(() => undefined);
    await this.context.drain();
  }

  compact(): Promise<CompactResult> {
    const threadId = this.session.thread.getId();
    if (!threadId) return Promise.reject(new Error("No active thread to compact"));
    if (
      this.closing ||
      this.isBusy() ||
      this.session.run.isRunning() ||
      this.session.approval.isArmed() ||
      this.session.suspensions.hasPending()
    ) {
      return Promise.reject(
        new Error("Finish or cancel the active turn, approval, or suspension before compacting"),
      );
    }
    this.abortController = this.session.run.ensureAbortController();
    const signal = this.abortController.signal;
    this.pending = Promise.resolve().then(() => this.context.compactManual({ threadId, signal }));
    return this.pending.finally(async () => {
      this.pending = undefined;
      this.abortController = undefined;
      this.session.run.reset();
      if (!this.closing) await this.session.drainFollowUpQueue();
    });
  }
}
