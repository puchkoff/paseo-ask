import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeModelOf } from "./ask.ts";

test("claude model from provider or model field", () => {
  assert.equal(claudeModelOf({ provider: "claude/claude-sonnet-5[1m]", model: null }), "claude-sonnet-5[1m]");
  assert.equal(claudeModelOf({ provider: "claude", model: "claude-opus-5-5" }), "claude-opus-5-5");
  assert.equal(claudeModelOf({ provider: "claude", model: null }), undefined);
  assert.equal(claudeModelOf({ provider: "codex/gpt-5.5", model: null }), undefined);
  assert.equal(claudeModelOf({ provider: "claude", model: "--evil" }), undefined);
});
