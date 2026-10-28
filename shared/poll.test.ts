import assert from "node:assert/strict";
import { test } from "node:test";
import { pollUntilDone } from "./ask.ts";

test("poll failures are retried until the give-up time", async () => {
  let t = 0;
  const opts = { giveUpMs: 1000, now: () => t, sleep: async () => void (t += 400) };
  let calls = 0;
  const flaky = async () => {
    if (++calls <= 2) throw new Error("offline");
    return { status: calls < 4 ? "running" : "done" };
  };
  const seen: string[] = [];
  assert.deepEqual(await pollUntilDone(flaky, (j) => seen.push(j.status), opts), { status: "done" });
  assert.deepEqual(seen, ["running", "done"]);
  await assert.rejects(pollUntilDone(async () => Promise.reject(new Error("offline")), () => {}, opts), /offline/);
});
