import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { countStartupTokens, getRecentSessions, loadedCountsFromRuntime, WelcomeHeader } from "../welcome.ts";

const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const WELCOME_HEADER_REMOVED = Symbol.for("pi-powerline-footer.welcome-header-removed");

test("loadedCountsFromRuntime matches Pi's visible loaded-resource collections", () => {
  const resourceLoader = {
    getSystemPromptSource: () => ({ path: "/system.md" }),
    getAppendSystemPromptSources: () => [{ path: "/append-a.md" }, { path: "/append-b.md" }],
    getAgentsFiles: () => ({ agentsFiles: [{ path: "/AGENTS.md" }, { path: "/project/AGENTS.md" }] }),
    getExtensions: () => ({ extensions: [{ hidden: false }, { hidden: true }, {}] }),
    getSkills: () => ({ skills: [{}, {}, {}] }),
  };

  assert.deepEqual(loadedCountsFromRuntime(resourceLoader, [{}, {}, {}, {}]), {
    contextFiles: 5,
    extensions: 2,
    skills: 3,
    promptTemplates: 4,
  });
  assert.deepEqual(loadedCountsFromRuntime(undefined, undefined), {
    contextFiles: 0,
    extensions: 0,
    skills: 0,
    promptTemplates: 0,
  });
});

async function withTemporaryHome(run: (home: string) => void | Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "powerline-welcome-home-"));
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    process.env.HOME = home;
    delete process.env.PI_CODING_AGENT_DIR;
    await run(home);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test("countStartupTokens matches token-burden's startup total", () => {
  assert.equal(countStartupTokens({}), null);
  assert.equal(countStartupTokens({ getSystemPrompt: () => "" }), null);
  assert.equal(countStartupTokens({ getSystemPrompt: () => "   " }), null);
  assert.equal(countStartupTokens({ getSystemPrompt: () => "hello world" }), 2);
  assert.equal(countStartupTokens({ getSystemPrompt: () => "สวัสดีชาวโลก" }), 7);
  assert.equal(countStartupTokens(
    {
      getSystemPrompt: () => "hello world",
      model: { api: "openai-responses", provider: "openai" },
    },
    [{ name: "search", description: "Find things", parameters: { type: "object", properties: {} } }],
    ["search"],
  ), 32);
});

test("welcome renders and refreshes the startup resource burden", () => {
  const counts = { contextFiles: 1, extensions: 1, skills: 1, promptTemplates: 1 };
  const header = new WelcomeHeader("Model", "Provider", [], counts, 1900);
  const rendered = header.render(96).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  header.setLoadedResources(
    { contextFiles: 2, extensions: 3, skills: 4, promptTemplates: 5 },
    2900,
  );
  const refreshed = header.render(96).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  const withoutEstimate = [undefined, 0, Number.NaN].map((tokens) => new WelcomeHeader(
    "Model",
    "Provider",
    [],
    counts,
    tokens,
  ).render(96).join("\n").replace(/\x1b\[[0-9;]*m/g, ""));
  const editorAdjacent = new WelcomeHeader(
    "Model",
    "Provider",
    [],
    counts,
    null,
    { trailingSpacing: false },
  ).render(96);

  assert.match(rendered, /≈ 1\.9k tokens loaded at startup/);
  assert.match(refreshed, /2 context files/);
  assert.match(refreshed, /3 extensions/);
  assert.match(refreshed, /4 skills/);
  assert.match(refreshed, /5 prompt templates/);
  assert.match(refreshed, /≈ 2\.9k tokens loaded at startup/);
  for (const output of withoutEstimate) {
    assert.doesNotMatch(output, /tokens loaded at startup/);
  }
  assert.notEqual(editorAdjacent.at(-1), "");
  assert.match(indexSource, /new WelcomeHeader\(modelName, providerName, recentSessions, loadedCounts, startupTokens, \{/);
  assert.match(indexSource, /modelAppearance: \{/);
  assert.match(indexSource, /function setupWelcomeResourcesBanner/);
  assert.doesNotMatch(indexSource, /function setupWelcomeEditorBanner/);
  assert.doesNotMatch(indexSource, /function setupWelcomeOverlay/);
  assert.doesNotMatch(indexSource, /new WelcomeComponent\(/);
});

test("quiet welcome adds one blank row above the banner", () => {
  const rendered = new WelcomeHeader(
    "Model",
    "Provider",
    [],
    { contextFiles: 0, extensions: 0, skills: 0, promptTemplates: 0 },
    null,
    { leadingSpacing: true },
  ).render(96);

  const verbose = new WelcomeHeader(
    "Model",
    "Provider",
    [],
    { contextFiles: 0, extensions: 0, skills: 0, promptTemplates: 0 },
  ).render(96);

  assert.equal(rendered[0], " ");
  assert.notEqual(rendered[1], "");
  assert.notEqual(verbose[0], " ");
  assert.match(indexSource, /createWelcomeBanner\(ctx, recentSessions, loadedCounts, \{ leadingSpacing: !forceResources \}\)/);
});

test("welcome applies the selected D tones and runtime version title", () => {
  const themeKey = Symbol.for("@earendil-works/pi-coding-agent:theme");
  const previousTheme = Reflect.get(globalThis, themeKey);
  const toneCode: Record<string, number> = {
    dim: 101,
    muted: 102,
    border: 103,
    borderAccent: 104,
    accent: 105,
    warning: 107,
  };
  Reflect.set(globalThis, themeKey, {
    fg(color: string, text: string) {
      return `\x1b[38;5;${toneCode[color] ?? 106}m${text}\x1b[0m`;
    },
    bold(text: string) {
      return `\x1b[1m${text}\x1b[22m`;
    },
  });

  try {
    const output = new WelcomeHeader(
      "Model",
      "Provider",
      [{ name: "project", timeAgo: "2m ago" }],
      { contextFiles: 2, extensions: 29, skills: 1, promptTemplates: 0 },
      4200,
      {
        modelAppearance: {
          color: "warning",
          colors: { model: "error" },
          bold: true,
        },
      },
    ).render(96).join("\n");
    const presetOutput = new WelcomeHeader(
      "Preset Model",
      "Provider",
      [],
      { contextFiles: 0, extensions: 0, skills: 0, promptTemplates: 0 },
      null,
      { modelAppearance: { colors: { model: "warning" } } },
    ).render(96).join("\n");
    const plainOutput = output.replace(/\x1b\[[0-9;]*m/g, "");

    assert.match(plainOutput, new RegExp(`Pi v${VERSION.replaceAll(".", "\\.")}`));
    assert.ok(presetOutput.includes("\x1b[38;5;107mPreset Model\x1b[0m"));
    assert.match(output, /\x1b\[38;5;101mProvider/);
    assert.match(output, /\x1b\[38;5;101m- /);
    assert.match(output, /\x1b\[38;5;101m• /);
    for (const value of ["2", "29", "1", "≈ 4.2k", "/", "!", " (2m ago)"]) {
      assert.ok(output.includes(`\x1b[38;5;102m${value}`));
    }
    assert.match(output, /\x1b\[38;5;102mctrl\+t/);
    assert.match(output, /\x1b\[38;5;103m╭/);
    assert.deepEqual({
      modelAppearance: output.includes("\x1b[38;5;107m\x1b[1mModel\x1b[22m\x1b[0m"),
      recentSessionText: output.includes("\x1b[38;5;101m• \x1b[0mproject\x1b[38;5;102m (2m ago)"),
    }, {
      modelAppearance: true,
      recentSessionText: true,
    });
  } finally {
    if (previousTheme === undefined) Reflect.deleteProperty(globalThis, themeKey);
    else Reflect.set(globalThis, themeKey, previousTheme);
  }
});

test("welcome keeps its versioned top-right border aligned", () => {
  const lines = new WelcomeHeader(
    "Model",
    "Provider",
    [{ name: "project", timeAgo: "2m ago" }],
    { contextFiles: 2, extensions: 29, skills: 1, promptTemplates: 0 },
    4200,
  ).render(96).filter((line) => line !== "");

  assert.equal(lines[0]?.replace(/\x1b\[[0-9;]*m/g, "").endsWith("╮"), true);
  for (const line of lines) assert.equal(visibleWidth(line), 94);
});

test("getRecentSessions uses the latest session name instead of its path", async () => {
  await withTemporaryHome(async (home) => {
    const sessionsDir = join(home, ".pi", "agent", "sessions", "project");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "session.jsonl"), [
      JSON.stringify({ type: "session", cwd: "/Users/nico/Desktop/private-project" }),
      JSON.stringify({ type: "session_info", name: "Old session name" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "session_info", name: "Powerline metrics audit" }),
      "",
    ].join("\n"));

    assert.equal((await getRecentSessions(1))[0]?.name, "Powerline metrics audit");
  });
});

test("welcome expands to show a complete long session name with right padding", () => {
  const name = "Powerline footer loaded-resource metrics and startup token burden verification";
  const lines = new WelcomeHeader(
    "Model",
    "Provider",
    [{ name, timeAgo: "2m ago" }],
    { contextFiles: 1, extensions: 1, skills: 1, promptTemplates: 1 },
    1900,
  ).render(140).filter((line) => line !== "");
  const plain = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

  assert.ok(visibleWidth(lines[0]!) > 96);
  assert.ok(plain.includes(`${name} (2m ago) │`));
  assert.doesNotMatch(plain, /…/);
  for (const line of lines) assert.equal(visibleWidth(line), visibleWidth(lines[0]!));
});

test("getRecentSessions labels sessions without an active name as anonymous", async () => {
  await withTemporaryHome(async (home) => {
    const sessionsDir = join(home, ".pi", "agent", "sessions", "project");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "session.jsonl"), [
      JSON.stringify({ type: "session", cwd: "/Users/nico/Desktop/private-project" }),
      JSON.stringify({ type: "session_info", name: "Name that was cleared" }),
      JSON.stringify({ type: "session_info", name: "  " }),
      "",
    ].join("\n"));

    assert.equal((await getRecentSessions(1))[0]?.name, "Anonymous");
  });
});

test("persistent welcome banner does not use the removed overlay", () => {
  assert.ok(indexSource.includes("function setupWelcomeResourcesBanner"));
  assert.ok(indexSource.includes("new WelcomeHeader"));
  assert.equal(indexSource.includes("function setupWelcomeOverlay"), false);
});

test("getRecentSessions reads custom agent sessions and existing legacy sessions", async () => {
  await withTemporaryHome(async (home) => {
    const root = mkdtempSync(join(tmpdir(), "powerline-welcome-sessions-"));
    const agentDir = join(root, "agent-dir");

    try {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const customSessionDir = join(agentDir, "sessions", "--custom--");
      const legacySessionDir = join(home, ".pi", "sessions", "--legacy--");
      mkdirSync(customSessionDir, { recursive: true });
      mkdirSync(legacySessionDir, { recursive: true });
      writeFileSync(join(customSessionDir, "session.jsonl"), [
        JSON.stringify({ type: "session", cwd: "/tmp/custom-project" }),
        JSON.stringify({ type: "session_info", name: "Custom agent session" }),
        "",
      ].join("\n"));
      writeFileSync(join(legacySessionDir, "session.jsonl"), [
        JSON.stringify({ type: "session", cwd: "/tmp/legacy-project" }),
        JSON.stringify({ type: "session_info", name: "Legacy session" }),
        "",
      ].join("\n"));

      const names = (await getRecentSessions(10)).map((session) => session.name);
      assert.ok(names.includes("Custom agent session"));
      assert.ok(names.includes("Legacy session"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("getRecentSessions selects newest distinct names across a large nested archive", async () => {
  await withTemporaryHome(async (home) => {
    const root = join(home, ".pi", "agent", "sessions");
    const nested = join(root, "--encoded--", "artifacts", "nested");
    mkdirSync(nested, { recursive: true });
    const now = Date.now();
    for (let i = 0; i < 1000; i++) {
      const file = join(nested, `${i}.jsonl`);
      writeFileSync(file, JSON.stringify({ type: "session_info", name: "Older session" }) + "\n");
      utimesSync(file, (now - 86_400_000) / 1000, (now - 86_400_000) / 1000);
    }
    const recent = [
      ["a.jsonl", JSON.stringify({ type: "session_info", name: "Metrics audit" }), 60_000],
      ["b.jsonl", JSON.stringify({ type: "session_info", name: "Metrics audit" }), 120_000],
      ["c.jsonl", "not-json", 180_000],
      ["d.jsonl", JSON.stringify({ type: "session_info", name: "Third session" }), 240_000],
    ] as const;
    for (const [name, header, age] of recent) {
      const file = join(nested, name);
      writeFileSync(file, header + "\n" + "ignored body".repeat(1000));
      utimesSync(file, (now - age) / 1000, (now - age) / 1000);
    }

    assert.deepEqual(await getRecentSessions(), [
      { name: "Metrics audit", timeAgo: "1m ago" },
      { name: "Anonymous", timeAgo: "3m ago" },
      { name: "Third session", timeAgo: "4m ago" },
    ]);
  });
});

test("getRecentSessions overlaps bounded metadata reads for responsive startup", async () => {
  await withTemporaryHome(async (home) => {
    const root = join(home, ".pi", "agent", "sessions");
    mkdirSync(root, { recursive: true });
    for (let i = 0; i < 24; i++) {
      writeFileSync(join(root, `${i}.jsonl`), JSON.stringify({ type: "session_info", name: `Session ${i}` }) + "\n");
    }

    const originalStat = fsPromises.stat;
    let activeStats = 0;
    let peakStats = 0;
    fsPromises.stat = (async (...args: Parameters<typeof fsPromises.stat>) => {
      activeStats += 1;
      peakStats = Math.max(peakStats, activeStats);
      await setImmediate();
      try {
        return await originalStat(...args);
      } finally {
        activeStats -= 1;
      }
    }) as typeof fsPromises.stat;
    syncBuiltinESMExports();

    try {
      await getRecentSessions();
      assert.ok(peakStats > 1, `expected overlapping metadata reads, observed ${peakStats}`);
      assert.ok(peakStats <= 16, `expected bounded metadata reads, observed ${peakStats}`);
    } finally {
      fsPromises.stat = originalStat;
      syncBuiltinESMExports();
    }
  });
});

test("getRecentSessions settles metadata reads before rejecting an abort", async () => {
  await withTemporaryHome(async (home) => {
    const root = join(home, ".pi", "agent", "sessions");
    mkdirSync(root, { recursive: true });
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(root, `${i}.jsonl`), JSON.stringify({ type: "session_info", name: `Session ${i}` }) + "\n");
    }

    const controller = new AbortController();
    const originalStat = fsPromises.stat;
    let releaseStat!: () => void;
    const blockedStat = new Promise<void>((resolve) => { releaseStat = resolve; });
    let signalStatStarted!: () => void;
    const statStarted = new Promise<void>((resolve) => { signalStatStarted = resolve; });
    let firstStat = true;
    fsPromises.stat = (async (...args: Parameters<typeof fsPromises.stat>) => {
      if (firstStat) {
        firstStat = false;
        controller.abort();
        signalStatStarted();
        await blockedStat;
      }
      return originalStat(...args);
    }) as typeof fsPromises.stat;
    syncBuiltinESMExports();

    const result = getRecentSessions(3, controller.signal);
    const rejection = assert.rejects(result, { name: "AbortError" });
    let settled = false;
    void rejection.then(() => { settled = true; }, () => { settled = true; });
    try {
      await statStarted;
      await setImmediate();
      assert.equal(settled, false, "abort rejected before in-flight metadata settled");
    } finally {
      releaseStat();
      await rejection;
      fsPromises.stat = originalStat;
      syncBuiltinESMExports();
    }
  });
});

test("getRecentSessions rejects pre-aborted and in-flight discovery without partial results", async () => {
  await withTemporaryHome(async (home) => {
    const root = join(home, ".pi", "agent", "sessions");
    mkdirSync(root, { recursive: true });
    for (let i = 0; i < 100; i++) {
      writeFileSync(join(root, `${i}.jsonl`), JSON.stringify({ cwd: `/projects/${i}` }) + "\n");
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(getRecentSessions(3, controller.signal), { name: "AbortError" });

    const running = new AbortController();
    const result = getRecentSessions(3, running.signal);
    const rejected = assert.rejects(result, { name: "AbortError" });
    await setImmediate();
    running.abort();
    await rejected;
    // Cleanup immediately after completion also exercises closed handles on Windows.
    rmSync(root, { recursive: true });
    assert.deepEqual(await getRecentSessions(), []);
  });
});

test("getRecentSessions follows nested directory links without looping", async () => {
  await withTemporaryHome(async (home) => {
    const root = join(home, ".pi", "agent", "sessions");
    const archive = join(home, "archive");
    mkdirSync(root, { recursive: true });
    mkdirSync(archive);
    writeFileSync(join(archive, "session.jsonl"), JSON.stringify({ type: "session_info", name: "Linked session" }) + "\n");
    symlinkSync(archive, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    symlinkSync(root, join(archive, "cycle"), process.platform === "win32" ? "junction" : "dir");
    assert.deepEqual(await getRecentSessions(), [{ name: "Linked session", timeAgo: "just now" }]);
  });
});

type WelcomeView = { render(width: number): string[]; handleInput?(data: string): void };
type WelcomeEditor = { getText(): string; handleInput(data: string): void };

async function welcomeHarness(t: test.TestContext, home: string, quietStartup: boolean) {
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    quietStartup, powerline: { welcome: true }, bashMode: { completions: false },
  }));
  const { default: extension } = await import("../index.ts");
  const { KeybindingsManager } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js", import.meta.url).href);
  const timeouts = new Map<object, () => unknown>();
  t.mock.method(globalThis, "setTimeout", (callback: () => unknown) => {
    const handle = {};
    timeouts.set(handle, callback);
    return handle;
  });
  t.mock.method(globalThis, "clearTimeout", (handle: object) => timeouts.delete(handle));
  const tui = { requestRender() {}, terminal: { columns: 96, rows: 30 } };
  let editor: WelcomeEditor;
  let view: WelcomeView | undefined;
  let headerFactory: (() => WelcomeView) | undefined;
  let installations = 0;
  const ctx = {
    cwd: home, hasUI: true, model: { name: "Test model", provider: "test" }, modelRegistry: {},
    sessionManager: { getBranch: () => [], getSessionId: () => "welcome-test" },
    ui: {
      getEditorText: () => editor?.getText() ?? "",
      setEditorComponent(factory?: (tui: object, theme: object, keys: object) => WelcomeEditor) {
        if (factory) editor = factory(tui, {}, KeybindingsManager.create());
      },
      getEditorComponent: () => undefined,
      setHeader(factory?: () => WelcomeView) {
        const metadata = headerFactory as unknown as Record<symbol, unknown> | undefined;
        const onRemoved = metadata?.[WELCOME_HEADER_REMOVED];
        if (typeof onRemoved === "function") onRemoved();
        headerFactory = factory;
        view = factory?.();
        if (view) installations++;
      },
      custom(factory: (tui: object, theme: object, keys: object, done: () => void) => WelcomeView) {
        return new Promise<void>((resolve) => {
          view = factory(tui, {}, {}, () => { view = undefined; resolve(); });
          installations++;
        });
      },
      setWidget(key: string, factory?: () => WelcomeView) {
        if (key !== "powerline-welcome") return;
        view = factory?.();
        if (view) installations++;
      },
      setStatus() {}, setFooter() {}, setWorkingMessage() {}, notify() {},
      onTerminalInput: () => () => {},
    },
  };
  type Handler = (event: { reason?: string }, context: typeof ctx) => unknown;
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand() {},
    sendUserMessage() {},
    getAllTools: () => [],
    getActiveTools: () => [],
  };
  (extension as unknown as (api: typeof pi) => void)(pi);
  return {
    ctx,
    get view() { return view; },
    get installations() { return installations; },
    type: (text: string) => editor.handleInput(text),
    event: async (name: string, reason?: string) => { await handlers.get(name)?.({ reason }, ctx); },
    runStartupWork: () => {
      const callbacks = [...timeouts.values()];
      timeouts.clear();
      return Promise.all(callbacks.map((callback) => callback()));
    },
  };
}

test("eligible welcome installs and persists without losing input", async (t) => {
  for (const quiet of [true, false]) {
    await t.test(quiet ? "quiet" : "normal", async (t) => {
      await withTemporaryHome(async (home) => {
        const harness = await welcomeHarness(t, home, quiet);
        try {
          await harness.event("session_start", "startup");
          await harness.runStartupWork();
          const view = harness.view;
          assert.ok(view);
          assert.match(view.render(96).join("\n"), /Test model/);
          harness.type("x");
          assert.equal(harness.ctx.ui.getEditorText(), "x");
          assert.equal(Boolean(harness.view), true);
          assert.equal(harness.installations, 1);
        } finally {
          await harness.event("session_shutdown");
          t.mock.restoreAll();
        }
      });
    });
  }
});
