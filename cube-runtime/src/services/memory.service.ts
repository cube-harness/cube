import type { CubeMemoryFinalizeResult, Session } from "@cube/agent";

export type MemoryCompactResult = {
  activated: boolean;
  observed: boolean;
  reflected: boolean;
};

export class MemoryService {
  constructor(
    private readonly session: Session,
    private readonly finalize: (input: {
      threadId: string;
      resourceId: string;
    }) => Promise<CubeMemoryFinalizeResult>,
  ) {}

  async compact(): Promise<MemoryCompactResult> {
    const threadId = this.session.thread.getId();
    if (!threadId) throw new Error("No active thread to compact");
    if (this.session.run.isRunning()) {
      throw new Error("Cannot compact memory while an agent turn is active");
    }

    const result = await this.finalize({
      threadId,
      resourceId: this.session.identity.getResourceId(),
    });
    if (!result.enabled) {
      throw new Error("Observational Memory is disabled");
    }

    return {
      activated: result.activated,
      observed: result.observed,
      reflected: result.reflected,
    };
  }
}
