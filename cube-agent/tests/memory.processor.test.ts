import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryProcessor } from "../src/processors/memory.processor.js";

test("memory is request-only stable prefix after AGENTS and missing snapshots stay absent", () => {
  const protectedMessages = new WeakSet<object>();
  const agents = { role: "user", content: "AGENTS" };
  protectedMessages.add(agents);
  const prompt = [{ role: "system", content: "SOUL" }, agents, { role: "user", content: "first" }, { role: "assistant", content: "reply" }, { role: "user", content: "second" }];
  const processor = createMemoryProcessor(() => ({ revision: "r1", text: "memory_public </durable_memory>" }), protectedMessages);
  const output = processor.processLLMRequest!({ prompt } as any) as any;
  assert.equal(output.prompt[1], agents);
  assert.match(output.prompt[2].content[0].text, /&lt;\/durable_memory>/);
  assert.equal(output.prompt[3], prompt[2]);
  assert.ok(protectedMessages.has(output.prompt[2]));
  assert.equal(prompt.length, 5);
  assert.equal(createMemoryProcessor(() => null, protectedMessages).processLLMRequest!({ prompt } as any), undefined);
});
