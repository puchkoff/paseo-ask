import * as os from "node:os";
import type { Effort, Turn } from "../shared/ask.ts";
import { CommandError, type RunCommand } from "./exec.ts";

// Web research and tool runs take minutes.
const TIMEOUT_MS = 600_000;
const SYSTEM_PROMPT =
  "You answer questions in a chat window. Use tools (web search, fetch, shell, MCP) whenever they help. Be direct. Answers render as Markdown, tables included.";

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
    "--output-format",
    "json",
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--effort", effort] : []),
  ];
}

export function transcript(turns: Turn[]): string {
  if (turns.length === 1) return turns[0].text;
  const history = turns.slice(0, -1).map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`);
  return `Conversation so far:\n\n${history.join("\n\n")}\n\nAnswer the latest question:\n\n${turns[turns.length - 1].text}`;
}

export function createAsk(run: RunCommand, claude: string) {
  return async ({ turns, model, effort }: { turns: Turn[]; model?: string; effort?: Effort }) => {
    let stdout: string;
    try {
      // Without the agent's effort, thinking is off: the CLI default makes headless calls ~30x slower.
      stdout = await run(claude, claudeArgs(model, effort), {
        timeoutMs: TIMEOUT_MS,
        input: transcript(turns),
        cwd: os.homedir(),
        env: effort ? process.env : { ...process.env, MAX_THINKING_TOKENS: "0" },
      });
    } catch (err) {
      if (err instanceof CommandError && err.stdout) stdout = err.stdout;
      else throw err;
    }
    const out = JSON.parse(stdout) as { is_error?: boolean; result?: string };
    if (out.is_error || typeof out.result !== "string") throw new Error(out.result || "claude returned no answer");
    return { answer: out.result.trim() };
  };
}

type Job = { status: "running" } | { status: "done"; answer: string } | { status: "error"; error: string };

export function createJobs(answer: ReturnType<typeof createAsk>) {
  const jobs = new Map<string, Job>();
  let next = 0;
  return {
    start(input: { turns: Turn[]; model?: string; effort?: Effort }) {
      const jobId = `${Date.now()}-${next++}`;
      jobs.set(jobId, { status: "running" });
      answer(input).then(
        ({ answer }) => jobs.set(jobId, { status: "done", answer }),
        (err) => {
          console.error("[paseo-ask] ask failed:", err);
          jobs.set(jobId, { status: "error", error: err instanceof Error ? err.message : String(err) });
        },
      );
      return { jobId };
    },
    // A finished job is handed out once, then forgotten.
    poll({ jobId }: { jobId: string }): Job {
      const job = jobs.get(jobId);
      if (!job) return { status: "error", error: "unknown job (daemon or plugin restarted?)" };
      if (job.status !== "running") jobs.delete(jobId);
      return job;
    },
  };
}
