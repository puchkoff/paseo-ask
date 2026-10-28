import assert from "node:assert/strict";
import { test } from "node:test";
import { enterAction, sendAction } from "./send.ts";

test("send action follows the setting and its alternate", () => {
  assert.equal(sendAction(false, "queue", true), "ask");
  assert.equal(sendAction(true, "steer", false), "steer");
  assert.equal(sendAction(true, "steer", true), "queue");
  assert.equal(sendAction(true, "interrupt", true), "queue");
  assert.equal(sendAction(true, "queue", false), "queue");
  assert.equal(sendAction(true, "queue", true), "steer");
});

test("enter keys match the main composer", () => {
  assert.equal(enterAction("enter", {}, false), "default");
  assert.equal(enterAction("enter", { metaKey: true }, false), "default");
  assert.equal(enterAction("enter", { ctrlKey: true }, true), "alternate");
  assert.equal(enterAction("enter", { shiftKey: true }, true), null);
  assert.equal(enterAction("mod-enter", {}, true), null);
  assert.equal(enterAction("mod-enter", { metaKey: true }, true), "default");
});
