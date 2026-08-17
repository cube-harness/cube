import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { createCubeWorkspace } from '@cube/workspace';
import { createCodingAgent } from '@mastra/core/coding-agent';
import { createOllama } from 'ollama-ai-provider-v2';
import { Memory } from '@mastra/memory';
import { Workspace, WORKSPACE_TOOLS, LocalSandbox, LocalFilesystem } from '@mastra/core/workspace';

"use strict";
const createModelResolver = (ollamaBaseUrl) => {
  const ollama = createOllama({ baseURL: ollamaBaseUrl, compatibility: "strict" });
  return (modelId) => {
    if (!modelId.startsWith("ollama/")) {
      return modelId;
    }
    const localModelId = modelId.slice("ollama/".length);
    if (!localModelId) {
      throw new Error("Ollama model ID must use the format ollama/<model>.");
    }
    return ollama(localModelId);
  };
};
const createAgentModelList = (input) => {
  const primary = {
    model: input.resolveModel(input.active.selection.modelId),
    maxRetries: 2,
    ...input.active.providerOptions ? { providerOptions: input.active.providerOptions } : {}
  };
  const models = [primary];
  if (input.fallbackModel && input.fallbackModel !== input.active.selection.modelId) {
    models.push({
      model: input.resolveModel(input.fallbackModel),
      maxRetries: 1
    });
  }
  return models;
};
const createDefaultAgent = (input) => {
  return createCodingAgent({
    id: "cube",
    name: "Cube",
    instructions: () => input.getInstructions(),
    model: () => createAgentModelList({
      active: input.getModelSelection(),
      fallbackModel: input.fallbackModel,
      resolveModel: input.resolveModel
    }),
    memory: input.memory,
    workspace: input.workspace
  });
};

"use strict";
const createMemory = (input) => {
  const config = input.config;
  const working = config.working_memory;
  const observational = config.observational_memory;
  return new Memory({
    storage: input.storage,
    options: {
      semanticRecall: config.semantic_recall,
      workingMemory: working.enabled ? {
        enabled: true,
        scope: working.scope,
        useStateSignals: working.use_state_signals,
        agentManaged: working.agent_managed,
        template: working.template
      } : { enabled: false },
      observationalMemory: observational.enabled ? {
        enabled: true,
        scope: observational.scope,
        model: observational.model === "inherit" ? input.actorModel : input.resolveModel(observational.model),
        activateAfterIdle: observational.activate_after_idle,
        activateOnProviderChange: observational.activate_on_provider_change,
        shareTokenBudget: observational.share_token_budget,
        temporalMarkers: observational.temporal_markers,
        retrieval: observational.retrieval,
        observation: {
          messageTokens: observational.observation.message_tokens,
          bufferTokens: observational.observation.buffer_tokens,
          bufferActivation: observational.observation.buffer_activation,
          blockAfter: observational.observation.block_after,
          previousObserverTokens: observational.observation.previous_observer_tokens,
          maxTokensPerBatch: observational.observation.max_tokens_per_batch,
          manageWorkingMemory: observational.observation.manage_working_memory,
          observeAttachments: observational.observation.observe_attachments,
          modelSettings: observational.observation.model_settings
        },
        reflection: {
          observationTokens: observational.reflection.observation_tokens,
          bufferActivation: observational.reflection.buffer_activation,
          blockAfter: observational.reflection.block_after,
          modelSettings: observational.reflection.model_settings
        }
      } : false
    }
  });
};
const finalizeMemory = async (memory, input) => {
  const engine = await memory.omEngine;
  if (!engine) {
    return { status: "disabled" };
  }
  const result = await engine.finalize(input);
  if (!result.activated && !result.observed && !result.reflected) {
    return { status: "no-op" };
  }
  return {
    status: "completed",
    activated: result.activated,
    observed: result.observed,
    reflected: result.reflected
  };
};

"use strict";
const createAgentWorkspace = (logger, cwd) => {
  return new Workspace({
    filesystem: new LocalFilesystem({ basePath: cwd }),
    sandbox: new LocalSandbox({ workingDirectory: cwd }),
    bm25: true,
    lsp: true,
    tools: {
      hooks: {
        beforeToolCall: ({ toolName, input }) => logger.debug("Tool called", { type: "tool_event", toolName, input }),
        afterToolCall: ({ toolName, error }) => {
          if (error) logger.error("Tool failed", { type: "tool_event", toolName, error });
        }
      },
      [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
        requireApproval: true,
        backgroundProcesses: {
          onStdout: (data, { pid }) => logger.debug(data, { type: "process_output", stream: "stdout", pid }),
          onStderr: (data, { pid }) => logger.debug(data, { type: "process_output", stream: "stderr", pid }),
          onExit: ({ pid, exitCode }) => logger.info("Process exited", { type: "process_event", pid, exitCode })
        }
      }
    }
  });
};

"use strict";
const workspace = createCubeWorkspace();
workspace.initialize();
const configResult = workspace.config.read();
const config = configResult.ok ? configResult.value : {};
const targetDir = process.env.INIT_CWD || process.cwd();
const identity = workspace.identity.resolve(targetDir);
const resolveModel = createModelResolver(config.providers?.ollama?.base_url ?? "http://127.0.0.1:11434/api");
const storage = new LibSQLStore({
  id: "cube-storage",
  url: `file:${workspace.agentRuntime.memoryDatabase.replace(/\\/g, "/")}`
});
const agentWorkspace = createAgentWorkspace(identity.canonicalPath);
const memory = createMemory({
  storage,
  config: config.memory ?? {
    working_memory: {
      enabled: false
    },
    observational_memory: {
      enabled: false
    }
  },
  actorModel: resolveModel(config.model ?? "google/gemini-2.0-flash"),
  resolveModel
});
const cubeAgent = createDefaultAgent({
  getInstructions: () => {
    const soul = workspace.soul.snapshot();
    return soul.ok ? soul.value : "You are Cube, an expert coding assistant.";
  },
  getModelSelection: () => ({
    selection: {
      modelId: config.model ?? "google/gemini-2.0-flash",
      config: config.model_config ?? {}
    }
  }),
  fallbackModel: config.fallback_model ?? null,
  memory,
  resolveModel,
  workspace: agentWorkspace
});
const mastra = new Mastra({
  agents: {
    cube: cubeAgent
  },
  memory: {
    cube: memory
  },
  storage,
  workspace: agentWorkspace
});

export { mastra };
