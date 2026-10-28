import type { Turn } from "./ask.ts";

// A past Ask thread; id is also its daemon thread id (server/ask.ts createAsk).
export type Session = { id: string; turns: Turn[]; at: number };
export const MAX_SESSIONS = 100;

// Puts the session first with its new turns; an empty thread isn't kept.
export function upsertSession(sessions: Session[], id: string, turns: Turn[], at: number): Session[] {
  const rest = sessions.filter((s) => s.id !== id);
  return (turns.length ? [{ id, turns, at }, ...rest] : rest).slice(0, MAX_SESSIONS);
}

// First line of the first question, skipping quoted lines (a quoted selection).
export function sessionTitle(s: Session): string {
  const text = s.turns.find((t) => t.role === "user")?.text ?? "";
  const line = text.split("\n").find((l) => l.trim() && !l.startsWith(">")) ?? text.split("\n").find((l) => l.trim());
  return line?.replace(/^>\s?/, "").trim() || "Attachment";
}
