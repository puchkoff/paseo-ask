import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const turn = z.object({ role: z.enum(["user", "assistant"]), text: z.string() });
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
