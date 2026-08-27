import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { CubeHome, Workspace, createBootstrap } from "@cube/workspace";

test("createCubeMastra composes the agent and controller into one Mastra runtime", async () => {
  const module = await import("../src/bootstrap.js").catch(() => ({}));
  assert.equal(
    typeof (module as { createCubeMastra?: unknown }).createCubeMastra,
    "function",
    "createCubeMastra must exist",
  );

  const root = await mkdtemp(path.join(os.tmpdir(), "cube-agent-bootstrap-test-"));
  const home = CubeHome({ cubeHome: path.join(root, ".cube") });
  await home.ensure();
  await createBootstrap(home).run();
  const workspace = Workspace(home, root);
  const createCubeMastra = (
    module as {
      createCubeMastra: (
        home: typeof home,
        workspace: typeof workspace,
      ) => Promise<{
        agent: unknown;
        controller: { getMastra: () => unknown };
        mastra: {
          getAgentById: (id: string) => unknown;
          getStorage: () => unknown;
        };
        shutdown: () => Promise<void>;
      }>;
    }
  ).createCubeMastra;

  let composition:
    | Awaited<ReturnType<typeof createCubeMastra>>
    | undefined;

  try {
    composition = await createCubeMastra(home, workspace);

    assert.equal(composition.controller.getMastra(), composition.mastra);
    assert.equal(composition.mastra.getAgentById("cube-agent"), composition.agent);
    assert.ok(composition.mastra.getStorage());
  } finally {
    await composition?.shutdown();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
