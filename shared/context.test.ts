import assert from "node:assert/strict";
import { test } from "node:test";
import { agentContext, MAX_CONTEXT } from "./context.ts";

test("keeps only user and agent messages, in order", () => {
  const out = agentContext(
    [
      { item: { type: "user_message", text: "fix the map" } },
      { item: { type: "tool_call" } },
      { item: { type: "reasoning", text: "thinking" } },
      { item: { type: "assistant_message", text: "done" } },
      { item: { type: "assistant_message", text: "  " } },
    ],
    "/home/x",
  );
  assert.match(out, /working in \/home\/x/);
  assert.match(out, /User: fix the map\n\nAgent: done\n<\/agent-conversation>/);
  assert.doesNotMatch(out, /thinking/);
});

test("empty without messages; long chat keeps its end", () => {
  assert.equal(agentContext([{ item: { type: "tool_call" } }]), "");
  const out = agentContext([{ item: { type: "user_message", text: "a".repeat(MAX_CONTEXT) + "END" } }]);
  assert.match(out, /END\n<\/agent-conversation>/);
  assert.ok(out.length < MAX_CONTEXT + 400);
});
