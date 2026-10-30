// The chat of the agent whose composer opened Ask, put before each question.
// Tool calls and reasoning are left out: the messages carry what was decided, and they fit.
type Entry = { item: { type: string; text?: string } };
export const MAX_CONTEXT = 30_000;
export const MAX_FORK = 100_000;

function chat(entries: Entry[], max: number): string {
  const all = entries
    .filter((e) => (e.item.type === "user_message" || e.item.type === "assistant_message") && e.item.text?.trim())
    .map((e) => `${e.item.type === "user_message" ? "User" : "Agent"}: ${e.item.text!.trim()}`)
    .join("\n\n");
  return all.length > max ? `…${all.slice(-max)}` : all;
}

export function agentContext(entries: Entry[], cwd?: string): string {
  const text = chat(entries, MAX_CONTEXT);
  if (!text) return "";
  const where = cwd ? ` working in ${cwd}` : "";
  return `The user opened this chat from the window of a Paseo agent${where}. Its recent conversation, for context; don't take over its work unless asked:\n\n<agent-conversation>\n${text}\n</agent-conversation>\n\n`;
}

// "Ask in new chat": the history a forked agent starts with, in the shape of Paseo's own fork
// attachment (server activity-curator.ts buildForkContextText), so the app shows it as one.
export function forkHistory(entries: Entry[], title?: string | null, cwd?: string): string {
  const header = ["Chat history from a previous Paseo agent.", ...(title ? [`Source agent: ${title}`] : []), ...(cwd ? [`Source directory: ${cwd}`] : [])];
  return `<chat-history-summary>\n${header.join("\n")}\n\n${chat(entries, MAX_FORK) || "No chat history to display."}\n</chat-history-summary>`;
}
