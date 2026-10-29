// The chat of the agent whose composer opened Ask, put before each question.
// Tool calls and reasoning are left out: the messages carry what was decided, and they fit.
type Entry = { item: { type: string; text?: string } };
export const MAX_CONTEXT = 30_000;

export function agentContext(entries: Entry[], cwd?: string): string {
  const lines = entries
    .filter((e) => (e.item.type === "user_message" || e.item.type === "assistant_message") && e.item.text?.trim())
    .map((e) => `${e.item.type === "user_message" ? "User" : "Agent"}: ${e.item.text!.trim()}`);
  if (!lines.length) return "";
  const all = lines.join("\n\n");
  const text = all.length > MAX_CONTEXT ? `…${all.slice(-MAX_CONTEXT)}` : all;
  const where = cwd ? ` working in ${cwd}` : "";
  return `The user opened this chat from the window of a Paseo agent${where}. Its recent conversation, for context; don't take over its work unless asked:\n\n<agent-conversation>\n${text}\n</agent-conversation>\n\n`;
}
