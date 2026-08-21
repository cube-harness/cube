import type {
  CubeAction,
  CubeEvent,
  CubeEventListener,
} from "./contracts/events.contract.js";

export class ActionDispatcher {
  private readonly listeners = new Set<CubeEventListener>();
  private actionHandler?: (action: CubeAction) => Promise<void>;

  setActionHandler(handler: (action: CubeAction) => Promise<void>): void {
    this.actionHandler = handler;
  }

  subscribe(listener: CubeEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: CubeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("Error in event listener:", err);
      }
    }
  }

  async dispatch(action: CubeAction): Promise<void> {
    if (!this.actionHandler) {
      console.warn("No action handler registered on ActionDispatcher");
      return;
    }
    await this.actionHandler(action);
  }
}
