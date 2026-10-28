import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SESSIONS, type Session, sessionTitle, upsertSession } from "./sessions.ts";

const q = (text: string) => [{ role: "user" as const, text }];

test("upsert moves the session first, drops empty ones, keeps 100", () => {
  const many: Session[] = Array.from({ length: MAX_SESSIONS }, (_, i) => ({ id: `s${i}`, turns: q("x"), at: i }));
  const up = upsertSession(many, "new", q("hi"), 999);
  assert.equal(up.length, MAX_SESSIONS);
  assert.equal(up[0].id, "new");
  assert.equal(up.at(-1)?.id, "s98");
  assert.deepEqual(upsertSession(up, "s5", q("y"), 1000).map((s) => s.id).slice(0, 2), ["s5", "new"]);
  assert.equal(upsertSession(up, "new", [], 1).some((s) => s.id === "new"), false);
});

test("title skips a quoted selection", () => {
  assert.equal(sessionTitle({ id: "a", at: 0, turns: q("> quoted\n\nwhat is this?") }), "what is this?");
  assert.equal(sessionTitle({ id: "a", at: 0, turns: q("> only quote") }), "only quote");
  assert.equal(sessionTitle({ id: "a", at: 0, turns: q("") }), "Attachment");
});
