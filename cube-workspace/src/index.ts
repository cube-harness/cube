// Export Home & Paths
export { HomeManager, CubeHome } from "./home-manager.js";
export type { HomeOptions, CubeRoot } from "./home-manager.js";

// Export Workspace Manager
export { WorkspaceManager, CubeWorkspace, ContextFile } from "./workspace-manager.js";
export type { CubeProject } from "./workspace-manager.js";

// Export Stores & Bootstrap
export {
  Store,
  ConfigStore,
  ModelCatalogStore,
  WorkspaceRegistryStore,
  SoulStore,
  HistoryStore,
  AgentsStore,
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
