// Mirrors Paseo's composer (packages/app/src/composer/input/state.ts) so Ask's keys and buttons act alike.
export type SendBehavior = "steer" | "interrupt" | "queue";
export type Action = "ask" | SendBehavior;

// What a send does: a new question when idle; while answering, the setting's behavior, or for the
// alternate send (Cmd/Ctrl+Enter, long-press) queue, or send-now when the setting is queue.
export function sendAction(pending: boolean, behavior: SendBehavior, alternate: boolean): Action {
  if (!pending) return "ask";
  if (!alternate) return behavior;
  return behavior === "queue" ? "steer" : "queue";
}

// Enter handling: "enter" sends on Enter (Cmd/Ctrl+Enter = alternate while answering);
// "mod-enter" sends only on Cmd/Ctrl+Enter. Shift+Enter is always a newline. null = newline.
export function enterAction(shortcut: "enter" | "mod-enter", e: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }, pending: boolean): "default" | "alternate" | null {
  if (e.shiftKey) return null;
  const mod = !!(e.metaKey || e.ctrlKey);
  if (shortcut === "mod-enter") return mod ? "default" : null;
  return mod && pending ? "alternate" : "default";
}
