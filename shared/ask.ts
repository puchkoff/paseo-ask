import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// files: daemon paths returned by ask.upload; Claude reads them with its tools.
export const file = z.object({ name: z.string().max(255), path: z.string().max(1000) });
export const turn = z.object({ role: z.enum(["user", "assistant"]), text: z.string(), files: z.array(file).max(20).optional() });
export type AskFile = z.infer<typeof file>;
export type Turn = z.infer<typeof turn>;

// A Claude model id or alias (e.g. "claude-opus-5-5", "opus[1m]"); omitted means the user's default.
// No leading "-", so it can never be read as a CLI flag.
export const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/).max(100);

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

// Start + poll: the app times plugin RPCs out after 60 s, and tool-using answers take minutes.
export const askStart = defineRpc({
  name: "ask.start",
  input: z.object({ turns: z.array(turn).min(1).max(100), model: model.optional(), effort: z.enum(EFFORTS).optional() }),
  output: z.object({ jobId: z.string() }),
});

// ~20 MB per file as base64; websocket messages cap at 100 MB.
export const MAX_FILE_BASE64 = 28_000_000;
export const askUpload = defineRpc({
  name: "ask.upload",
  input: z.object({ name: z.string().min(1).max(255), data: z.string().max(MAX_FILE_BASE64) }),
  output: file,
});

export const askPoll = defineRpc({
  name: "ask.poll",
  input: z.object({ jobId: z.string() }),
  output: z.object({ status: z.enum(["running", "done", "error"]), answer: z.string().optional(), error: z.string().optional() }),
});

// The agent's Claude model: providers come as "claude" (+ model) or "claude/<model>". Non-Claude → undefined.
export function claudeModelOf(agent: { provider: string; model: string | null }): string | undefined {
  const [name, fromProvider] = agent.provider.split("/", 2);
  if (name !== "claude") return undefined;
  const id = agent.model ?? fromProvider;
  return id && model.safeParse(id).success ? id : undefined;
}

// The agent's thinking option, when it is a `claude --effort` level.
export function claudeEffortOf(agent: { provider: string; thinkingOptionId: string | null }): Effort | undefined {
  const id = agent.thinkingOptionId;
  return agent.provider.split("/")[0] === "claude" && (EFFORTS as readonly string[]).includes(id ?? "") ? (id as Effort) : undefined;
}
