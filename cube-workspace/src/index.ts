// Export Home & Paths
export { Home, CubeHome, resolveCubeHome } from "./home.js";
export type { HomeOptions, CubeWorkspacePaths } from "./home.js";

// Export Workspace Manager
export { WorkspaceManager, Workspace } from "./workspace.js";
export type { WorkspacePaths } from "./workspace.js";

// Export Stores & Bootstrap
export {
  Store,
  ConfigStore,
  ModelCatalogStore,
  WorkspaceRegistryStore,
  SoulStore,
  HistoryStore,
} from "./store/store.js";
export { Bootstrap, createBootstrap, loadEnv } from "./bootstrap.js";

// Export Model Manager
export { ModelManager, type ProviderCatalogItem } from "./model-manager.js";

// Export Schemas & Types
export * from "./schemas/config.schema.js";
export * from "./schemas/workspace.schema.js";
export * from "./schemas/model-catalog.schema.js";
export * from "./schemas/history.schema.js";
export { providers as snapshotProviders } from "@opencode-ai/models/snapshot";
export * from "./constants.js";
