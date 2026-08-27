import type { CubeUIAction, CubeUIEvent, CubeUIEventListener } from "./contracts/ui.contract.js";

export class ActionDispatcher {
  private readonly listeners = new Set<CubeUIEventListener>();
  private actionHandler?: (action: CubeUIAction) => Promise<void>;

  setActionHandler(handler: (action: CubeUIAction) => Promise<void>): void {
    this.actionHandler = handler;
  }

  subscribe(listener: CubeUIEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: CubeUIEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("Error in event listener:", err);
      }
    }
  }

  async dispatch(action: CubeUIAction): Promise<void> {
    if (!this.actionHandler) {
      console.warn("No action handler registered on ActionDispatcher");
      return;
    }
    await this.actionHandler(action);
  }
}
