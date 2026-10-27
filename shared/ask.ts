import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const turn = z.object({ role: z.enum(["user", "assistant"]), text: z.string() });
export type Turn = z.infer<typeof turn>;

export const ask = defineRpc({
  name: "ask",
  input: z.object({ turns: z.array(turn).min(1).max(100) }),
  output: z.object({ answer: z.string() }),
});
