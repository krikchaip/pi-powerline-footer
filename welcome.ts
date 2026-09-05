import { readFileSync, realpathSync } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { VERSION as PACKAGE_VERSION, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth as tuiTruncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { getAgentPath, getLegacyPiPath } from "./paths.ts";
import { applyColor, fg } from "./theme.ts";
import type { ColorScheme, ColorValue } from "./types.ts";

export interface RecentSession {
  name: string;
  timeAgo: string;
}

export interface LoadedCounts {
  contextFiles: number;
  extensions: number;
  skills: number;
  promptTemplates: number;
}

export interface WelcomeModelAppearance {
  color?: ColorValue;
  colors?: ColorScheme;
  bold?: boolean;
}

export interface WelcomeHeaderOptions {
  leadingSpacing?: boolean;
  trailingSpacing?: boolean;
  modelAppearance?: WelcomeModelAppearance;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return tokens.toString();
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens < 1000000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1000000).toFixed(tokens < 10000000 ? 1 : 0)}M`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared rendering utilities
// ═══════════════════════════════════════════════════════════════════════════

// The established Powerline logo shape. Each visible cell receives the animated gradient.
const PI_LOGO = [
  "██████████    ",
  "████  ████    ",
  "████  ████    ",
  "████████  ████",
  "████      ████",
  "████      ████",
] as const;

const GRADIENT_STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [255, 92, 200], [200, 110, 255], [120, 130, 255], [60, 200, 255], [120, 255, 220],
];
const GRADIENT_RAMP_256 = [199, 171, 135, 99, 75, 51, 87];
const SHINE_HALF_WIDTH = 0.18;
const INTRO_MS = 3000;
const INTRO_TICK_MS = 33;
const INTRO_SWEEPS = 2.5;
const INTRO_SHINE_TRAVERSALS = 1;
const TRUE_COLOR = process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit";
const SESSION_TAIL_READ_BYTES = 64 * 1024;
const ANONYMOUS_SESSION_NAME = "Anonymous";

/** Prefer the running Pi CLI's VERSION over this extension's development dependency. */
function getRuntimeVersion(): string {
  const cliEntry = process.argv[1];
  if (!cliEntry) return PACKAGE_VERSION;
  try {
    const packageRoot = dirname(dirname(realpathSync(cliEntry)));
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (packageJson.name === "@earendil-works/pi-coding-agent" && typeof packageJson.version === "string") {
      return packageJson.version;
    }
  } catch {
    // Tests and embedded Pi runtimes do not always expose a CLI entry path.
  }
  return PACKAGE_VERSION;
}

const PI_VERSION = getRuntimeVersion();

const PROVIDER_TONE: ThemeColor = "dim";
const BULLET_TONE: ThemeColor = "dim";
const SECONDARY_TONE: ThemeColor = "muted";
const BORDER_TONE: ThemeColor = "border"; // Selected C2: active theme border.
const SECTION_TONE: ThemeColor = "borderAccent";

type WelcomeTheme = Pick<Theme, "fg" | "bold">;
type ShineConfig = { strength: number; pos: number };

const PLAIN_WELCOME_THEME: WelcomeTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function getRuntimeTheme(): WelcomeTheme {
  const theme = Reflect.get(globalThis, Symbol.for("@earendil-works/pi-coding-agent:theme"));
  if (
    typeof theme === "object"
    && theme !== null
    && typeof Reflect.get(theme, "fg") === "function"
    && typeof Reflect.get(theme, "bold") === "function"
  ) {
    return theme as WelcomeTheme;
  }
  return PLAIN_WELCOME_THEME;
}

function gradientEscape(t: number, shine?: ShineConfig): string {
  const strength = shine?.strength ?? 0;
  const position = shine?.pos ?? 0;
  if (TRUE_COLOR) {
    const segment = t * (GRADIENT_STOPS.length - 1);
    const index = Math.min(GRADIENT_STOPS.length - 2, Math.floor(segment));
    const fraction = segment - index;
    const from = GRADIENT_STOPS[index]!;
    const to = GRADIENT_STOPS[index + 1]!;
    let r = from[0] + (to[0] - from[0]) * fraction;
    let g = from[1] + (to[1] - from[1]) * fraction;
    let b = from[2] + (to[2] - from[2]) * fraction;
    const intensity = Math.max(0, 1 - Math.abs(t - position) / SHINE_HALF_WIDTH) * strength;
    r += (255 - r) * intensity;
    g += (255 - g) * intensity;
    b += (255 - b) * intensity;
    return `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(b)}m`;
  }
  let index = Math.min(GRADIENT_RAMP_256.length - 1, Math.max(0, Math.floor(t * (GRADIENT_RAMP_256.length - 1) + 0.5)));
  if (Math.max(0, 1 - Math.abs(t - position) / SHINE_HALF_WIDTH) * strength > 0.5) index = GRADIENT_RAMP_256.length - 1;
  return `\x1b[38;5;${GRADIENT_RAMP_256[index]}m`;
}

function gradientLogo(phase = 0, shine?: ShineConfig): string[] {
  const rows = PI_LOGO.length;
  const columns = Math.max(...PI_LOGO.map((line) => line.length));
  const span = Math.max(1, columns + rows - 1);
  return PI_LOGO.map((line, y) => {
    let output = "";
    for (let x = 0; x < line.length; x++) {
      const cell = line[x]!;
      if (cell === " ") {
        output += cell;
        continue;
      }
      const base = (x + (rows - 1 - y)) / span;
      const t = ((base + phase) % 1 + 1) % 1;
      output += gradientEscape(t, shine) + cell + "\x1b[0m";
    }
    return output;
  });
}

const REST_LOGO = gradientLogo();

function introLogoFrame(progress: number): string[] {
  const eased = 1 - (1 - progress) ** 3;
  const phase = (((1 - eased) * INTRO_SWEEPS) % 1 + 1) % 1;
  const shinePos = ((progress * INTRO_SHINE_TRAVERSALS) % 1 + 1) % 1;
  return gradientLogo(phase, { strength: (1 - eased) ** 1.5, pos: shinePos });
}

function centerText(text: string, width: number): string {
  const visLen = visibleWidth(text);
  if (visLen > width) return tuiTruncateToWidth(text, width, "…");
  if (visLen === width) return text;
  const leftPad = Math.floor((width - visLen) / 2);
  const rightPad = width - visLen - leftPad;
  return " ".repeat(leftPad) + text + " ".repeat(rightPad);
}

function fitToWidth(str: string, width: number): string {
  const visLen = visibleWidth(str);
  if (visLen > width) return tuiTruncateToWidth(str, width, "…");
  return str + " ".repeat(width - visLen);
}

interface WelcomeData {
  modelName: string;
  providerName: string;
  recentSessions: RecentSession[];
  loadedCounts: LoadedCounts;
  startupTokens: number | null;
  modelAppearance: WelcomeModelAppearance;
}

interface InitialToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

type ToolEnvelope = "openai-responses" | "openai-chat" | "anthropic" | "bedrock" | "google" | "mistral";

function toolEnvelopeForModel(api?: string, provider?: string): ToolEnvelope {
  switch (api) {
    case "anthropic-messages": return "anthropic";
    case "bedrock-converse-stream": return "bedrock";
    case "google-generative-ai":
    case "google-vertex": return "google";
    case "mistral-conversations": return "mistral";
    case "openai-completions": return "openai-chat";
    case "azure-openai-responses":
    case "openai-codex-responses":
    case "openai-responses": return "openai-responses";
  }

  const normalizedProvider = provider?.toLowerCase() ?? "";
  if (normalizedProvider.includes("anthropic")) return "anthropic";
  if (normalizedProvider.includes("bedrock") || normalizedProvider.includes("amazon")) return "bedrock";
  if (normalizedProvider.includes("google") || normalizedProvider.includes("gemini") || normalizedProvider.includes("vertex")) return "google";
  if (normalizedProvider.includes("mistral")) return "mistral";
  return "openai-responses";
}

function toolPayload(tool: InitialToolDefinition, envelope: ToolEnvelope): unknown {
  if (envelope === "openai-responses") {
    return { type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false };
  }
  if (envelope === "openai-chat" || envelope === "mistral") {
    return {
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters, strict: false },
    };
  }
  if (envelope === "anthropic") {
    const parameters = typeof tool.parameters === "object" && tool.parameters !== null
      ? tool.parameters as Record<string, unknown>
      : {};
    return {
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: "object",
        properties: parameters.properties ?? {},
        required: parameters.required ?? [],
      },
    };
  }
  if (envelope === "bedrock") {
    return {
      toolSpec: {
        name: tool.name,
        description: tool.description,
        inputSchema: { json: tool.parameters },
      },
    };
  }
  return { name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters };
}

function toolEnvelopePayload(tools: readonly InitialToolDefinition[], envelope: ToolEnvelope): unknown {
  const toolsPayload = tools.map((tool) => toolPayload(tool, envelope));
  if (envelope === "bedrock") return { tools: toolsPayload };
  if (envelope === "google") return [{ functionDeclarations: toolsPayload }];
  return toolsPayload;
}

/** Count the startup prompt and active tool schemas exactly like pi-token-burden. */
export function countStartupTokens(
  ctx: unknown,
  allTools: readonly InitialToolDefinition[] = [],
  activeToolNames?: readonly string[],
): number | null {
  if (typeof ctx !== "object" || ctx === null || typeof Reflect.get(ctx, "getSystemPrompt") !== "function") {
    return null;
  }

  const prompt: unknown = Reflect.get(ctx, "getSystemPrompt").call(ctx);
  if (typeof prompt !== "string" || !prompt.trim()) return null;

  let total = encode(prompt).length;
  if (allTools.length === 0) return total;

  const model = Reflect.get(ctx, "model");
  const api = typeof model === "object" && model !== null && typeof Reflect.get(model, "api") === "string"
    ? Reflect.get(model, "api") as string
    : undefined;
  const provider = typeof model === "object" && model !== null && typeof Reflect.get(model, "provider") === "string"
    ? Reflect.get(model, "provider") as string
    : undefined;
  const activeSet = activeToolNames ? new Set(activeToolNames) : null;
  const activeTools = activeSet ? allTools.filter((tool) => activeSet.has(tool.name)) : allTools;
  const payload = toolEnvelopePayload(activeTools, toolEnvelopeForModel(api, provider));
  total += encode(JSON.stringify(payload)).length;
  return total;
}

function styleModel(theme: WelcomeTheme, modelName: string, appearance: WelcomeModelAppearance): string {
  const content = appearance.bold ? theme.bold(modelName) : modelName;
  return appearance.color
    ? applyColor(theme, appearance.color, content)
    : fg(theme, "model", content, appearance.colors);
}

function buildLeftColumn(data: WelcomeData, colWidth: number, theme: WelcomeTheme, logo: readonly string[]): string[] {
  return [
    "",
    centerText(theme.bold("Welcome back!"), colWidth),
    "",
    ...logo.map((line) => centerText(line, colWidth)),
    "",
    centerText(styleModel(theme, data.modelName, data.modelAppearance), colWidth),
    centerText(theme.fg(PROVIDER_TONE, data.providerName), colWidth),
  ];
}

function buildRightColumn(data: WelcomeData, colWidth: number, theme: WelcomeTheme): string[] {
  const separator = ` ${theme.fg(BORDER_TONE, "─".repeat(colWidth - 2))}`;
  const bullet = theme.fg(BULLET_TONE, "- ");
  const countLine = (count: number, label: string) => ` ${bullet}${theme.fg(SECONDARY_TONE, `${count}`)} ${label}`;
  const countLines: string[] = [];
  const { contextFiles, extensions, skills, promptTemplates } = data.loadedCounts;

  if (contextFiles > 0 || extensions > 0 || skills > 0 || promptTemplates > 0) {
    if (contextFiles > 0) countLines.push(countLine(contextFiles, `context file${contextFiles !== 1 ? "s" : ""}`));
    if (extensions > 0) countLines.push(countLine(extensions, `extension${extensions !== 1 ? "s" : ""}`));
    if (skills > 0) countLines.push(countLine(skills, `skill${skills !== 1 ? "s" : ""}`));
    if (promptTemplates > 0) countLines.push(countLine(promptTemplates, `prompt template${promptTemplates !== 1 ? "s" : ""}`));
  } else {
    countLines.push(` ${theme.fg(PROVIDER_TONE, "No extensions loaded")}`);
  }

  if (
    data.startupTokens !== null
    && Number.isFinite(data.startupTokens)
    && data.startupTokens > 0
  ) {
    countLines.push(` ${bullet}${theme.fg(SECONDARY_TONE, `≈ ${formatTokens(data.startupTokens)}`)} tokens loaded at startup`);
  }

  const sessionLines = (data.recentSessions.length === 0
    ? [` ${theme.fg(PROVIDER_TONE, "No recent sessions")}`]
    : data.recentSessions.slice(0, 3).map((session) => (
      ` ${theme.fg(BULLET_TONE, "• ")}${session.name}${theme.fg(SECONDARY_TONE, ` (${session.timeAgo})`)}`
    ))).flatMap((line) => wrapTextWithAnsi(line, colWidth));

  return [
    ` ${theme.bold(theme.fg(SECTION_TONE, "Tips"))}`,
    ` ${theme.fg(SECONDARY_TONE, "/")} for commands`,
    ` ${theme.fg(SECONDARY_TONE, "!")} to run bash`,
    ` ${theme.fg(SECONDARY_TONE, "ctrl+t")} cycle thinking`,
    separator,
    ` ${theme.bold(theme.fg(SECTION_TONE, "Loaded"))}`,
    ...countLines,
    separator,
    ` ${theme.bold(theme.fg(SECTION_TONE, "Recent sessions"))}`,
    ...sessionLines,
    "",
  ];
}

function renderWelcomeBox(
  data: WelcomeData,
  termWidth: number,
  theme: WelcomeTheme,
  logo: readonly string[],
): string[] {
  // Minimum width for two-column layout: leftCol(26) + separator(3) + minRightCol(15) = 44.
  if (termWidth < 44) return [];

  const leftCol = 26;
  const maxSessionLineWidth = data.recentSessions.reduce(
    (maxWidth, session) => Math.max(maxWidth, visibleWidth(` • ${session.name} (${session.timeAgo})`)),
    0,
  );
  const requiredBoxWidth = leftCol + 3 + maxSessionLineWidth + 1;
  const maxBoxWidth = termWidth >= 76 ? termWidth - 2 : termWidth;
  const boxWidth = Math.min(maxBoxWidth, Math.max(76, 96, requiredBoxWidth));
  const rightCol = Math.max(1, boxWidth - leftCol - 3);
  const border = (glyph: string) => theme.fg(BORDER_TONE, glyph);
  const leftLines = buildLeftColumn(data, leftCol, theme, logo);
  const rightLines = buildRightColumn(data, rightCol, theme);
  const lines: string[] = [];

  // Use fewer rule cells for the longer versioned title. The right corner stays fixed.
  const titleText = ` Pi v${PI_VERSION} `;
  const title = theme.bold(theme.fg("accent", "Pi")) + theme.fg("muted", ` v${PI_VERSION}`);
  const afterTitle = boxWidth - 2 - 3 - visibleWidth(titleText);
  lines.push(border("╭") + border("─".repeat(3)) + ` ${title} ` + border("─".repeat(Math.max(0, afterTitle))) + border("╮"));

  const maxRows = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < maxRows; i++) {
    const left = fitToWidth(leftLines[i] ?? "", leftCol);
    const right = fitToWidth(rightLines[i] ?? "", rightCol);
    lines.push(border("│") + left + border("│") + right + border("│"));
  }

  lines.push(border("╰") + border("─".repeat(leftCol)) + border("┴") + border("─".repeat(rightCol)) + border("╯"));
  return lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// Welcome Components
// ═══════════════════════════════════════════════════════════════════════════

/** Persistent welcome banner rendered after Pi's loaded-resource sections. */
export class WelcomeHeader implements Component {
  private readonly data: WelcomeData;
  private readonly leadingSpacing: boolean;
  private readonly trailingSpacing: boolean;
  private startedAt: number | undefined;
  private introTimer: ReturnType<typeof setInterval> | undefined;
  private requestRender: (() => void) | undefined;

  constructor(
    modelName: string,
    providerName: string,
    recentSessions: RecentSession[] = [],
    loadedCounts: LoadedCounts = { contextFiles: 0, extensions: 0, skills: 0, promptTemplates: 0 },
    startupTokens: number | null = null,
    options: WelcomeHeaderOptions = {},
  ) {
    this.data = {
      modelName,
      providerName,
      recentSessions,
      loadedCounts,
      startupTokens,
      modelAppearance: options.modelAppearance ?? {},
    };
    this.leadingSpacing = options.leadingSpacing ?? false;
    this.trailingSpacing = options.trailingSpacing ?? true;
  }

  /** Start the one-shot logo animation after Pi attaches this component to its TUI. */
  setRequestRender(requestRender: () => void): void {
    this.requestRender = requestRender;
    if (this.introTimer || this.startedAt !== undefined) return;
    this.startedAt = performance.now();
    this.introTimer = setInterval(() => {
      if (performance.now() - this.startedAt! >= INTRO_MS) {
        clearInterval(this.introTimer);
        this.introTimer = undefined;
      }
      requestRender();
    }, INTRO_TICK_MS);
  }

  setRecentSessions(recentSessions: RecentSession[]): void {
    this.data.recentSessions = recentSessions;
    this.requestRender?.();
  }

  setLoadedResources(loadedCounts: LoadedCounts, startupTokens: number | null): void {
    this.data.loadedCounts = loadedCounts;
    this.data.startupTokens = startupTokens;
    this.requestRender?.();
  }

  dispose(): void {
    if (this.introTimer) clearInterval(this.introTimer);
    this.introTimer = undefined;
    this.requestRender = undefined;
  }

  invalidate(): void {}

  render(termWidth: number): string[] {
    const elapsed = this.startedAt === undefined ? INTRO_MS : performance.now() - this.startedAt;
    const logo = elapsed < INTRO_MS ? introLogoFrame(elapsed / INTRO_MS) : REST_LOGO;
    const lines = renderWelcomeBox(this.data, termWidth, getRuntimeTheme(), logo);
    if (this.leadingSpacing && lines.length > 0) lines.unshift(" ");
    if (this.trailingSpacing && lines.length > 0) lines.push("");
    return lines;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Discovery functions
// ═══════════════════════════════════════════════════════════════════════════

const loggedDiscoveryErrors = new Set<string>();

function logDiscoveryError(scope: string, error: unknown): void {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  ) {
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  const key = `${scope}:${message}`;
  if (loggedDiscoveryErrors.has(key)) {
    return;
  }

  loggedDiscoveryErrors.add(key);
  if (loggedDiscoveryErrors.size > 500) {
    loggedDiscoveryErrors.clear();
  }

  console.debug(`[powerline-welcome] ${scope}:`, error);
}

export interface WelcomeResourceLoader {
  getSystemPromptSource(): { path: string } | undefined;
  getAppendSystemPromptSources(): readonly { path: string }[];
  getAgentsFiles(): { agentsFiles: readonly { path: string }[] };
  getExtensions(): { extensions: readonly { hidden?: boolean }[] };
  getSkills(): { skills: readonly unknown[] };
}

/** Count the same loaded-resource collections that Pi renders at startup. */
export function loadedCountsFromRuntime(
  resourceLoader: WelcomeResourceLoader | undefined,
  promptTemplates: readonly unknown[] | undefined,
): LoadedCounts {
  if (!resourceLoader) {
    return { contextFiles: 0, extensions: 0, skills: 0, promptTemplates: 0 };
  }

  const contextFiles = (resourceLoader.getSystemPromptSource() ? 1 : 0)
    + resourceLoader.getAppendSystemPromptSources().length
    + resourceLoader.getAgentsFiles().agentsFiles.length;
  const extensions = resourceLoader.getExtensions().extensions.filter((extension) => !extension.hidden).length;
  const skills = resourceLoader.getSkills().skills.length;

  return {
    contextFiles,
    extensions,
    skills,
    promptTemplates: promptTemplates?.length ?? 0,
  };
}

/** Read Pi's active display name from the latest session_info entry. */
async function readLatestSessionName(
  filePath: string,
  fileSize: number,
  signal?: AbortSignal,
): Promise<string> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    signal?.throwIfAborted();
    file = await open(filePath, "r");
    let position = fileSize;
    let partialLine = Buffer.alloc(0);

    while (position > 0) {
      signal?.throwIfAborted();
      const bytesToRead = Math.min(SESSION_TAIL_READ_BYTES, position);
      position -= bytesToRead;
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
      signal?.throwIfAborted();
      const content = Buffer.concat([buffer.subarray(0, bytesRead), partialLine]);
      let completeStart = 0;

      if (position > 0) {
        const firstNewline = content.indexOf(0x0a);
        if (firstNewline < 0) {
          partialLine = content;
          continue;
        }
        partialLine = Buffer.from(content.subarray(0, firstNewline));
        completeStart = firstNewline + 1;
      }

      let lineEnd = content.length;
      while (lineEnd >= completeStart) {
        const previousNewline = lineEnd > completeStart
          ? content.lastIndexOf(0x0a, lineEnd - 1)
          : -1;
        const lineStart = Math.max(completeStart, previousNewline + 1);
        const line = content.toString("utf8", lineStart, lineEnd).trim();
        if (line) {
          try {
            const entry: unknown = JSON.parse(line);
            if (typeof entry === "object" && entry !== null && !Array.isArray(entry)
              && Reflect.get(entry, "type") === "session_info") {
              const name = Reflect.get(entry, "name");
              return typeof name === "string" && name.trim() ? name.trim() : ANONYMOUS_SESSION_NAME;
            }
          } catch {
            // Ignore malformed session entries and continue backwards.
          }
        }
        if (previousNewline < completeStart) break;
        lineEnd = previousNewline;
      }
    }
  } catch {
    signal?.throwIfAborted();
  } finally {
    await file?.close();
  }

  return ANONYMOUS_SESSION_NAME;
}

/**
 * Collect metadata asynchronously, then read session names newest-first.
 * I/O is serial: at most one directory handle and one filesystem operation are
 * active at a time. Abort rejects after the current operation and closes handles.
 */
export async function getRecentSessions(maxCount: number = 3, signal?: AbortSignal): Promise<RecentSession[]> {
  signal?.throwIfAborted();
  if (maxCount <= 0) return [];
  const pendingDirs = [...new Set([getAgentPath("sessions"), getLegacyPiPath("sessions")])]
    .reverse().map(dir => ({ dir, ancestors: [] as string[] }));
  const sessions: { filePath: string; size: number; mtime: number }[] = [];

  while (pendingDirs.length > 0) {
    signal?.throwIfAborted();
    const { dir, ancestors } = pendingDirs.pop()!;
    try {
      const canonicalDir = await realpath(dir);
      signal?.throwIfAborted();
      if (ancestors.includes(canonicalDir)) continue;
      const childAncestors = [...ancestors, canonicalDir];
      const entries = await opendir(dir);
      // The async iterator closes the directory on completion, error, or abort.
      for await (const entry of entries) {
        signal?.throwIfAborted();
        const entryPath = join(dir, entry.name);
        try {
          const stats = await stat(entryPath);
          signal?.throwIfAborted();
          if (stats.isDirectory()) {
            pendingDirs.push({ dir: entryPath, ancestors: childAncestors });
          } else if (stats.isFile() && entry.name.endsWith(".jsonl")) {
            sessions.push({ filePath: entryPath, size: stats.size, mtime: stats.mtimeMs });
          }
        } catch (error) {
          signal?.throwIfAborted();
          logDiscoveryError(`Failed to inspect session entry ${entryPath}`, error);
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      logDiscoveryError(`Failed to scan sessions dir ${dir}`, error);
    }
  }

  signal?.throwIfAborted();
  sessions.sort((a, b) => b.mtime - a.mtime);

  const now = Date.now();
  const seenNames = new Set<string>();
  const recentSessions: RecentSession[] = [];
  for (const session of sessions) {
    signal?.throwIfAborted();
    const name = await readLatestSessionName(session.filePath, session.size, signal);
    signal?.throwIfAborted();
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    recentSessions.push({ name, timeAgo: formatTimeAgo(now - session.mtime) });
    if (recentSessions.length >= maxCount) break;
  }

  return recentSessions;
}

function formatTimeAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}
