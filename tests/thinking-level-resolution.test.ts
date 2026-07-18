import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveThinkingLevel } from "../index.ts";

const extensionSource = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");

test("session max wins while startup getter still reports previous level", () => {
  const thinkingLevel = resolveThinkingLevel({
    current: null,
    sessionEvents: [{ type: "thinking_level_change", thinkingLevel: "max" }],
    getCurrent: () => "xhigh",
  });

  assert.equal(thinkingLevel, "max");
});

test("session startup starts the wave from the restored branch level", () => {
  assert.match(extensionSource, /getThinkingLevelFn = \(\) => currentCtx\?\.thinkingLevel \?\? "off"/);
  assert.match(extensionSource, /currentThinkingLevel = null;\s+syncMaxThinkingWave\(\)/);
});
