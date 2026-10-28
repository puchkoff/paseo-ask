import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AskFile, Effort, Step, Turn } from "../shared/ask.ts";
import type { RunLines } from "./exec.ts";

// Web research and tool runs take minutes.
const TIMEOUT_MS = 600_000;
const SYSTEM_PROMPT =
  "You answer questions in a chat window. Use tools (web search, fetch, shell, MCP) whenever they help. Be direct. Answers render as Markdown, tables included. To show an image file, embed it as a Markdown image with its absolute path, e.g. ![screenshot](/tmp/shot.png).";

// Same setup as an agent in the main window: user settings, skills, plugins, MCP and full tooling,
// with no permission prompts (nobody can answer them). Costs ~2 s per new process over a bare call.
// No saved session on disk: a thread's process lives in memory only (see createAsk).
export function claudeArgs(model?: string, effort?: Effort): string[] {
  return [
    "-p",
    "--no-session-persistence",
    "--permission-mode",
    "bypassPermissions",
    "--append-system-prompt",
    SYSTEM_PROMPT,
    // stream-json both ways: the question goes in as a user message, and steers follow on stdin.
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--effort", effort] : []),
  ];
}

export function withFiles(t: Pick<Turn, "text" | "files">): string {
  if (!t.files?.length) return t.text;
  return `${t.text}\n\n[Attached files, read them with your tools:\n${t.files.map((f) => `- ${f.path}`).join("\n")}]`;
}

export function transcript(turns: Turn[]): string {
  if (turns.length === 1) return withFiles(turns[0]);
  const history = turns.slice(0, -1).map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${withFiles(t)}`);
  return `Conversation so far:\n\n${history.join("\n\n")}\n\nAnswer the latest question:\n\n${withFiles(turns[turns.length - 1])}`;
}

// shortcut: files stay in the OS temp dir until it is cleaned; add expiry if they pile up.
// mkdtemp: a fresh 0700 dir per upload, so daemons of other Linux users neither collide on a shared
// parent (EACCES) nor read each other's files.
export async function saveUpload({ name, data }: { name: string; data: string }, root = os.tmpdir()) {
  const dir = await mkdtemp(path.join(root, "paseo-ask-"));
  // basename + safe charset: the name comes from the client and must not escape dir.
  const safe = path.basename(name).replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/, "") || "file";
  const file = path.join(dir, safe);
  await writeFile(file, Buffer.from(data, "base64"));
  return { name: safe, path: file };
}

// Tool payloads can be huge; the window shows a preview.
const MAX_IO = 4000;
const clip = (v: string) => (v.length > MAX_IO ? `${v.slice(0, MAX_IO)}\n… (${v.length - MAX_IO} more chars)` : v);
const asText = (v: unknown): string =>
  typeof v === "string"
    ? v
    : Array.isArray(v)
      ? v.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "[" + String((c as { type?: unknown })?.type ?? "item") + "]")).join("\n")
      : JSON.stringify(v, null, 2);

type Block = { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
type Event = { type?: string; message?: { content?: Block[] | string }; result?: string; is_error?: boolean };

// Folds one stream-json event into steps. Returns the final result once the "result" event arrives.
export function applyEvent(steps: Step[], event: Event): { result?: string; isError?: boolean } {
  if (event.type === "result") return { result: event.result ?? "", isError: !!event.is_error };
  const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
  for (const b of blocks) {
    if (event.type === "assistant" && b.type === "thinking") steps.push({ kind: "thinking", text: b.thinking ?? "" });
    else if (event.type === "assistant" && b.type === "text" && b.text?.trim()) steps.push({ kind: "text", text: b.text });
    else if (event.type === "assistant" && b.type === "tool_use")
      steps.push({ kind: "tool", id: b.id ?? "", name: b.name ?? "tool", input: clip(asText(b.input ?? {})) });
    else if (event.type === "user" && b.type === "tool_result") {
      const tool = steps.find((x): x is Extract<Step, { kind: "tool" }> => x.kind === "tool" && x.id === b.tool_use_id);
      if (tool) Object.assign(tool, { output: clip(asText(b.content ?? "")), error: !!b.is_error });
    }
  }
  return {};
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const MAX_IMAGE = 8 * 1024 * 1024;

// Local images the answer embeds (![alt](/abs/or/~/path.png)) as data: URIs, keyed by the path as written.
export async function embedImages(answer: string, home = os.homedir()): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [, raw] of answer.matchAll(/!\[[^\]]*\]\(<?([^)\s>]+)>?\)/g)) {
    if (out[raw] || !IMAGE_EXT.test(raw) || !(raw.startsWith("/") || raw.startsWith("~/"))) continue;
    const file = raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw;
    try {
      if ((await stat(file)).size > MAX_IMAGE) continue;
      const ext = raw.split(".").pop()!.toLowerCase();
      out[raw] = `data:${MIME[ext]};base64,${(await readFile(file)).toString("base64")}`;
    } catch {
      // Missing or unreadable: the image just doesn't show.
    }
  }
  return out;
}

const userMessage = (text: string) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;

// control.steer is set while the turn runs; control.stop ends it.
export type Control = { steer?: (text: string) => boolean; stop?: () => void };
export type AskInput = { threadId?: string; turns: Turn[]; model?: string; effort?: Effort };
export type Answer = { answer: string; images: Record<string, string>; stopped: boolean };

// An idle thread keeps its claude this long, so a follow-up sees earlier tool results.
const IDLE_MS = 15 * 60_000;

type Turning = {
  steps: Step[];
  control: Control;
  final?: { result?: string; isError?: boolean };
  steered?: boolean;
  stopped?: boolean;
  error?: string;
  timer: NodeJS.Timeout;
  settle: (r: Promise<Answer>) => void;
};
// seen: turns this process has in context (question + answer per finished turn).
// retired: stdin closed, no new turns; it exits after the current one.
type Proc = { threadId?: string; key: string; seen: number; job: Turning | null; io?: Io; retired?: boolean; idle?: NodeJS.Timeout; lastLine: string };
type Io = { write(s: string): void; end(): void; kill(): void };

// One claude per thread, fed over stream-json stdin. A new process (thread resent as text) starts when
// there is none, the model/effort or the thread changed (Clear, app reload), or the old one is busy.
// A steer can land just as a turn ends and start one more turn, so a steered process is retired
// after its turn and the last result wins; the next question gets a fresh process.
export function createAsk(run: RunLines, claude: string) {
  const threads = new Map<string, Proc>();

  const retire = (p: Proc) => {
    if (p.threadId && threads.get(p.threadId) === p) threads.delete(p.threadId);
    clearTimeout(p.idle);
    if (!p.retired) p.io?.end();
    p.retired = true;
  };

  async function result(job: Turning): Promise<Answer> {
    if (job.stopped) {
      const said = job.steps.filter((x): x is Extract<Step, { kind: "text" }> => x.kind === "text").map((x) => x.text);
      return { answer: said.join("\n\n"), images: {}, stopped: true };
    }
    if (job.error) throw new Error(job.error);
    if (job.final?.isError) throw new Error(job.final.result || "claude returned an error");
    const answer = (job.final?.result ?? "").trim();
    return { answer, images: await embedImages(answer), stopped: false };
  }

  const finish = (p: Proc, job: Turning, error?: string) => {
    if (p.job !== job) return;
    clearTimeout(job.timer);
    p.job = null;
    job.control.steer = job.control.stop = undefined;
    if (job.final?.result === undefined && !job.error) job.error = error;
    job.settle(result(job));
    if (!p.retired && p.threadId && threads.get(p.threadId) === p) p.idle = setTimeout(() => retire(p), IDLE_MS);
    else retire(p);
  };

  const onLine = (p: Proc, line: string) => {
    if (!line.trim()) return;
    p.lastLine = line;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return; // Not JSON (a stray log line).
    }
    const job = p.job;
    if (!job) return; // A retired process's extra turn.
    const r = applyEvent(job.steps, event as Event);
    if (r.result === undefined) return;
    job.final = r;
    p.seen += 2;
    if (job.steered) retire(p);
    else finish(p, job);
  };

  // Starts claude for p; p already holds the turn, since events can follow at once.
  function launch(p: Proc, model: string | undefined, effort: Effort | undefined, first: string) {
    // Without the agent's effort, thinking is off: the CLI default makes headless calls ~30x slower.
    run(claude, claudeArgs(model, effort), {
      input: first,
      cwd: os.homedir(),
      env: effort ? process.env : { ...process.env, MAX_THINKING_TOKENS: "0" },
      onStdin: (io) => void (p.io = io),
      onLine: (line) => onLine(p, line),
    }).then(
      ({ code, stderr }) => exit(p, stderr.trim().split("\n")[0] || `claude exited with code ${code}: ${p.lastLine.slice(0, 200)}`),
      (err) => exit(p, err instanceof Error ? err.message : String(err)),
    );
  }

  const exit = (p: Proc, error: string) => {
    p.retired = true;
    retire(p);
    if (p.job) finish(p, p.job, error);
  };

  function ask({ threadId, turns, model, effort }: AskInput, steps: Step[] = [], control: Control = {}): Promise<Answer> {
    return new Promise((resolve) => {
      const key = `${model ?? ""}|${effort ?? ""}`;
      const old = threadId ? threads.get(threadId) : undefined;
      const reuse = old && !old.job && !old.retired && old.key === key && old.seen === turns.length - 1;
      if (old && !old.job && !reuse) retire(old);
      // A busy thread (a second window asking at once) gets a one-off process.
      const keep = threadId && !old?.job ? threadId : undefined;
      const p: Proc = reuse ? old : { threadId: keep, key, seen: turns.length - 1, job: null, lastLine: "" };
      const job: Turning = {
        steps,
        control,
        settle: resolve,
        // Web research and tool runs take minutes; past that the turn is given up.
        timer: setTimeout(() => {
          job.error = `claude timed out after ${TIMEOUT_MS / 1000} s`;
          p.io?.kill();
        }, TIMEOUT_MS),
      };
      p.job = job;
      control.stop = () => {
        job.stopped = true;
        p.io?.kill();
      };
      control.steer = (text) => {
        if (p.job !== job || p.retired) return false;
        p.io?.write(userMessage(text));
        steps.push({ kind: "steer", text });
        job.steered = true;
        return true;
      };
      if (reuse) {
        clearTimeout(p.idle);
        p.io?.write(userMessage(withFiles(turns[turns.length - 1])));
        return;
      }
      if (keep) threads.set(keep, p);
      launch(p, model, effort, userMessage(transcript(turns)));
    });
  }

  // Plugin unload: no claude outlives it.
  const dispose = () => {
    for (const p of threads.values()) {
      clearTimeout(p.idle);
      p.io?.kill();
    }
    threads.clear();
  };
  return { ask, dispose };
}

type Job =
  | { status: "running"; steps: Step[] }
  | { status: "done"; steps: Step[]; answer: string; images: Record<string, string>; stopped: boolean }
  | { status: "error"; steps: Step[]; error: string };

// A finished job nobody polls (app reload, lost connection) is dropped after this long.
const KEEP_FINISHED_MS = 60 * 60_000;

export function createJobs(answer: (input: AskInput, steps: Step[], control: Control) => Promise<Answer>, now = Date.now) {
  const jobs = new Map<string, { job: Job; control: Control; finishedAt?: number }>();
  let next = 0;
  const end = (jobId: string, job: Job) => {
    const entry = jobs.get(jobId);
    if (entry) Object.assign(entry, { job, finishedAt: now() });
  };
  return {
    start(input: AskInput) {
      for (const [id, e] of jobs) if (e.finishedAt !== undefined && now() - e.finishedAt > KEEP_FINISHED_MS) jobs.delete(id);
      const jobId = `${now()}-${next++}`;
      // steps fills in while claude runs; poll hands out the live list.
      const steps: Step[] = [];
      const control: Control = {};
      jobs.set(jobId, { job: { status: "running", steps }, control });
      answer(input, steps, control).then(
        ({ answer, images, stopped }) => end(jobId, { status: "done", steps, answer, images, stopped }),
        (err) => {
          console.error("[paseo-ask] ask failed:", err);
          end(jobId, { status: "error", steps, error: err instanceof Error ? err.message : String(err) });
        },
      );
      return { jobId };
    },
    stop({ jobId }: { jobId: string }) {
      const stop = jobs.get(jobId)?.control.stop;
      stop?.();
      return { stopped: !!stop };
    },
    steer({ jobId, text, files }: { jobId: string; text: string; files?: AskFile[] }) {
      return { accepted: jobs.get(jobId)?.control.steer?.(withFiles({ text, files })) ?? false };
    },
    // A finished job is handed out once, then forgotten.
    poll({ jobId }: { jobId: string }): Job {
      const entry = jobs.get(jobId);
      if (!entry) return { status: "error", steps: [], error: "unknown job (daemon or plugin restarted?)" };
      if (entry.job.status !== "running") jobs.delete(jobId);
      return entry.job;
    },
  };
}
