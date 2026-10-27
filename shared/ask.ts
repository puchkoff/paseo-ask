import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const turn = z.object({ role: z.enum(["user", "assistant"]), text: z.string() });
export type Turn = z.infer<typeof turn>;

// "default" leaves the model to the user's Claude Code settings; the rest are CLI aliases.
export const MODELS = ["default", "fable", "opus", "sonnet", "haiku"] as const;
export type Model = (typeof MODELS)[number];

// Start + poll: the app times plugin RPCs out after 60 s, and tool-using answers take minutes.
export const askStart = defineRpc({
  name: "ask.start",
  input: z.object({ turns: z.array(turn).min(1).max(100), model: z.enum(MODELS).default("default") }),
  output: z.object({ jobId: z.string() }),
});

export const askPoll = defineRpc({
  name: "ask.poll",
  input: z.object({ jobId: z.string() }),
  output: z.object({ status: z.enum(["running", "done", "error"]), answer: z.string().optional(), error: z.string().optional() }),
});
