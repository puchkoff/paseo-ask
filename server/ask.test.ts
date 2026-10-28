import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { claudeArgs, createAsk, createJobs, saveUpload, transcript } from "./ask.ts";
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

test("model flag only for a non-default model", () => {
  assert.ok(!claudeArgs().includes("--model"));
  assert.deepEqual(claudeArgs("opus").slice(-2), ["--model", "opus"]);
});

test("job runs in the background and is handed out once", async () => {
  const jobs = createJobs(async () => ({ answer: "hi" }));
  const { jobId } = jobs.start({ turns: [{ role: "user", text: "?" }] });
  assert.equal(jobs.poll({ jobId }).status, "running");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(jobs.poll({ jobId }), { status: "done", answer: "hi" });
  assert.equal(jobs.poll({ jobId }).status, "error");
});

test("effort flag passed through, settings not skipped", () => {
  const args = claudeArgs("claude-opus-5-5", "high");
  assert.deepEqual(args.slice(-4), ["--model", "claude-opus-5-5", "--effort", "high"]);
  assert.ok(!args.includes("--setting-sources"));
});

test("files are listed under their turn", () => {
  const t = transcript([{ role: "user", text: "what is this", files: [{ name: "a.png", path: "/tmp/x/a.png" }] }]);
  assert.match(t, /what is this\n\n\[Attached files.*\n- \/tmp\/x\/a\.png\]/s);
});

test("upload stays inside its dir and keeps the bytes", async () => {
  const root = path.join(os.tmpdir(), `paseo-ask-test-${process.pid}`);
  await mkdir(root);
  const f = await saveUpload({ name: "../../etc/passwd", data: Buffer.from("hi").toString("base64") }, root);
  assert.ok(f.path.startsWith(root + path.sep));
  assert.equal(f.name, "passwd");
  assert.equal(await readFile(f.path, "utf8"), "hi");
  assert.equal((await stat(path.dirname(f.path))).mode & 0o777, 0o700);
  const dot = await saveUpload({ name: "..", data: "" }, root);
  assert.equal(dot.name, "file");
  await rm(root, { recursive: true });
});
