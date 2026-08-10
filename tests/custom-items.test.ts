import test from "node:test";
import assert from "node:assert/strict";
import { buildAlignedPrimaryContent, buildPowerlineFooterLines, buildResponsiveLayout, buildSessionTitleLines, installPowerlineWidgetSpacingPatch } from "../index.ts";
import { collectHiddenExtensionStatusKeys, getNotificationExtensionStatuses, normalizeExtensionStatusValue, parsePowerlineConfig, mergeSegmentOptions, mergeSegmentsWithCustomItems, nextPowerlineSettingWithOptions, nextPowerlineSettingWithPreset, normalizeCompactExtensionStatus } from "../powerline-config.ts";
import { getSeparator } from "../separators.ts";
import { PRESETS } from "../presets.ts";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

test("right layout group is aligned to the terminal edge", () => {
  const content = buildAlignedPrimaryContent(["left"], ["right"], PRESETS.minimal.separator, 20);

  const plain = stripAnsi(content);
  assert.equal(plain, "left" + " ".repeat(11) + "right");
  assert.equal(plain.length, 20);
});

test("narrow rows omit the stretch gap between layout groups", () => {
  const content = buildAlignedPrimaryContent(["left"], ["right"], PRESETS.minimal.separator, 13);

  assert.equal(stripAnsi(content), "left" + " ".repeat(4) + "right");
});

test("right-only layout group is aligned to the terminal edge", () => {
  const content = buildAlignedPrimaryContent([], ["right"], PRESETS.minimal.separator, 20);

  const plain = stripAnsi(content);
  assert.equal(plain, " ".repeat(15) + "right");
  assert.equal(plain.length, 20);
});

test("secondary layout group always starts after right on its own row", () => {
  const layout = buildResponsiveLayout({
    left: [{ content: "left", width: 4 }],
    right: [{ content: "right", width: 5 }],
    secondary: [{ content: "secondary", width: 9 }],
  }, PRESETS.minimal, 30);

  assert.equal(stripAnsi(layout.topContent), "left" + " ".repeat(21) + "right");
  assert.equal(stripAnsi(layout.secondaryContent), "secondary");
});

test("narrow rows wrap primary overflow before configured secondary", () => {
  const layout = buildResponsiveLayout({
    left: [{ content: "primary-too-wide", width: 17 }],
    right: [],
    secondary: [{ content: "secondary", width: 9 }],
  }, PRESETS.minimal, 12);

  assert.equal(layout.topContent, "");
  assert.deepEqual(layout.secondaryLines.map(stripAnsi), ["primary-too-", "wide", "secondary"]);
});

test("narrow rows place right overflow before configured secondary", () => {
  const layout = buildResponsiveLayout({
    left: [{ content: "left", width: 4 }],
    right: [{ content: "right", width: 5 }],
    secondary: [{ content: "Z", width: 1 }],
  }, PRESETS.minimal, 12);

  const secondary = stripAnsi(layout.secondaryContent);
  assert.ok(secondary.includes("right"));
  assert.ok(secondary.indexOf("right") < secondary.indexOf("Z"));
});

test("secondary overflow continues on clean extra rows", () => {
  const layout = buildResponsiveLayout({
    left: [{ content: "left", width: 4 }],
    right: [
      { content: "first", width: 5 },
      { content: "second", width: 6 },
      { content: "third", width: 5 },
    ],
    secondary: [],
  }, PRESETS.minimal, 12);

  assert.deepEqual(layout.secondaryLines.map(stripAnsi), ["first", "second", "third"]);
  assert.ok(layout.secondaryLines.every((line) => !line.includes("…")));
});

test("one oversized status wraps without a right-edge ellipsis", () => {
  const layout = buildResponsiveLayout({
    left: [],
    right: [{ content: "alpha beta gamma", width: 16 }],
    secondary: [],
  }, PRESETS.minimal, 10);

  assert.deepEqual(layout.secondaryLines.map(stripAnsi), ["alpha beta", "gamma"]);
  assert.ok(layout.secondaryLines.every((line) => !line.includes("…")));
});

test("right-aligned session titles wrap without an edge ellipsis and use the full renderer width", () => {
  const lines = buildSessionTitleLines("⏳ Tmux-based pi subagents plugin :: side-quests", 24, "right");

  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => !line.includes("…") && !line.includes("...")));
  assert.ok(lines.every((line) => stripAnsi(line).length <= 24));
  assert.equal(stripAnsi(buildSessionTitleLines("session", 10, "right")[0]), "   session");
});

test("below-editor placement uses Pi's reserved footer row instead of leaving it blank", () => {
  assert.deepEqual(
    buildPowerlineFooterLines("below", ["primary"], ["secondary"]),
    ["primary", "secondary"],
  );
  assert.deepEqual(
    buildPowerlineFooterLines("above", ["primary"], ["secondary"]),
    ["secondary"],
  );
});

test("session title above the editor suppresses Pi's leading widget spacer", () => {
  const calls: boolean[] = [];
  const prototype = {
    renderWidgetContainer(
      _container: unknown,
      _widgets: Map<string, unknown>,
      _spacerWhenEmpty: boolean,
      leadingSpacer: boolean,
    ) {
      calls.push(leadingSpacer);
    },
  };

  installPowerlineWidgetSpacingPatch(prototype);
  prototype.renderWidgetContainer({}, new Map([["powerline-session-title", {}]]), true, true);
  prototype.renderWidgetContainer({}, new Map([["another-extension", {}]]), true, true);

  assert.deepEqual(calls, [false, true]);
});

test("fixed custom preset is removed in favor of powerline.layout", () => {
  assert.equal("custom" in PRESETS, false);
});

test("parsePowerlineConfig supports object config with custom items", () => {
  const config = parsePowerlineConfig(
    {
      preset: "compact",
      customItems: [
        { id: "ci", statusKey: "ci-status", position: "right", prefix: "CI" },
        { id: "review", position: "secondary", hideWhenMissing: false },
      ],
    },
    ["default", "compact"],
  );

  assert.equal(config.preset, "compact");
  assert.equal(config.customItems.length, 2);
  assert.equal(config.customItems[0].id, "ci");
  assert.equal(config.customItems[0].statusKey, "ci-status");
  assert.equal(config.customItems[1].statusKey, "review");
  assert.equal(config.customItems[1].hideWhenMissing, false);
  assert.equal(config.customItems[0].selfColorize, false);
  assert.deepEqual(config.disabledSegments, []);
  assert.deepEqual(config.invalidDisabledSegments, []);
  assert.equal(config.layout, null);
  assert.deepEqual(config.invalidLayoutSegments, []);
  assert.equal(config.separator, null);
  assert.equal(config.placement, "above");
  assert.equal(config.invalidPlacement, null);
  assert.equal(config.welcome, true);
  assert.equal(config.showLastPrompt, true);
  assert.deepEqual(config.sessionTitle, { enabled: false, alignment: "left" });
  assert.equal(config.stashSharpSShortcut, false);
  assert.deepEqual(config.queue, { compactPromptMode: "queue" });
});

test("parsePowerlineConfig accepts self-colored custom items", () => {
  const config = parsePowerlineConfig({ customItems: [{ id: "usage", color: "warning", selfColorize: true }] }, ["default"]);

  assert.deepEqual(config.customItems, [{
    id: "usage",
    statusKey: "usage",
    position: "right",
    color: "warning",
    selfColorize: true,
    prefix: undefined,
    hideWhenMissing: true,
    excludeFromExtensionStatuses: true,
  }]);
});

test("parsePowerlineConfig supports disabling the last-prompt reminder", () => {
  const config = parsePowerlineConfig(
    { preset: "compact", showLastPrompt: false },
    ["default", "compact"],
  );

  assert.equal(config.showLastPrompt, false);
});

test("parsePowerlineConfig supports standalone session title options", () => {
  const config = parsePowerlineConfig(
    { preset: "compact", sessionTitle: { enabled: true, alignment: "left" } },
    ["default", "compact"],
  );

  assert.deepEqual(config.sessionTitle, { enabled: true, alignment: "left" });
});

test("parsePowerlineConfig defaults session title alignment to left", () => {
  const above = parsePowerlineConfig(
    { preset: "compact", sessionTitle: true },
    ["default", "compact"],
  );
  const below = parsePowerlineConfig(
    { preset: "compact", placement: "below", sessionTitle: { enabled: true } },
    ["default", "compact"],
  );

  assert.deepEqual(above.sessionTitle, { enabled: true, alignment: "left" });
  assert.deepEqual(below.sessionTitle, { enabled: true, alignment: "left" });
});

test("parsePowerlineConfig defaults invalid session title options", () => {
  const config = parsePowerlineConfig(
    { preset: "compact", sessionTitle: { enabled: "yes", alignment: "center" } },
    ["default", "compact"],
  );

  assert.deepEqual(config.sessionTitle, { enabled: false, alignment: "left" });
});

test("parsePowerlineConfig supports disabled segments", () => {
  const config = parsePowerlineConfig(
    {
      preset: "default",
      customItems: [{ id: "ci" }],
      disabledSegments: [
        "queue",
        "cost",
        " extension_statuses ",
        "custom:ci",
        "cost",
        "unknown",
        "custom:missing",
        123,
      ],
    },
    ["default", "compact"],
  );

  assert.deepEqual(config.disabledSegments, ["queue", "cost", "extension_statuses", "custom:ci"]);
  assert.deepEqual(config.invalidDisabledSegments, ["unknown", "custom:missing", "123"]);
});

test("parsePowerlineConfig supports partial explicit layout rows", () => {
  const config = parsePowerlineConfig(
    {
      preset: "default",
      customItems: [{ id: "ci" }],
      layout: {
        left: ["model", "custom:ci", "model", "unknown", 123],
        right: ["model", "cost"],
        secondary: [],
      },
    },
    ["default", "compact"],
  );

  assert.deepEqual(config.layout, {
    left: ["model", "custom:ci"],
    right: ["cost"],
    secondary: [],
  });
  assert.deepEqual(config.invalidLayoutSegments, ["left:unknown", "left:123", "right:model"]);
});

test("parsePowerlineConfig preserves reporter layout groups", () => {
  const config = parsePowerlineConfig(
    {
      preset: "default",
      layout: {
        left: ["model"],
        right: ["path"],
        secondary: ["thinking"],
      },
    },
    ["default", "compact"],
  );

  assert.deepEqual(config.layout, {
    left: ["model"],
    right: ["path"],
    secondary: ["thinking"],
  });
  assert.deepEqual(config.invalidLayoutSegments, []);
  assert.deepEqual(
    mergeSegmentsWithCustomItems(PRESETS.default, config.customItems, {
      layout: config.layout,
      disabledSegments: config.disabledSegments,
    }),
    {
      leftSegments: ["model"],
      rightSegments: ["path"],
      secondarySegments: ["thinking"],
    },
  );
});

test("parsePowerlineConfig supports separator overrides", () => {
  const config = parsePowerlineConfig(
    { preset: "default", separator: " chevron " },
    ["default", "compact"],
  );
  const invalid = parsePowerlineConfig(
    { preset: "default", separator: "sparkle" },
    ["default", "compact"],
  );

  assert.equal(config.separator, "chevron");
  assert.equal(invalid.separator, null);
});

test("configured separators resolve independently of presets", () => {
  const presetSeparator = getSeparator(PRESETS.default.separator).left;
  const configuredSeparator = getSeparator("chevron").left;

  assert.notEqual(configuredSeparator, presetSeparator);
  assert.equal(configuredSeparator, "›");
});

test("parsePowerlineConfig validates primary powerline placement", () => {
  const below = parsePowerlineConfig(
    { preset: "compact", placement: "below" },
    ["default", "compact"],
  );
  const invalid = parsePowerlineConfig(
    { preset: "compact", placement: "sideways" },
    ["default", "compact"],
  );

  assert.equal(below.placement, "below");
  assert.equal(below.invalidPlacement, null);
  assert.equal(invalid.placement, "above");
  assert.equal(invalid.invalidPlacement, "sideways");
});

test("parsePowerlineConfig supports queue compact prompt mode", () => {
  const defaultConfig = parsePowerlineConfig({}, ["default", "compact"]);
  const native = parsePowerlineConfig(
    { queue: { compactPromptMode: "native" } },
    ["default", "compact"],
  );
  const invalid = parsePowerlineConfig(
    { queue: { compactPromptMode: "passthrough" } },
    ["default", "compact"],
  );
  const shorthand = parsePowerlineConfig("compact", ["default", "compact"]);

  assert.deepEqual(defaultConfig.queue, { compactPromptMode: "queue" });
  assert.deepEqual(native.queue, { compactPromptMode: "native" });
  assert.deepEqual(invalid.queue, { compactPromptMode: "queue" });
  assert.deepEqual(shorthand.queue, { compactPromptMode: "queue" });
});

test("parsePowerlineConfig supports welcome and legacy sharp-S settings", () => {
  const config = parsePowerlineConfig(
    { preset: "compact", welcome: false, stashSharpSShortcut: true },
    ["default", "compact"],
  );
  const shorthand = parsePowerlineConfig("compact", ["default", "compact"]);

  assert.equal(config.welcome, false);
  assert.equal(config.stashSharpSShortcut, true);
  assert.equal(shorthand.welcome, true);
  assert.equal(shorthand.stashSharpSShortcut, false);
});
test("parsePowerlineConfig extracts supported segment options", () => {
  const config = parsePowerlineConfig(
    {
      preset: "default",
      model: { showThinkingLevel: true, display: "qualified" },
      path: { mode: "full", maxLength: 120 },
      git: { showBranch: false, showStaged: false, showUnstaged: true, showUntracked: false, polling: "branch", hostIcon: true },
      time: { format: "12h", showSeconds: true },
      cost: { subscriptionDisplay: "both", currency: "cny" },
      workingVibes: { color: "rainbow" },
    },
    ["default", "compact"],
  );
  const invalidCurrency = parsePowerlineConfig(
    { cost: { currency: "BTC" } },
    ["default", "compact"],
  );

  assert.deepEqual(config.segmentOptions, {
    model: { showThinkingLevel: true, display: "qualified" },
    path: { mode: "full", maxLength: 120 },
    git: { showBranch: false, showStaged: false, showUnstaged: true, showUntracked: false, polling: "branch", hostIcon: true },
    time: { format: "12h", showSeconds: true },
    cost: { subscriptionDisplay: "both", currency: "CNY" },
  });
  assert.deepEqual(config.workingVibes, { color: "rainbow" });
  assert.deepEqual(invalidCurrency.segmentOptions, { cost: {} });
});

test("parsePowerlineConfig accepts working-vibe theme colors and hex colors", () => {
  const semantic = parsePowerlineConfig({ workingVibes: { color: "warning" } }, ["default"]);
  const hex = parsePowerlineConfig({ workingVibes: { color: "#89d281" } }, ["default"]);

  assert.deepEqual(semantic.workingVibes, { color: "warning" });
  assert.deepEqual(hex.workingVibes, { color: "#89d281" });
});

test("mergeSegmentOptions lets user config override preset segment defaults", () => {
  assert.deepEqual(
    mergeSegmentOptions(
      { path: { mode: "basename", maxLength: 20 }, git: { showBranch: true, showUntracked: true } },
      { path: { mode: "full" }, git: { showUntracked: false }, cost: { subscriptionDisplay: "reported-cost" } },
    ),
    {
      model: {},
      path: { mode: "full", maxLength: 20 },
      git: { showBranch: true, showUntracked: false },
      time: {},
      cost: { subscriptionDisplay: "reported-cost" },
      context: {},
      cache_read: {},
    },
  );
});

test("mergeSegmentsWithCustomItems appends custom segment ids by position", () => {
  const merged = mergeSegmentsWithCustomItems(
    {
      leftSegments: ["path"],
      rightSegments: ["git"],
      secondarySegments: ["extension_statuses"],
      separator: "powerline",
    },
    [
      { id: "ci", statusKey: "ci", position: "left", hideWhenMissing: true, excludeFromExtensionStatuses: true },
      { id: "timer", statusKey: "timer", position: "right", hideWhenMissing: true, excludeFromExtensionStatuses: true },
      { id: "review", statusKey: "review", position: "secondary", hideWhenMissing: true, excludeFromExtensionStatuses: true },
    ],
  );

  assert.deepEqual(merged.leftSegments, ["path", "custom:ci"]);
  assert.deepEqual(merged.rightSegments, ["git", "custom:timer"]);
  assert.deepEqual(merged.secondarySegments, ["extension_statuses", "custom:review"]);
});

test("mergeSegmentsWithCustomItems filters disabled segment ids", () => {
  const merged = mergeSegmentsWithCustomItems(
    {
      leftSegments: ["path", "model"],
      rightSegments: ["git", "cost"],
      secondarySegments: ["extension_statuses"],
      separator: "powerline",
    },
    [
      { id: "ci", statusKey: "ci", position: "left", hideWhenMissing: true, excludeFromExtensionStatuses: true },
      { id: "timer", statusKey: "timer", position: "right", hideWhenMissing: true, excludeFromExtensionStatuses: true },
      { id: "review", statusKey: "review", position: "secondary", hideWhenMissing: true, excludeFromExtensionStatuses: true },
    ],
    { disabledSegments: ["model", "cost", "custom:ci", "custom:review"] },
  );

  assert.deepEqual(merged.leftSegments, ["path"]);
  assert.deepEqual(merged.rightSegments, ["git", "custom:timer"]);
  assert.deepEqual(merged.secondarySegments, ["extension_statuses"]);
});

test("mergeSegmentsWithCustomItems applies partial layout rows before disabled filtering", () => {
  const merged = mergeSegmentsWithCustomItems(
    {
      leftSegments: ["path", "model"],
      rightSegments: ["git", "cost", "extension_statuses"],
      secondarySegments: ["extension_statuses"],
      separator: "powerline",
    },
    [
      { id: "ci", statusKey: "ci", position: "right", hideWhenMissing: true, excludeFromExtensionStatuses: true },
      { id: "review", statusKey: "review", position: "secondary", hideWhenMissing: true, excludeFromExtensionStatuses: true },
    ],
    {
      layout: {
        left: ["model", "custom:ci", "extension_statuses"],
        secondary: [],
      },
      disabledSegments: ["model"],
    },
  );

  assert.deepEqual(merged.leftSegments, ["custom:ci", "extension_statuses"]);
  assert.deepEqual(merged.rightSegments, ["git", "cost"]);
  assert.deepEqual(merged.secondarySegments, []);
});

test("nextPowerlineSettingWithPreset preserves object settings", () => {
  const updated = nextPowerlineSettingWithPreset({ preset: "default", customItems: [{ id: "ci" }] }, "compact");
  if (typeof updated !== "object" || updated === null || Array.isArray(updated)) {
    assert.fail("expected an object powerline setting");
  }
  if (!("preset" in updated)) {
    assert.fail("expected preset to be preserved on the updated powerline setting");
  }
  if (!("customItems" in updated)) {
    assert.fail("expected customItems to be preserved on the updated powerline setting");
  }

  assert.equal(updated.preset, "compact");
  assert.deepEqual(updated.customItems, [{ id: "ci" }]);
});

test("nextPowerlineSettingWithOptions preserves object settings", () => {
  const updated = nextPowerlineSettingWithOptions(
    { preset: "default", customItems: [{ id: "ci" }] },
    { placement: "below" },
    "compact",
  );

  assert.deepEqual(updated, { preset: "default", customItems: [{ id: "ci" }], placement: "below" });
});

test("nextPowerlineSettingWithOptions converts string presets to object settings", () => {
  assert.deepEqual(nextPowerlineSettingWithOptions("compact", { placement: "below" }, "compact"), {
    preset: "compact",
    placement: "below",
  });
});

test("collectHiddenExtensionStatusKeys includes default custom status keys", () => {
  const hidden = collectHiddenExtensionStatusKeys([
    { id: "ci", statusKey: "ci-status", position: "right", hideWhenMissing: true, excludeFromExtensionStatuses: true },
    { id: "review", statusKey: "review", position: "secondary", hideWhenMissing: true, excludeFromExtensionStatuses: false },
  ]);

  assert.equal(hidden.has("ci-status"), true);
  assert.equal(hidden.has("review"), false);
});

test("normalizeCompactExtensionStatus strips baked-in trailing separators", () => {
  assert.equal(normalizeCompactExtensionStatus("CI ok · "), "CI ok");
  assert.equal(normalizeCompactExtensionStatus("CI ok |   "), "CI ok");
  assert.equal(normalizeCompactExtensionStatus("[notice] queued"), null);
});

test("normalizeExtensionStatusValue keeps notification-style statuses renderable for custom items", () => {
  assert.equal(normalizeExtensionStatusValue("[review] queued · "), "[review] queued");
});

test("getNotificationExtensionStatuses skips promoted hidden status keys", () => {
  const statuses = new Map<string, string>([
    ["ci-status", "[ci] queued"],
    ["review", "[review] running"],
    ["plain", "plain status"],
  ]);
  const hidden = new Set(["ci-status"]);

  assert.deepEqual(getNotificationExtensionStatuses(statuses, hidden), ["[review] running"]);
});
