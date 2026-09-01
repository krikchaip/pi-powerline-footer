import test from "node:test";
import assert from "node:assert/strict";
import { renderSegment } from "../segments.ts";
import { maxEffortWave } from "../theme.ts";
import type { SegmentContext } from "../types.ts";

function createSegmentContext(overrides: Partial<SegmentContext> = {}): SegmentContext {
  return {
    model: { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
    thinkingLevel: "medium",
    sessionId: undefined,
    cwd: "/tmp/project",
    usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    contextTokens: 0,
    contextPercent: 0,
    contextWindow: 0,
    contextApproximate: false,
    autoCompactEnabled: true,
    customCompactionEnabled: false,
    usingSubscription: false,
    queueSummary: { queueCount: 0, blockedCount: 0, compacting: false, leadingText: null, leadingIntent: null, leadingStatus: null },
    sessionStartTime: Date.now(),
    git: { branch: null, staged: 0, unstaged: 0, untracked: 0 },
    extensionStatuses: new Map(),
    hiddenExtensionStatusKeys: new Set(),
    customItemsById: new Map(),
    options: {},
    theme: { fg: (color, text) => `<${color}>${text}</${color}>` },
    colors: { model: "warning", thinkingMedium: "thinkingMedium" },
    ...overrides,
  };
}

test("model_thinking wrapper prototype keeps model options and styles its complete thinking text", () => {
  const expectedByWrapper = {
    none: "med",
    parentheses: "(med)",
    brackets: "[med]",
  } as const;

  for (const [modelThinkingWrapper, label] of Object.entries(expectedByWrapper)) {
    const rendered = renderSegment("model_thinking", createSegmentContext({
      modelThinkingWrapper: modelThinkingWrapper as keyof typeof expectedByWrapper,
      options: { model: { bold: true } },
    }));

    assert.deepEqual(rendered, {
      content: `<warning>\x1b[1mGPT-5.6 Terra\x1b[22m</warning> <thinkingMedium>${label}</thinkingMedium>`,
      visible: true,
    });
  }
});

test("model_thinking keeps max thinking animation on the selected wrapper", () => {
  const rendered = renderSegment("model_thinking", createSegmentContext({
    thinkingLevel: "max",
    thinkingWaveFrame: 4,
    modelThinkingWrapper: "brackets",
    options: { model: { color: "warning" } },
    colors: {},
    theme: { fg: (_color, text) => text },
  }));

  assert.deepEqual(rendered, {
    content: `GPT-5.6 Terra ${maxEffortWave("[max]", 4)}`,
    visible: true,
  });
});

test("model_thinking omits parentheses when thinking is off", () => {
  const rendered = renderSegment("model_thinking", createSegmentContext({
    thinkingLevel: "off",
  }));

  assert.deepEqual(rendered, {
    content: "<warning>GPT-5.6 Terra</warning>",
    visible: true,
  });
});
