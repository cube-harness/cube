import { tools } from "@/tools/tool-registry.js";

describe("tool registry", () => {
  it("exposes soul tools through the resolved tool list", () => {
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toContain("get_soul");
    expect(toolNames).toContain("update_soul");
    expect(toolNames).not.toContain("update_soul_vibe");
  });
});
