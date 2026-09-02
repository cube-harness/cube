import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import type { WorkspaceManager } from "@cube/workspace";
import { createCubeController } from "../src/agents/controller.js";
import { cubeAskUserTool } from "../src/tools/ask-user.tool.js";

test("registered Controller inherits the single storage owned by Mastra", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-controller-test-"));
  const agent = new Agent({
    id: "cube-agent",
    name: "Cube Agent",
    instructions: "Test agent",
    model: "openai/gpt-4o-mini",
  });
  const workspace = {
    getPaths: async () => ({ root }),
  } as unknown as WorkspaceManager;
  const storage = new LibSQLStore({ id: "cube-storage", url: ":memory:" });
  let mastra: Mastra | undefined;

  try {
    const controller = await createCubeController(agent, workspace);
    mastra = new Mastra({
      storage,
      agentControllers: { cubeController: controller },
    });

    await controller.init();

    assert.equal(controller.getMastra(), mastra);
    assert.equal(controller.getMastra()?.getStorage(), mastra.getStorage());
    assert.equal(mastra.getAgentById("cube-agent"), agent);

    const session = await controller.createSession({ resourceId: root });
    await session.permissions.setForCategory({ category: "other", policy: "allow" });
    await session.permissions.setForTool({ toolName: "execute_command", policy: "ask" });

    assert.equal(session.resolveToolApproval("ask_user"), "allow");
    assert.equal(session.resolveToolApproval("execute_command"), "ask");

    const toolsets = await (
      controller as unknown as {
        buildToolsets: (
          session: typeof session,
          requestContext: undefined,
        ) => Promise<{
          controllerBuiltIn: Record<string, unknown>;
          controller?: Record<string, unknown>;
        }>;
      }
    ).buildToolsets(session, undefined);
    assert.equal(toolsets.controllerBuiltIn.ask_user, undefined);
    assert.equal(toolsets.controller?.ask_user, cubeAskUserTool);
  } finally {
    await mastra?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
