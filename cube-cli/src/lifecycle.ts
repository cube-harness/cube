export interface CliLifecycleDependencies {
  isRunning: () => boolean;
  abort: () => void;
  stopTui: () => void;
  closeRuntime: () => Promise<void>;
}

export const createCliLifecycle = (
  dependencies: CliLifecycleDependencies,
) => {
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= Promise.resolve().then(async () => {
      dependencies.stopTui();
      await dependencies.closeRuntime();
    });
    return shutdownPromise;
  };

  const cancel = async (): Promise<void> => {
    if (dependencies.isRunning()) {
      dependencies.abort();
      return;
    }
    await shutdown();
  };

  return { cancel, shutdown };
};
