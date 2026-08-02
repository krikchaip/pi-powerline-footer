import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSegment } from "../segments.ts";
import { maxEffortWave, rainbow, rainbowBrightBold } from "../theme.ts";
import type { ColorScheme, SegmentContext, ThemeLike } from "../types.ts";

const extensionSource = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");

function hexAnsi(hex: `#${string}`): string {
  const value = hex.slice(1);
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function createSegmentContext(thinkingLevel: string, colors: ColorScheme): SegmentContext {
  return {
    model: undefined,
    thinkingLevel,
    sessionId: undefined,
    usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, subagentCost: 0 },
    contextTokens: 0,
    contextPercent: 0,
    contextWindow: 0,
    contextApproximate: false,
    autoCompactEnabled: true,
    customCompactionEnabled: false,
    usingSubscription: false,
    sessionStartTime: Date.now(),
    shellModeActive: false,
    shellRunning: false,
    shellName: null,
    shellCwd: null,
    git: { branch: null, staged: 0, unstaged: 0, untracked: 0 },
    extensionStatuses: new Map(),
    hiddenExtensionStatusKeys: new Set(),
    customItemsById: new Map(),
    options: {},
    theme: {
      fg() {
        throw new Error("unexpected theme color lookup in thinking segment test");
      },
    } satisfies ThemeLike,
    colors,
  };
}

test("thinking segment hides off and colors active levels", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "powerline-thinking-agent-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const colors: ColorScheme = {
      thinking: "#111111",
      thinkingMinimal: "#222222",
      thinkingLow: "#333333",
      thinkingMedium: "#444444",
    };

    const off = renderSegment("thinking", createSegmentContext("off", colors));
    const minimal = renderSegment("thinking", createSegmentContext("minimal", colors));
    const low = renderSegment("thinking", createSegmentContext("low", colors));
    const medium = renderSegment("thinking", createSegmentContext("medium", colors));

    assert.deepEqual(off, { content: "", visible: false });
    assert.equal(minimal.content, `${hexAnsi("#222222")}think:min\x1b[0m`);
    assert.equal(low.content, `${hexAnsi("#333333")}think:low\x1b[0m`);
    assert.equal(medium.content, `${hexAnsi("#444444")}think:med\x1b[0m`);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
  }
});

test("thinking segment uses static rainbow styling for high", () => {
  const rendered = renderSegment("thinking", createSegmentContext("high", { thinking: "#111111" }));
  assert.deepEqual(rendered, {
    content: rainbow("think:high"),
    visible: true,
  });
});

test("thinking segment keeps xhigh bold and slightly brighter without animation", () => {
  const firstFrame = renderSegment("thinking", createSegmentContext("xhigh", { thinking: "#111111" }));
  const nextFrame = renderSegment("thinking", {
    ...createSegmentContext("xhigh", { thinking: "#111111" }),
    thinkingWaveFrame: 1,
  });

  assert.deepEqual(firstFrame, {
    content: rainbowBrightBold("think:xhigh"),
    visible: true,
  });
  assert.deepEqual(nextFrame, firstFrame);
  assert.match(firstFrame.content, /^\x1b\[1m\x1b\[38;2;190;148;220mt/);
  assert.doesNotMatch(firstFrame.content, /\x1b\[38;5;/);
});

test("thinking segment flows max through purple, red, and orange shades", () => {
  const firstFrame = renderSegment("thinking", createSegmentContext("max", { thinking: "#111111" }));
  const nextFrame = renderSegment("thinking", {
    ...createSegmentContext("max", { thinking: "#111111" }),
    thinkingWaveFrame: 1,
  });

  assert.deepEqual(firstFrame, {
    content: maxEffortWave("think:max", 0),
    visible: true,
  });
  assert.deepEqual(nextFrame, {
    content: maxEffortWave("think:max", 1),
    visible: true,
  });
  assert.notEqual(firstFrame.content, nextFrame.content);
  assert.match(firstFrame.content, /^\x1b\[1m\x1b\[38;5;57mt\x1b\[39m/);
  assert.match(nextFrame.content, /^\x1b\[1m\x1b\[38;5;93mt\x1b\[39m/);
  assert.match(firstFrame.content, /\x1b\[22m$/);
});

test("max thinking wave repaints from cache only while max effort is active", () => {
  assert.match(extensionSource, /const MAX_THINKING_WAVE_FRAME_MS = 90/);
  assert.match(extensionSource, /import \{ refreshMaxThinkingWave \} from "\.\/thinking-wave\.ts"/);
  assert.match(extensionSource, /let lastLayoutThinkingWaveFrame: number \| null = null/);
  assert.match(extensionSource, /return refreshMaxThinkingWave\(lastLayoutResult, lastLayoutThinkingWaveFrame, Math\.floor\(now \/ MAX_THINKING_WAVE_FRAME_MS\)\)/);
  assert.match(extensionSource, /maxThinkingWaveTimer = setInterval\(\(\) => \{[\s\S]*statusRenderScheduler\.schedule\(0\);/);
  assert.doesNotMatch(extensionSource, /maxThinkingWaveTimer = setInterval\(\(\) => \{\s+resetLayoutCache\(\)/);
  assert.match(extensionSource, /thinkingLevel !== "max"[\s\S]*stopMaxThinkingWave\(\)/);
  assert.match(extensionSource, /pi\.on\("thinking_level_select"[\s\S]*syncMaxThinkingWave\(\)/);
  assert.match(extensionSource, /pi\.on\("session_shutdown"[\s\S]*stopMaxThinkingWave\(\)/);
});
