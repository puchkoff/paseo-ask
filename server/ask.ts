import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Effort, Step, Turn } from "../shared/ask.ts";
import type { RunLines } from "./exec.ts";

// Web research and tool runs take minutes.
const TIMEOUT_MS = 600_000;
const SYSTEM_PROMPT =
  "You answer questions in a chat window. Use tools (web search, fetch, shell, MCP) whenever they help. Be direct. Answers render as Markdown, tables included. To show an image file, embed it as a Markdown image with its absolute path, e.g. ![screenshot](/tmp/shot.png).";

// Same setup as an agent in the main window: user settings, skills, plugins, MCP and full tooling,
// with no permission prompts (nobody can answer them). Costs ~2 s per question over a bare call.
// No saved session: the thread is resent each turn.
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

function withFiles(t: Turn): string {
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

// control.steer is set while claude still reads stdin. Claude Code folds a message sent mid-turn
// into the running turn; one that arrives after the result would start a new turn, so stdin closes
// at the first result and steer then reports false.
export type Control = { steer?: (text: string) => boolean; stop?: () => void };

export function createAsk(run: RunLines, claude: string) {
  return async ({ turns, model, effort }: { turns: Turn[]; model?: string; effort?: Effort }, steps: Step[] = [], control: Control = {}) => {
    // The last result wins: a steer written just before the turn ended runs as one more turn.
    let final: { result?: string; isError?: boolean } = {};
    let lastLine = "";
    let close = () => {};
    let stopped = false;
    // Without the agent's effort, thinking is off: the CLI default makes headless calls ~30x slower.
    const { code, stderr } = await run(claude, claudeArgs(model, effort), {
      timeoutMs: TIMEOUT_MS,
      input: userMessage(transcript(turns)),
      cwd: os.homedir(),
      onStdin: (io) => {
        control.stop = () => {
          stopped = true;
          io.kill();
        };
        let open = true;
        close = () => {
          if (open) io.end();
          open = false;
          control.steer = undefined;
        };
        control.steer = (text) => {
          if (!open) return false;
          io.write(userMessage(text));
          steps.push({ kind: "steer", text });
          return true;
        };
      },
      env: effort ? process.env : { ...process.env, MAX_THINKING_TOKENS: "0" },
      onLine: (line) => {
        if (!line.trim()) return;
        lastLine = line;
        try {
          const r = applyEvent(steps, JSON.parse(line) as Event);
          if (r.result !== undefined) {
            final = r;
            close();
          }
        } catch {
          // Not JSON (a stray log line): ignore.
        }
      },
    });
    close();
    control.stop = undefined;
    if (stopped) {
      const said = steps.filter((x): x is Extract<Step, { kind: "text" }> => x.kind === "text").map((x) => x.text);
      return { answer: said.join("\n\n"), images: {}, stopped: true };
    }
    if (final.result === undefined) throw new Error(stderr.trim().split("\n")[0] || `claude exited with code ${code}: ${lastLine.slice(0, 200)}`);
    if (final.isError) throw new Error(final.result || "claude returned an error");
    const answer = final.result.trim();
    return { answer, images: await embedImages(answer), stopped: false };
  };
}

type Job =
  | { status: "running"; steps: Step[] }
  | { status: "done"; steps: Step[]; answer: string; images: Record<string, string>; stopped: boolean }
  | { status: "error"; steps: Step[]; error: string };

export function createJobs(answer: (input: { turns: Turn[]; model?: string; effort?: Effort }, steps: Step[], control: Control) => Promise<{ answer: string; images: Record<string, string>; stopped: boolean }>) {
  const jobs = new Map<string, Job>();
  const controls = new Map<string, Control>();
  let next = 0;
  return {
    start(input: { turns: Turn[]; model?: string; effort?: Effort }) {
      const jobId = `${Date.now()}-${next++}`;
      // steps fills in while claude runs; poll hands out the live list.
      const steps: Step[] = [];
      const control: Control = {};
      controls.set(jobId, control);
      jobs.set(jobId, { status: "running", steps });
      answer(input, steps, control).then(
        ({ answer, images, stopped }) => jobs.set(jobId, { status: "done", steps, answer, images, stopped }),
        (err) => {
          console.error("[paseo-ask] ask failed:", err);
          jobs.set(jobId, { status: "error", steps, error: err instanceof Error ? err.message : String(err) });
        },
      );
      return { jobId };
    },
    stop({ jobId }: { jobId: string }) {
      const stop = controls.get(jobId)?.stop;
      stop?.();
      return { stopped: !!stop };
    },
    steer({ jobId, text }: { jobId: string; text: string }) {
      return { accepted: controls.get(jobId)?.steer?.(text) ?? false };
    },
    // A finished job is handed out once, then forgotten.
    poll({ jobId }: { jobId: string }): Job {
      const job = jobs.get(jobId);
      if (!job) return { status: "error", steps: [], error: "unknown job (daemon or plugin restarted?)" };
      if (job.status !== "running") {
        jobs.delete(jobId);
        controls.delete(jobId);
      }
      return job;
    },
  };
}
