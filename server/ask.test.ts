import assert from "node:assert/strict";
import { test } from "node:test";
import { createAsk, transcript } from "./ask.ts";
import { CommandError } from "./exec.ts";

test("single question is sent as-is", () => {
  assert.equal(transcript([{ role: "user", text: "hi" }]), "hi");
});

test("follow-up carries the history", () => {
  const t = transcript([
    { role: "user", text: "q1" },
    { role: "assistant", text: "a1" },
    { role: "user", text: "q2" },
  ]);
  assert.match(t, /User: q1\n\nAssistant: a1/);
  assert.ok(t.endsWith("q2"));
});

test("returns result, surfaces claude errors from stdout", async () => {
  const ok = createAsk(async () => JSON.stringify({ result: " 42 \n" }), "claude");
  assert.deepEqual(await ok({ turns: [{ role: "user", text: "?" }] }), { answer: "42" });
  const bad = createAsk(async () => {
    throw new CommandError("exit 1", JSON.stringify({ is_error: true, result: "Not logged in" }));
  }, "claude");
  await assert.rejects(bad({ turns: [{ role: "user", text: "?" }] }), /Not logged in/);
});
