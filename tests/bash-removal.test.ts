import assert from "node:assert/strict";
import test from "node:test";

import { resolveShortcutConfig } from "../index.ts";
import { parsePowerlineConfig } from "../powerline-config.ts";
import { PRESETS } from "../presets.ts";
import type { StatusLinePreset } from "../types.ts";
import { BUILTIN_STATUS_LINE_SEGMENT_IDS } from "../types.ts";

test("Bash mode is not a built-in segment or preset entry", () => {
  assert.equal(BUILTIN_STATUS_LINE_SEGMENT_IDS.includes("shell_mode" as never), false);

  for (const preset of Object.values(PRESETS)) {
    assert.equal(preset.leftSegments.includes("shell_mode" as never), false);
    assert.equal(preset.rightSegments.includes("shell_mode" as never), false);
    assert.equal(preset.secondarySegments?.includes("shell_mode" as never) ?? false, false);
  }
});

test("legacy Bash mode settings do not affect queue shortcuts", () => {
  const shortcuts = resolveShortcutConfig({
    bashMode: { toggleShortcut: "ctrl+shift+b" },
    powerlineShortcuts: { queueOpen: "ctrl+shift+b" },
  });

  assert.equal(shortcuts.queueOpen, "ctrl+shift+b");
});

test("legacy shell_mode layout settings are silently ignored", () => {
  const config = parsePowerlineConfig({
    disabledSegments: ["shell_mode"],
    layout: { left: ["model", "shell_mode", "path"] },
  }, Object.keys(PRESETS) as StatusLinePreset[]);

  assert.deepEqual(config.disabledSegments, []);
  assert.deepEqual(config.layout?.left, ["model", "path"]);
  assert.deepEqual(config.invalidDisabledSegments, []);
  assert.deepEqual(config.invalidLayoutSegments, []);
});
