import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyEvent, claudeArgs, createAsk, createJobs, embedImages, saveUpload, transcript } from "./ask.ts";
import type { RunLines } from "./exec.ts";
import type { Step } from "../shared/ask.ts";

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

// A fake claude that prints the given stream-json events.
const fakeRun = (events: object[], code = 0): RunLines => async (_f, _a, { onLine }) => {
  for (const e of events) onLine(JSON.stringify(e));
  return { code, stderr: "" };
};

test("returns the result event, collects steps, surfaces errors", async () => {
  const ok = createAsk(fakeRun([{ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }, { type: "result", result: " 42 \n" }]), "claude").ask;
  const steps: Step[] = [];
  assert.deepEqual(await ok({ turns: [{ role: "user", text: "?" }] }, steps), { answer: "42", images: {}, stopped: false });
  assert.deepEqual(steps, [{ kind: "text", text: "hi" }]);
  const bad = createAsk(fakeRun([{ type: "result", is_error: true, result: "Not logged in" }], 1), "claude").ask;
  await assert.rejects(bad({ turns: [{ role: "user", text: "?" }] }), /Not logged in/);
  const none = createAsk(fakeRun([], 1), "claude").ask;
  await assert.rejects(none({ turns: [{ role: "user", text: "?" }] }), /exited with code 1/);
});

test("model flag only for a non-default model", () => {
  assert.ok(!claudeArgs().includes("--model"));
  assert.deepEqual(claudeArgs("opus").slice(-2), ["--model", "opus"]);
});

test("job runs in the background and is handed out once", async () => {
  const jobs = createJobs(async () => ({ answer: "hi", images: {}, stopped: false }));
  const { jobId } = jobs.start({ turns: [{ role: "user", text: "?" }] });
  assert.equal(jobs.poll({ jobId }).status, "running");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(jobs.poll({ jobId }), { status: "done", steps: [], answer: "hi", images: {}, stopped: false });
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

test("tool calls pair with their results; thinking and text become steps", () => {
  const steps: Step[] = [];
  applyEvent(steps, { type: "assistant", message: { content: [{ type: "thinking", thinking: "" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } });
  applyEvent(steps, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a\nb", is_error: false }] } });
  assert.deepEqual(applyEvent(steps, { type: "result", result: "done" }), { result: "done", isError: false });
  assert.equal(steps[0].kind, "thinking");
  assert.deepEqual(steps[1], { kind: "tool", id: "t1", name: "Bash", input: '{\n  "command": "ls"\n}', output: "a\nb", error: false });
});

test("embeds local images the answer links, skips the rest", async () => {
  const dir = path.join(os.tmpdir(), `paseo-ask-img-${process.pid}`);
  await mkdir(dir);
  const png = path.join(dir, "a.png");
  await writeFile(png, Buffer.from([1, 2, 3]));
  const imgs = await embedImages(`![x](${png}) ![y](https://e.com/b.png) ![z](${dir}/missing.png) [link](${png})`);
  assert.deepEqual(imgs, { [png]: "data:image/png;base64,AQID" });
  await rm(dir, { recursive: true });
});

test("steer writes a user message mid-turn and stops after the result", async () => {
  const written: string[] = [];
  let ended = false;
  let control: import("./ask.ts").Control = {};
  const run: RunLines = async (_f, _a, { onLine, onStdin, input }) => {
    written.push(input ?? "");
    onStdin?.({ write: (s) => void written.push(s), end: () => void (ended = true), kill: () => {} });
    assert.equal(control.steer?.("also this"), true);
    onLine(JSON.stringify({ type: "result", result: "ok" }));
    assert.equal(control.steer?.("too late") ?? false, false);
    return { code: 0, stderr: "" };
  };
  const steps: Step[] = [];
  const { ask } = createAsk(run, "claude");
  const p = ask({ turns: [{ role: "user", text: "q" }] }, steps, (control = {}));
  assert.deepEqual(await p, { answer: "ok", images: {}, stopped: false });
  assert.equal(ended, true);
  assert.deepEqual(JSON.parse(written[0]), { type: "user", message: { role: "user", content: "q" } });
  assert.equal(JSON.parse(written[1]).message.content, "also this");
  assert.deepEqual(steps, [{ kind: "steer", text: "also this" }]);
});

test("stop kills claude and keeps the text said so far", async () => {
  let killed = false;
  let control: import("./ask.ts").Control = {};
  const run: RunLines = async (_f, _a, { onLine, onStdin }) => {
    onStdin?.({ write: () => {}, end: () => {}, kill: () => void (killed = true) });
    onLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }));
    control.stop?.();
    return { code: null, stderr: "" };
  };
  const out = await createAsk(run, "claude").ask({ turns: [{ role: "user", text: "q" }] }, [], (control = {}));
  assert.equal(killed, true);
  assert.deepEqual(out, { answer: "partial", images: {}, stopped: true });
});

// A fake long-lived claude: answers each user message after a tick, exits when stdin closes.
function fakeClaude() {
  const procs: { args: readonly string[]; writes: string[]; killed: boolean }[] = [];
  const run: RunLines = (_f, args, { input, onLine, onStdin }) =>
    new Promise((resolve) => {
      const proc = { args, writes: [] as string[], killed: false };
      procs.push(proc);
      const answer = (s: string) => {
        proc.writes.push(s);
        setTimeout(() => onLine(JSON.stringify({ type: "result", result: `re: ${JSON.parse(s).message.content}` })), 0);
      };
      answer(input ?? "");
      onStdin?.({ write: answer, end: () => void setTimeout(() => resolve({ code: 0, stderr: "" }), 0), kill: () => ((proc.killed = true), resolve({ code: null, stderr: "" })) });
    });
  return { run, procs };
}
const sent = (s: string) => JSON.parse(s).message.content;

test("a thread keeps its claude; model change, Clear and steer start a new one", async () => {
  const { run, procs } = fakeClaude();
  const { ask, dispose } = createAsk(run, "claude");
  const q1 = { role: "user" as const, text: "q1" };
  const a1 = await ask({ threadId: "t", turns: [q1] });
  assert.equal(a1.answer, "re: q1");
  const q2 = { role: "user" as const, text: "q2" };
  const turns2 = [q1, { role: "assistant" as const, text: a1.answer }, q2];
  assert.equal((await ask({ threadId: "t", turns: turns2 })).answer, "re: q2");
  assert.equal(procs.length, 1, "follow-up reuses the process");
  assert.equal(sent(procs[0].writes[1]), "q2", "only the new question is written");

  await ask({ threadId: "t", turns: [...turns2, { role: "assistant", text: "re: q2" }, { role: "user", text: "q3" }], model: "opus" });
  assert.equal(procs.length, 2, "model change starts a new process");
  assert.match(sent(procs[1].writes[0]), /Conversation so far/);

  await ask({ threadId: "t", turns: [{ role: "user", text: "fresh" }], model: "opus" });
  assert.equal(procs.length, 3, "Clear starts a new process");

  const control: import("./ask.ts").Control = {};
  const p = ask({ threadId: "t", turns: [{ role: "user", text: "fresh" }, { role: "assistant", text: "re: fresh" }, { role: "user", text: "q" }], model: "opus" }, [], control);
  assert.equal(control.steer?.("more"), true);
  await p;
  await ask({ threadId: "t", turns: [{ role: "user", text: "x" }, { role: "assistant", text: "y" }, { role: "user", text: "z" }, { role: "assistant", text: "w" }, { role: "user", text: "v" }], model: "opus" });
  assert.equal(procs.length, 4, "a steered process is not reused");
  dispose();
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(procs.every((x, i) => i < 3 || x.killed), "dispose kills the idle process");
});

test("unpolled finished jobs are dropped after an hour; steer gets file paths", async () => {
  let t = 0;
  let steered = "";
  const jobs = createJobs(async (_i, _s, control) => {
    control.steer = (text) => ((steered = text), true);
    await new Promise((r) => setTimeout(r, 0));
    return { answer: "a", images: {}, stopped: false };
  }, () => t);
  const { jobId } = jobs.start({ turns: [{ role: "user", text: "?" }] });
  jobs.steer({ jobId, text: "see", files: [{ name: "a.png", path: "/tmp/x/a.png" }] });
  assert.match(steered, /^see\n\n\[Attached files.*- \/tmp\/x\/a\.png\]$/s);
  await new Promise((r) => setTimeout(r, 0));
  t = 61 * 60_000;
  jobs.start({ turns: [{ role: "user", text: "?" }] });
  assert.equal(jobs.poll({ jobId }).status, "error");
});
