import * as os from "node:os";
import type { Turn } from "../shared/ask.ts";
import { CommandError, type RunCommand } from "./exec.ts";

const TIMEOUT_MS = 180_000;
const SYSTEM_PROMPT =
  "You answer quick questions in a small chat window. Be brief and direct. Markdown is shown as plain text, so avoid tables and headings.";

// No tools, MCP, settings or saved session: a stateless Q&A call, the thread is resent each turn.
export const CLAUDE_ARGS = [
  "-p",
  "--no-session-persistence",
  "--tools",
  "",
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--system-prompt",
  SYSTEM_PROMPT,
  "--output-format",
  "json",
];

export function transcript(turns: Turn[]): string {
  if (turns.length === 1) return turns[0].text;
  const history = turns.slice(0, -1).map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`);
  return `Conversation so far:\n\n${history.join("\n\n")}\n\nAnswer the latest question:\n\n${turns[turns.length - 1].text}`;
}

export function createAsk(run: RunCommand, claude: string) {
  return async ({ turns }: { turns: Turn[] }) => {
    let stdout: string;
    try {
      // Thinking off: the CLI's default thinking makes headless calls ~30x slower.
      stdout = await run(claude, CLAUDE_ARGS, {
        timeoutMs: TIMEOUT_MS,
        input: transcript(turns),
        cwd: os.tmpdir(),
        env: { ...process.env, MAX_THINKING_TOKENS: "0" },
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
