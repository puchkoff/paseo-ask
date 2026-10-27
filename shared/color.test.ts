import assert from "node:assert/strict";
import { test } from "node:test";
import { mixHex } from "./color.ts";

test("approximates surface3 in light and dark, passes non-hex through", () => {
  assert.equal(mixHex("#f4f4f5", "#1a1a1e", 0.09), "#e0e0e2");
  assert.equal(mixHex("#27272a", "#fafafa", 0.09), "#3a3a3d");
  assert.equal(mixHex("rgb(1,2,3)", "#ffffff", 0.5), "rgb(1,2,3)");
});
