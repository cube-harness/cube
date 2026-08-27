import { ConfigStore, SoulStore, CubeHome, createBootstrap, Workspace as Workspace$1 } from '@cube/workspace';
import { Mastra } from '@mastra/core';
import { LibSQLVector, LibSQLStore } from '@mastra/libsql';
import { Observability, MastraStorageExporter } from '@mastra/observability';
import { createCodingAgent } from '@mastra/core/coding-agent';
import { ModelRouterEmbeddingModel } from '@mastra/core/llm';
import { Memory } from '@mastra/memory';
import { createOllama } from 'ollama-ai-provider-v2';
import { AgentController } from '@mastra/core/agent-controller';
import { Workspace, LocalSandbox, WORKSPACE_TOOLS, LocalFilesystem } from '@mastra/core/workspace';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { LoggerTransport } from '@mastra/core/logger';
import { PinoLogger } from '@mastra/loggers';
import { taskUpdateTool, taskCompleteTool, taskCheckTool, taskWriteTool, askUserTool } from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';

"use strict";
const resolveActiveAgentModel = (fallbackModel) => async ({ requestContext, mastra }) => {
  if (!mastra) return fallbackModel;
  return mastra.getAgentById("cube-agent").getModel({ requestContext });
};
const toModel = (model, fallbackModel) => model === "inherit" ? resolveActiveAgentModel(fallbackModel) : model;
const toSemanticRecall = (config) => {
  if (!config.enabled) return false;
  return {
    topK: config.top_k,
    messageRange: config.message_range,
    scope: config.scope,
    ...config.threshold === null ? {} : { threshold: config.threshold }
  };
};
const createMemory = (config, home) => {
  const memoryConfig = config.memory;
  const wm = memoryConfig.working_memory;
  const om = memoryConfig.observational_memory;
  const vector = memoryConfig.vector.enabled ? new LibSQLVector({
    id: "cube-vector",
    url: `file:${home.getMemoryDbPath()}`
  }) : false;
  const embedder = memoryConfig.embedder.enabled ? new ModelRouterEmbeddingModel(memoryConfig.embedder.model) : void 0;
  const generateTitle = !memoryConfig.generate_title.enabled ? false : {
    model: toModel(memoryConfig.generate_title.model, config.model),
    instructions: memoryConfig.generate_title.instructions
  };
  const workingMemory = !wm.enabled ? { enabled: false } : {
    enabled: true,
    scope: wm.scope,
    useStateSignals: wm.use_state_signals,
    agentManaged: wm.agent_managed,
    template: wm.template
  };
  const observationalMemory = !om.enabled ? false : {
    enabled: true,
    scope: om.scope,
    activateAfterIdle: om.activate_after_idle,
    activateOnProviderChange: om.activate_on_provider_change,
    shareTokenBudget: om.share_token_budget,
    temporalMarkers: om.temporal_markers,
    retrieval: !om.retrieval.enabled ? false : {
      vector: om.retrieval.vector,
      scope: om.retrieval.scope
    },
    observation: {
      model: toModel(om.observation.model, config.model),
      messageTokens: om.observation.message_tokens,
      bufferTokens: om.observation.buffer_tokens,
      bufferOnIdle: om.observation.buffer_on_idle,
      bufferActivation: om.observation.buffer_activation,
      blockAfter: om.observation.block_after,
      previousObserverTokens: om.observation.previous_observer_tokens,
      ...om.observation.instruction === null ? {} : { instruction: om.observation.instruction },
      manageWorkingMemory: om.observation.manage_working_memory,
      threadTitle: om.observation.thread_title,
      observeAttachments: om.observation.observe_attachments
    },
    reflection: {
      model: toModel(om.reflection.model, config.model),
      observationTokens: om.reflection.observation_tokens,
      bufferActivation: om.reflection.buffer_activation,
      blockAfter: om.reflection.block_after,
      ...om.reflection.instruction === null ? {} : { instruction: om.reflection.instruction }
    }
  };
  return new Memory({
    vector,
    embedder,
    options: {
      // Cube invariants: keep complete coding-agent history and valid tool pairs.
      readOnly: false,
      lastMessages: Number.MAX_SAFE_INTEGER,
      filterIncompleteToolCalls: true,
      generateTitle,
      workingMemory,
      observationalMemory,
      semanticRecall: toSemanticRecall(
        memoryConfig.semantic_recall
      )
    }
  });
};

"use strict";
const buildModelConfig = (modelId, effort, ollamaBaseUrl) => {
  if (modelId.startsWith("ollama/")) {
    const rawModel = modelId.replace(/^ollama\//, "");
    const rawUrl = ollamaBaseUrl || process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST || "http://127.0.0.1:11434/api";
    const cleanUrl = rawUrl.endsWith("/api") ? rawUrl : `${rawUrl.replace(/\/+$/, "")}/api`;
    const ollamaClient = createOllama({ baseURL: cleanUrl });
    const modelInstance = ollamaClient(rawModel);
    return {
      id: "cube-model",
      model: modelInstance,
      maxRetries: 2,
      enabled: true,
      modelSettings: { temperature: 0.3 }
    };
  }
  const providerOptions = {};
  if (modelId.startsWith("google/gemini-3") && effort && effort !== "none") {
    providerOptions.google = { thinkingConfig: { thinkingLevel: effort } };
  } else if (modelId.startsWith("google/")) {
    if (effort === "high") {
      providerOptions.google = { thinkingConfig: { thinkingBudget: 24576 } };
    } else if (effort === "medium") {
      providerOptions.google = { thinkingConfig: { thinkingBudget: 8192 } };
    } else if (effort === "low") {
      providerOptions.google = { thinkingConfig: { thinkingBudget: 2048 } };
    } else if (effort === "none") {
      providerOptions.google = { thinkingConfig: { thinkingBudget: 0 } };
    }
  } else if (modelId.startsWith("anthropic/")) {
    if (effort && effort !== "none") {
      const budget = effort === "high" ? 16384 : effort === "medium" ? 8192 : 2048;
      providerOptions.anthropic = { thinking: { type: "enabled", budget_tokens: budget } };
    }
  } else if (modelId.startsWith("openai/")) {
    if (effort && effort !== "none") {
      providerOptions.openai = { reasoningEffort: effort };
    }
  } else if (modelId.startsWith("openrouter/")) {
    if (effort) {
      providerOptions.openrouter = { reasoning: { effort } };
    }
  }
  return {
    id: "cube-model",
    model: modelId,
    maxRetries: 2,
    enabled: true,
    modelSettings: { temperature: 0.3 },
    ...Object.keys(providerOptions).length > 0 ? { providerOptions } : {}
  };
};
const updateCubeAgentModel = (agent, modelId, effort, ollamaBaseUrl) => {
  const modelConfig = buildModelConfig(modelId, effort, ollamaBaseUrl);
  agent.model = [modelConfig];
};
const createCubeAgent = async (home, workspace) => {
  const config = await ConfigStore(home).read();
  const soul = await SoulStore(home).read();
  const paths = await workspace.getPaths();
  const effort = config.model_config?.reasoning_effort;
  const ollamaUrl = process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST;
  const modelConfig = buildModelConfig(config.model, effort, ollamaUrl);
  return createCodingAgent({
    id: "cube-agent",
    name: "Cube Agent",
    model: [modelConfig],
    instructions: soul,
    memory: createMemory(config, home),
    basePath: paths.root
  });
};

"use strict";
const createMastraWorkspace = async (workspace) => {
  const paths = await workspace.getPaths();
  return new Workspace({
    filesystem: new LocalFilesystem({ basePath: paths.root }),
    tools: {
      [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: { name: "Read" },
      [WORKSPACE_TOOLS.FILESYSTEM.GREP]: { name: "Grep" },
      [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: { name: "List_File" },
      [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: { name: "Edit_File" },
      [WORKSPACE_TOOLS.FILESYSTEM.MKDIR]: { name: "Create_File" },
      [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: { name: "Delete_File" },
      [WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT]: { name: "File_Stat" }
    },
    sandbox: new LocalSandbox({
      workingDirectory: paths.root,
      env: process.env
    })
  });
};

"use strict";
const createCubeController = async (agent, workspace) => {
  const mastraWorkspace = await createMastraWorkspace(workspace);
  return new AgentController({
    id: "cube-controller",
    agent,
    modes: [{ id: "build", name: "Build", metadata: { default: true } }],
    workspace: mastraWorkspace
  });
};

"use strict";
const logContext = new AsyncLocalStorage();
const runWithCubeLogContext = (context, callback) => logContext.run(
  {
    ...logContext.getStore(),
    ...context
  },
  callback
);
const safeThreadFileName = (threadId) => {
  const normalized = threadId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
  return normalized && normalized !== "." && normalized !== ".." ? normalized : "unknown-thread";
};
class CubeFileTransport extends LoggerTransport {
  constructor(globalLogFile, threadLogDir) {
    super({ objectMode: true });
    this.globalLogFile = globalLogFile;
    this.threadLogDir = threadLogDir;
  }
  globalLogFile;
  threadLogDir;
  _transform(chunk, _encoding, callback) {
    const raw = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const lines = raw.split(/\r?\n/).filter(Boolean);
    void this.writeLines(lines).then(
      () => callback(null, chunk),
      (error) => callback(error instanceof Error ? error : new Error(String(error)))
    );
  }
  async writeLines(lines) {
    for (const line of lines) {
      const record = JSON.parse(line);
      const target = typeof record.threadId === "string" && record.threadId.trim() ? path.join(this.threadLogDir, `${safeThreadFileName(record.threadId)}.log`) : this.globalLogFile;
      await appendFile(target, `${line}
`, "utf8");
    }
  }
}
const createCubeLogger = async (home) => {
  const logDir = home.getLogDir();
  const threadLogDir = path.join(logDir, "threads");
  const globalLogFile = path.join(logDir, "cube.log");
  await mkdir(threadLogDir, { recursive: true });
  await appendFile(globalLogFile, "", "utf8");
  const transport = new CubeFileTransport(globalLogFile, threadLogDir);
  const logger = new PinoLogger({
    name: "cube",
    level: "info",
    prettyPrint: false,
    transports: { file: transport },
    mixin: () => logContext.getStore() ?? {},
    redact: {
      paths: [
        "apiKey",
        "*.apiKey",
        "headers.authorization",
        "requestHeaders.authorization",
        "error.requestBodyValues.contents[*].parts[*].thoughtSignature",
        "requestBodyValues.contents[*].parts[*].thoughtSignature"
      ],
      censor: "[Redacted]"
    }
  });
  return {
    logger,
    close: () => new Promise((resolve, reject) => {
      transport.once("error", reject);
      transport.end(resolve);
    })
  };
};

"use strict";
const createMcpServer = () => new MCPServer({
  name: "My Server",
  version: "1.0.0",
  description: "A server that provides weather data and agent capabilities",
  instructions: "Use the available tools to help users with weather information and data processing tasks.",
  tools: { askUserTool, taskWriteTool, taskCheckTool, taskCompleteTool, taskUpdateTool }
});

"use strict";
const createCubeMastra = async (home, workspace) => {
  const agent = await createCubeAgent(home, workspace);
  const controller = await createCubeController(agent, workspace);
  const logging = await createCubeLogger(home);
  const mcpServer = createMcpServer();
  const mastra = new Mastra({
    agents: { cubeAgent: agent },
    agentControllers: { cubeController: controller },
    logger: logging.logger,
    storage: new LibSQLStore({
      id: "cube-storage",
      url: `file:${home.getMemoryDbPath()}`
    }),
    mcpServers: {
      myServer: mcpServer
    },
    observability: new Observability({
      configs: {
        default: {
          serviceName: "cube-agent",
          exporters: [new MastraStorageExporter()]
        }
      }
    })
  });
  let shutdownPromise;
  return {
    agent,
    controller,
    mastra,
    logger: logging.logger,
    shutdown: () => {
      shutdownPromise ??= (async () => {
        try {
          await mastra.shutdown();
        } finally {
          await logging.close();
        }
      })();
      return shutdownPromise;
    }
  };
};

"use strict";
const home = CubeHome();
await home.ensure();
await createBootstrap(home).run();
const workspace = Workspace$1(home);
const composition = await createCubeMastra(home, workspace);
const cubeAgent = composition.agent;
const cubeController = composition.controller;
const logger = composition.logger;
const mastra = composition.mastra;

export { cubeAgent, cubeController, home, logger, mastra, workspace };
