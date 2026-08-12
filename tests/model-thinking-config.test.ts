import test from "node:test";
import assert from "node:assert/strict";
import { parsePowerlineConfig } from "../powerline-config.ts";
const PRESET_NAMES = ["default", "minimal", "compact", "full", "nerd", "ascii"] as const;

test("modelThinking.wrapper accepts every supported wrapper", () => {
  for (const wrapper of ["none", "parentheses", "brackets"] as const) {
    const config = parsePowerlineConfig({ modelThinking: { wrapper } }, PRESET_NAMES);
    assert.equal(config.modelThinking.wrapper, wrapper);
  }
});

test("modelThinking.wrapper defaults to brackets for missing or invalid values", () => {
  assert.equal(parsePowerlineConfig({}, PRESET_NAMES).modelThinking.wrapper, "brackets");
  assert.equal(parsePowerlineConfig({ modelThinking: { wrapper: "angle" } }, PRESET_NAMES).modelThinking.wrapper, "brackets");
});
