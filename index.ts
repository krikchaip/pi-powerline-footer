import {
  copyToClipboard,
  type ExtensionAPI,
  InteractiveMode,
  type ReadonlyFooterDataProvider,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CURSOR_MARKER, isKeyRelease, type AutocompleteProvider, type SelectItem, SelectList, truncateToWidth, TUI_KEYBINDINGS, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

import type { ColorScheme, SegmentContext, StatusLinePreset, StatusLineSegmentId, StatusLineSeparatorStyle } from "./types.ts";
import type { PowerlineConfig } from "./powerline-config.ts";
import { PowerlineEditor } from "./editor.ts";
import { getPreset, PRESETS } from "./presets.ts";
import { getAgentPath } from "./paths.ts";
import { collectHiddenExtensionStatusKeys, getNotificationExtensionStatuses, mergeSegmentOptions, mergeSegmentsWithCustomItems, nextPowerlineSettingWithOptions, nextPowerlineSettingWithPreset, parsePowerlineConfig } from "./powerline-config.ts";
import { getSeparator } from "./separators.ts";
import { renderSegment } from "./segments.ts";
import { resolveThinkingLevelSelection } from "./thinking-level.ts";
import { getGitStatus, invalidateGitStatus, invalidateGitBranch, subscribeGitUpdates } from "./git-status.ts";
import { SessionBranchCache, SessionTokenStatsCache } from "./token-stats.ts";
import { ansi, getFgAnsiCode } from "./colors.ts";
import { WelcomeHeader, discoverLoadedCounts, getRecentSessions } from "./welcome.ts";
import { createRenderScheduler } from "./render-scheduler.ts";
import { refreshMaxThinkingWave } from "./thinking-wave.ts";
import { getEditorAutocompleteProvider, passAutocompleteProviderThroughPreviousEditor } from "./editor-composition.ts";
import { EditorPerfProfiler, readEditorPerfOptions } from "./editor-performance.ts";
import { clearEditorHistorySnapshot, restoreEditorHistory, snapshotEditorHistory, trackEditorHistory } from "./editor-history.ts";
import { CoreContextUsageCache, estimateInitialContextTokens, estimateUnknownContextUsage, resolveDisplayContextUsage, type CoreContextUsage } from "./context-usage.ts";
import { isStaleExtensionContextError, shouldShowStartupWelcome } from "./lifecycle.ts";
import { getDefaultColors } from "./theme.ts";
import { registerCdCommand } from "./cd-command.ts";
import {
  isSupportedSuperShortcut,
  matchesConfiguredShortcut,
  shortcutConflictKey,
  shortcutUsesSuper,
} from "./shortcuts.ts";
import {
  initVibeManager,
  onVibeBeforeAgentStart,
  onVibeAgentStart,
  onVibeAgentEnd,
  onVibeToolCall,
  getVibeTheme,
  setVibeTheme,
  getVibeModel,
  setVibeModel,
  getVibeMode,
  setVibeMode,
  hasVibeFile,
  getVibeFileCount,
  generateVibesBatch,
  parseVibeGenerateArgs,
  setVibeWorkingMessageTheme,
  setVibeWorkingMessageColor,
} from "./working-vibes.ts";
import { PowerlineQueueStore, currentQueueContext, formatQueueDeliveryText, parseCompactQueuedPrompt } from "./queue/store.ts";
import type { PowerlineQueueItem, QueueContext, QueueIntent, QueueSummary, QueueTarget } from "./queue/types.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

let config: PowerlineConfig = {
  preset: "default",
  customItems: [],
  disabledSegments: [],
  invalidDisabledSegments: [],
  layout: null,
  invalidLayoutSegments: [],
  separator: null,
  segmentOptions: {},
  placement: "above",
  invalidPlacement: null,
  welcome: true,
  showLastPrompt: true,
  sessionTitle: { enabled: false, alignment: "left" },
  queue: { compactPromptMode: "queue" },
  workingVibes: {},
};

const CUSTOM_COMPACTION_STATUS_KEY = "compact-policy";
let customCompactionEnabled = false;

type ShortcutBinding = string | null;

export interface PowerlineShortcuts {
  copyEditor: ShortcutBinding;
  cutEditor: ShortcutBinding;
  queueOpen: ShortcutBinding;
  reply: ShortcutBinding;
  editorStart: ShortcutBinding;
  editorEnd: ShortcutBinding;
}

type PowerlineShortcutKey = keyof PowerlineShortcuts;
type PowerlineShortcutAction =
  | { kind: "copyEditor" }
  | { kind: "cutEditor" }
  | { kind: "queueOpen" }
  | { kind: "reply" };
const DEFAULT_SHORTCUTS: PowerlineShortcuts = {
  copyEditor: "ctrl+alt+c",
  cutEditor: "ctrl+alt+x",
  queueOpen: "ctrl+alt+q",
  reply: null,
  editorStart: "super+shift+up",
  editorEnd: "super+shift+down",
};
const SHORTCUT_KEYS: PowerlineShortcutKey[] = ["copyEditor", "cutEditor", "queueOpen", "reply", "editorStart", "editorEnd"];
const APP_RESERVED_SHORTCUTS = [
  "escape",
  "ctrl+c",
  "ctrl+d",
  "ctrl+z",
  "shift+tab",
  "ctrl+p",
  "shift+ctrl+p",
  "ctrl+l",
  "ctrl+o",
  "shift+ctrl+o",
  "ctrl+t",
  "ctrl+n",
  "ctrl+g",
  "alt+enter",
  "alt+up",
  "alt+down",
  "ctrl+v",
  "alt+v",
  "shift+l",
  "shift+t",
  "ctrl+s",
  "ctrl+r",
  "ctrl+backspace",
  "ctrl+a",
  "ctrl+x",
  "ctrl+u",
] as const;
const SHORTCUT_MODIFIER_ORDER = ["ctrl", "alt", "super", "shift"] as const;
const SHORTCUT_MODIFIERS = new Set<string>(SHORTCUT_MODIFIER_ORDER);
const SHORTCUT_NAMED_KEYS = new Set([
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
]);
const SHORTCUT_SYMBOL_KEYS = new Set([
  "`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/",
  "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "|", "~", "{", "}", ":", "<", ">", "?",
]);
const LAYOUT_CACHE_TTL_MS = 250;
const STREAMING_LAYOUT_CACHE_TTL_MS = 1000;
const STATUS_RENDER_DEBOUNCE_MS = 33;
const CONTEXT_STATUS_RENDER_MS = 250;
const EDITOR_STATUS_DEFER_MS = 150;
const QUEUE_SUMMARY_CACHE_TTL_MS = 250;
const MAX_THINKING_WAVE_FRAME_MS = 90;
type SessionAssistantUsage = AssistantMessage["usage"];

function getUsageTokenTotal(usage: SessionAssistantUsage): number {
  const totalTokens = "totalTokens" in usage && typeof usage.totalTokens === "number" ? usage.totalTokens : 0;
  return totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function hasSessionAssistantUsage(value: unknown): value is SessionAssistantUsage {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.input !== "number" ||
    typeof value.output !== "number" ||
    typeof value.cacheRead !== "number" ||
    typeof value.cacheWrite !== "number"
  ) {
    return false;
  }

  return isRecord(value.cost) && typeof value.cost.total === "number";
}

function isSessionAssistantMessage(value: unknown): value is AssistantMessage {
  return isRecord(value)
    && value.role === "assistant"
    && hasSessionAssistantUsage(value.usage)
    && (value.stopReason === undefined || typeof value.stopReason === "string");
}

function getSettingsPath(): string {
  return getAgentPath("settings.json");
}

function getProjectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
}

function getGlobalCompactionPolicyPath(): string {
  return getAgentPath("compaction-policy.json");
}

function getCustomCompactionExtensionPath(): string {
  return getAgentPath("extensions", "pi-custom-compaction");
}

function mergeSettings(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = merged[key];
    merged[key] = isRecord(baseValue) && isRecord(overrideValue)
      ? mergeSettings(baseValue, overrideValue)
      : overrideValue;
  }

  return merged;
}

function readSettingsFile(settingsPath: string): Record<string, unknown> {
  try {
    if (!existsSync(settingsPath)) {
      return {};
    }

    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!isRecord(parsed)) {
      console.debug(`[powerline-footer] Ignoring non-object settings at ${settingsPath}`);
      return {};
    }

    return parsed;
  } catch (error) {
    // Settings are user-edited input. Log and keep the extension running with defaults
    // instead of crashing the UI during startup.
    console.debug(`[powerline-footer] Failed to read settings from ${settingsPath}:`, error);
    return {};
  }
}

function readWritableSettingsFile(settingsPath: string): Record<string, unknown> | null {
  if (!existsSync(settingsPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!isRecord(parsed)) {
      console.debug(`[powerline-footer] Refusing to write settings to non-object file at ${settingsPath}`);
      return null;
    }

    return parsed;
  } catch (error) {
    // Do not overwrite malformed user settings with partial data. Surface the failure
    // through the command handler so the user can fix the file intentionally.
    console.debug(`[powerline-footer] Failed to parse settings at ${settingsPath}:`, error);
    return null;
  }
}

function readCompactionPolicyEnabled(configPath: string): boolean | undefined {
  if (!existsSync(configPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!isRecord(parsed) || typeof parsed.enabled !== "boolean") return false;
    return parsed.enabled;
  } catch (error) {
    console.debug(`[powerline-footer] Failed to read compaction policy from ${configPath}:`, error);
    return false;
  }
}

function detectCustomCompactionEnabled(cwd: string): boolean {
  if (!existsSync(getCustomCompactionExtensionPath())) return false;

  const projectSetting = readCompactionPolicyEnabled(join(cwd, ".pi", "compaction-policy.json"));
  if (projectSetting !== undefined) return projectSetting;

  return readCompactionPolicyEnabled(getGlobalCompactionPolicyPath()) ?? false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveThinkingLevel({
  current,
  sessionEvents,
  getCurrent,
}: {
  current: string | null;
  sessionEvents: unknown;
  getCurrent?: (() => string) | null;
}): string {
  if (current !== null) return current;

  if (Array.isArray(sessionEvents)) {
    for (let i = sessionEvents.length - 1; i >= 0; i--) {
      const event = sessionEvents[i];
      if (isRecord(event) && event.type === "thinking_level_change" && typeof event.thinkingLevel === "string") {
        return event.thinkingLevel;
      }
    }
  }

  return getCurrent?.() ?? "off";
}

function readSettings(cwd: string = process.cwd()): Record<string, unknown> {
  return mergeSettings(readSettingsFile(getSettingsPath()), readSettingsFile(getProjectSettingsPath(cwd)));
}

function writePowerlineSetting(cwd: string, update: (existingPowerlineSetting: unknown) => unknown): boolean {
  const globalSettingsPath = getSettingsPath();
  const projectSettingsPath = getProjectSettingsPath(cwd);
  const globalSettings = readWritableSettingsFile(globalSettingsPath);
  const projectSettings = readWritableSettingsFile(projectSettingsPath);

  if (globalSettings === null || projectSettings === null) {
    return false;
  }

  const writeToProject = Object.prototype.hasOwnProperty.call(projectSettings, "powerline");
  const settingsPath = writeToProject ? projectSettingsPath : globalSettingsPath;
  const settings = writeToProject ? projectSettings : globalSettings;

  settings.powerline = update(settings.powerline);

  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    return true;
  } catch (error) {
    console.debug(`[powerline-footer] Failed to persist powerline setting to ${settingsPath}:`, error);
    return false;
  }
}

function writePowerlinePresetSetting(preset: StatusLinePreset, cwd: string = process.cwd()): boolean {
  return writePowerlineSetting(cwd, (existingPowerlineSetting) => (
    nextPowerlineSettingWithPreset(existingPowerlineSetting, preset)
  ));
}

function writePowerlineOptionSetting(
  cwd: string,
  updates: Partial<Pick<PowerlineConfig, "welcome" | "placement">>,
  currentPreset: StatusLinePreset,
): boolean {
  return writePowerlineSetting(cwd, (existingPowerlineSetting) => (
    nextPowerlineSettingWithOptions(existingPowerlineSetting, updates, currentPreset)
  ));
}

const PRESET_NAMES = Object.keys(PRESETS) as StatusLinePreset[];

function isValidPreset(value: unknown): value is StatusLinePreset {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PRESETS, value);
}

function normalizePreset(value: unknown): StatusLinePreset | null {
  if (typeof value !== "string") {
    return null;
  }

  const preset = value.trim().toLowerCase();
  return isValidPreset(preset) ? preset : null;
}

function hasNonWhitespaceText(text: string): boolean {
  return text.trim().length > 0;
}

function getCurrentEditorText(ctx: any, editor: any): string {
  const editorText = editor?.getExpandedText?.();
  if (typeof editorText === "string" && editorText.length > 0) return editorText;
  return ctx.ui.getEditorText?.() ?? editorText ?? "";
}

function buildCompactTextPreview(text: string, maxWidth: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "(empty)";
  return truncateToWidth(compact, maxWidth, "…");
}

function normalizeShortcut(value: string): string {
  const parts = value.trim().toLowerCase().split("+");
  if (parts.length <= 1) return parts[0] ?? "";

  const modifierRank = new Map<string, number>(SHORTCUT_MODIFIER_ORDER.map((modifier, index) => [modifier, index]));
  const modifiers = parts.slice(0, -1).sort((a, b) => (modifierRank.get(a) ?? 99) - (modifierRank.get(b) ?? 99));
  return [...modifiers, parts[parts.length - 1]].join("+");
}

function reservedShortcuts(): Set<string> {
  const shortcuts = new Set<string>(APP_RESERVED_SHORTCUTS.map(normalizeShortcut));

  for (const definition of Object.values(TUI_KEYBINDINGS)) {
    const defaultKeys = definition.defaultKeys;
    const keys = defaultKeys === undefined ? [] : Array.isArray(defaultKeys) ? defaultKeys : [defaultKeys];
    for (const key of keys) {
      shortcuts.add(normalizeShortcut(key));
    }
  }

  return shortcuts;
}

function isValidShortcutKeyPart(keyPart: string): boolean {
  const lowerKeyPart = keyPart.toLowerCase();

  if (/^[a-z0-9]$/i.test(keyPart)) return true;
  if (/^f([1-9]|1[0-2])$/i.test(keyPart)) return true;
  if (SHORTCUT_NAMED_KEYS.has(lowerKeyPart)) return true;

  return SHORTCUT_SYMBOL_KEYS.has(keyPart);
}

function parseShortcutOverride(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return null;
  }

  const parts = trimmed.split("+");
  if (parts.some((part) => part.length === 0)) {
    return null;
  }

  const modifierParts = parts.slice(0, -1).map((part) => {
    const modifier = part.toLowerCase();
    return modifier === "cmd" || modifier === "command" ? "super" : modifier;
  });
  if (new Set(modifierParts).size !== modifierParts.length) {
    return null;
  }

  for (const modifier of modifierParts) {
    if (!SHORTCUT_MODIFIERS.has(modifier)) {
      return null;
    }
  }

  const keyPart = parts[parts.length - 1];
  if (!isValidShortcutKeyPart(keyPart)) {
    return null;
  }

  const normalizedKey = SHORTCUT_SYMBOL_KEYS.has(keyPart) ? keyPart : keyPart.toLowerCase();
  const normalizedShortcut = normalizeShortcut([...modifierParts, normalizedKey].join("+"));
  if (shortcutUsesSuper(normalizedShortcut) && !isSupportedSuperShortcut(normalizedShortcut)) {
    return null;
  }

  return normalizedShortcut;
}

function shortcutUsageKey(shortcut: string): string {
  return shortcutConflictKey(normalizeShortcut(shortcut));
}

function parseShortcutSetting(value: unknown): ShortcutBinding | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return parseShortcutOverride(value) ?? undefined;
}

function findShortcutReplacement(key: PowerlineShortcutKey, used: Set<string>): string | null {
  const preferred = DEFAULT_SHORTCUTS[key];
  if (preferred && !used.has(shortcutUsageKey(preferred))) {
    return preferred;
  }
  return null;
}

function shortcutBelongsToOtherDefault(key: PowerlineShortcutKey, shortcut: string): boolean {
  const usageKey = shortcutUsageKey(shortcut);
  return SHORTCUT_KEYS.some((shortcutKey) => {
    const defaultShortcut = DEFAULT_SHORTCUTS[shortcutKey];
    return shortcutKey !== key && defaultShortcut !== null && shortcutUsageKey(defaultShortcut) === usageKey;
  });
}

export function resolveShortcutConfig(settings: Record<string, unknown>): PowerlineShortcuts {
  const resolved: PowerlineShortcuts = { ...DEFAULT_SHORTCUTS };
  const shortcutSettings = settings.powerlineShortcuts;

  if (isRecord(shortcutSettings)) {
    for (const key of SHORTCUT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(shortcutSettings, key)) {
        continue;
      }

      const override = parseShortcutSetting(shortcutSettings[key]);
      if (override !== undefined) {
        resolved[key] = override;
      }
    }
  }

  const used = new Set(Array.from(reservedShortcuts(), shortcutUsageKey));

  for (const key of SHORTCUT_KEYS) {
    const configured = resolved[key];
    if (configured === null) {
      continue;
    }

    const configuredUsageKey = shortcutUsageKey(configured);

    if (!used.has(configuredUsageKey) && !shortcutBelongsToOtherDefault(key, configured)) {
      used.add(configuredUsageKey);
      continue;
    }

    const replacement = findShortcutReplacement(key, used);
    if (!replacement) {
      console.debug(`[powerline-footer] Shortcut conflict for ${key}: "${configured}" is already in use`);
      resolved[key] = null;
      continue;
    }

    console.debug(
      `[powerline-footer] Shortcut conflict for ${key}: "${configured}" replaced with "${replacement}"`,
    );

    resolved[key] = replacement;
    used.add(shortcutUsageKey(replacement));
  }

  return resolved;
}

const FAST_EDITOR_RENDER_LINE_THRESHOLD = 80;
const FAST_EDITOR_RENDER_COLUMN_THRESHOLD = 1200;

interface FastEditorState {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

interface FastEditorVisualLine {
  text: string;
  cursorCol?: number;
}

function readFastEditorState(editor: unknown): FastEditorState | null {
  const state = Reflect.get(editor as object, "state");
  if (!isRecord(state) || !Array.isArray(state.lines)) return null;
  if (typeof state.cursorLine !== "number" || typeof state.cursorCol !== "number") return null;

  const lines = state.lines as string[];
  const cursorLine = Math.max(0, Math.min(lines.length - 1, Math.floor(state.cursorLine)));
  const cursorText = lines[cursorLine] ?? "";
  if (typeof cursorText !== "string") return null;
  const cursorCol = Math.max(0, Math.min(cursorText.length, Math.floor(state.cursorCol)));
  return { lines, cursorLine, cursorCol };
}

function fastChunkCount(line: string, width: number): number {
  return Math.max(1, Math.ceil(Math.max(1, line.length) / width));
}

function fastChunk(line: string, width: number, chunkIndex: number): { text: string; startCol: number } {
  const startCol = chunkIndex * width;
  return { text: line.slice(startCol, startCol + width), startCol };
}

function isFastRenderableText(text: string): boolean {
  return /^[\x20-\x7E]*$/.test(text);
}

function pushTrailingChunks(target: FastEditorVisualLine[], line: string, width: number, maxCount: number): void {
  const count = fastChunkCount(line, width);
  const start = Math.max(0, count - maxCount);
  for (let index = start; index < count; index++) {
    target.push({ text: fastChunk(line, width, index).text });
  }
}

function collectFastEditorVisualLines(state: FastEditorState, layoutWidth: number, maxVisibleLines: number): {
  lines: FastEditorVisualLine[];
  hasBefore: boolean;
  hasAfter: boolean;
} {
  const cursorText = state.lines[state.cursorLine] ?? "";
  const cursorChunkIndex = Math.floor(state.cursorCol / layoutWidth);
  const cursorChunkCount = Math.max(fastChunkCount(cursorText, layoutWidth), cursorChunkIndex + 1);
  const firstCursorChunk = Math.max(0, cursorChunkIndex - maxVisibleLines + 1);

  const visualLines: FastEditorVisualLine[] = [];
  for (let lineIndex = state.cursorLine - 1; lineIndex >= 0 && visualLines.length < maxVisibleLines - 1; lineIndex--) {
    const chunks: FastEditorVisualLine[] = [];
    pushTrailingChunks(chunks, state.lines[lineIndex] ?? "", layoutWidth, maxVisibleLines - 1 - visualLines.length);
    visualLines.unshift(...chunks);
  }

  for (let chunkIndex = firstCursorChunk; chunkIndex < cursorChunkIndex && visualLines.length < maxVisibleLines - 1; chunkIndex++) {
    visualLines.push({ text: fastChunk(cursorText, layoutWidth, chunkIndex).text });
  }

  const cursorChunk = fastChunk(cursorText, layoutWidth, cursorChunkIndex);
  visualLines.push({
    text: cursorChunk.text,
    cursorCol: state.cursorCol - cursorChunk.startCol,
  });

  for (let chunkIndex = cursorChunkIndex + 1; chunkIndex < cursorChunkCount && visualLines.length < maxVisibleLines; chunkIndex++) {
    visualLines.push({ text: fastChunk(cursorText, layoutWidth, chunkIndex).text });
  }

  for (let lineIndex = state.cursorLine + 1; lineIndex < state.lines.length && visualLines.length < maxVisibleLines; lineIndex++) {
    const line = state.lines[lineIndex] ?? "";
    const count = fastChunkCount(line, layoutWidth);
    for (let chunkIndex = 0; chunkIndex < count && visualLines.length < maxVisibleLines; chunkIndex++) {
      visualLines.push({ text: fastChunk(line, layoutWidth, chunkIndex).text });
    }
  }

  return {
    lines: visualLines.slice(-maxVisibleLines),
    hasBefore: state.cursorLine > 0 || firstCursorChunk > 0,
    hasAfter: state.cursorLine < state.lines.length - 1 || cursorChunkIndex < cursorChunkCount - 1,
  };
}

function renderFastCursorLine(line: string, cursorCol: number, focused: boolean): string {
  const before = line.slice(0, cursorCol);
  const target = line[cursorCol];
  const marker = focused ? CURSOR_MARKER : "";
  if (target) {
    return `${before}${marker}\x1b[7m${target}\x1b[0m${line.slice(cursorCol + target.length)}`;
  }
  return `${before}${marker}\x1b[7m \x1b[0m`;
}

function padToWidth(line: string, width: number): string {
  return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
}

export function renderFastPowerlineEditor(
  editor: unknown,
  width: number,
): string[] | null {
  if (width < 10) return null;
  if (Reflect.get(editor as object, "isInPaste") === true || Reflect.get(editor as object, "jumpMode") != null) return null;
  if (Reflect.get(editor as object, "autocompleteState") != null) return null;

  const isShowingAutocomplete = Reflect.get(editor as object, "isShowingAutocomplete");
  if (typeof isShowingAutocomplete === "function" && isShowingAutocomplete.call(editor)) return null;

  const state = readFastEditorState(editor);
  if (!state) return null;

  const cursorText = state.lines[state.cursorLine] ?? "";
  if (state.lines.length < FAST_EDITOR_RENDER_LINE_THRESHOLD && cursorText.length < FAST_EDITOR_RENDER_COLUMN_THRESHOLD) {
    return null;
  }

  const terminalRows = Reflect.get(Reflect.get(editor as object, "tui") ?? {}, "terminal")?.rows;
  const maxVisibleLines = Math.max(5, Math.floor((typeof terminalRows === "number" ? terminalRows : 24) * 0.3));
  const innerWidth = Math.max(1, width - 3);
  const layoutWidth = Math.max(1, innerWidth - 1);
  const viewport = collectFastEditorVisualLines(state, layoutWidth, maxVisibleLines);
  if (viewport.lines.some((line) => !isFastRenderableText(line.text))) return null;

  Reflect.set(editor as object, "lastWidth", layoutWidth);

  const borderColor = getFgAnsiCode("sep");
  const border = (marker: "↑" | "↓" | "─") => {
    const text = marker === "─" ? "─".repeat(width - 2) : `${marker}${"─".repeat(Math.max(0, width - 3))}`;
    return ` ${borderColor}${text}${ansi.reset}`;
  };
  const promptGlyph = ">";
  const prompt = `${ansi.getFgAnsi(200, 200, 200)}${promptGlyph}${ansi.reset}`;
  const promptPrefix = ` ${prompt} `;
  const contPrefix = "   ";

  const lines = [border(viewport.hasBefore ? "↑" : "─")];
  for (let index = 0; index < viewport.lines.length; index++) {
    const visual = viewport.lines[index]!;
    const content = visual.cursorCol === undefined
      ? visual.text
      : renderFastCursorLine(visual.text, visual.cursorCol, Reflect.get(editor as object, "focused") === true);
    lines.push(`${index === 0 ? promptPrefix : contPrefix}${padToWidth(content, innerWidth)}`);
  }
  lines.push(border(viewport.hasAfter ? "↓" : "─"));
  return lines;
}
// ═══════════════════════════════════════════════════════════════════════════
// Status Line Builder
// ═══════════════════════════════════════════════════════════════════════════

/** Render a single segment and return its content with width */
function renderSegmentWithWidth(
  segId: StatusLineSegmentId,
  ctx: SegmentContext
): { content: string; width: number; visible: boolean } {
  const rendered = renderSegment(segId, ctx);
  if (!rendered.visible || !rendered.content) {
    return { content: "", width: 0, visible: false };
  }
  return { content: rendered.content, width: visibleWidth(rendered.content), visible: true };
}

/** Build content string from pre-rendered parts */
function buildContentFromParts(
  parts: string[],
  separatorStyle: StatusLineSeparatorStyle,
): string {
  if (parts.length === 0) return "";
  const separatorDef = getSeparator(separatorStyle);
  const sepAnsi = getFgAnsiCode("sep");
  const sep = separatorDef.left;
  return parts.join(` ${sepAnsi}${sep}${ansi.reset} `) + ansi.reset;
}

export function buildAlignedPrimaryContent(
  leftParts: string[],
  rightParts: string[],
  separatorStyle: StatusLineSeparatorStyle,
  availableWidth: number,
): string {
  const leftContent = buildContentFromParts(leftParts, separatorStyle);
  const rightContent = buildContentFromParts(rightParts, separatorStyle);
  if (!rightContent) return leftContent;

  const gapWidth = availableWidth - visibleWidth(leftContent) - visibleWidth(rightContent);
  if (!leftContent) return gapWidth > 0 ? `${" ".repeat(gapWidth)}${rightContent}` : rightContent;
  return gapWidth > 0 ? `${leftContent}${" ".repeat(gapWidth)}${rightContent}` : `${leftContent}${rightContent}`;
}

export function buildSessionTitleLines(
  title: string,
  availableWidth: number,
  alignment: "left" | "right",
): string[] {
  if (!title || availableWidth <= 0) return [];

  const lines = wrapTextWithAnsi(title, availableWidth);
  if (alignment === "left") return lines;

  return lines.map((line) => `${" ".repeat(Math.max(0, availableWidth - visibleWidth(line)))}${line}`);
}

export function buildPowerlineFooterLines(
  placement: "above" | "below",
  primaryLines: string[],
  secondaryLines: string[],
): string[] {
  return placement === "below"
    ? [...primaryLines, ...secondaryLines]
    : secondaryLines;
}

type RenderedLayoutSegment = { content: string; width: number };
type ResponsiveLayout = {
  topContent: string;
  /** First secondary row, kept for callers that consume the original API. */
  secondaryContent: string;
  secondaryLines: string[];
};

/**
 * Build rows from layout groups. `secondary` is an explicit row boundary: it
 * never consumes unused space between primary `left` and `right` groups.
 */
export function buildResponsiveLayout(
  groups: {
    left: readonly RenderedLayoutSegment[];
    right: readonly RenderedLayoutSegment[];
    secondary: readonly RenderedLayoutSegment[];
  },
  presetDef: ReturnType<typeof getPreset>,
  availableWidth: number,
  separatorStyle: StatusLineSeparatorStyle = presetDef.separator,
): ResponsiveLayout {
  const separatorDef = getSeparator(separatorStyle);
  const sepWidth = visibleWidth(separatorDef.left) + 2;
  const primarySegments = [
    ...groups.left.map((segment) => ({ ...segment, placement: "left" as const })),
    ...groups.right.map((segment) => ({ ...segment, placement: "right" as const })),
  ];

  if (primarySegments.length === 0 && groups.secondary.length === 0) {
    return { topContent: "", secondaryContent: "", secondaryLines: [] };
  }

  let primaryWidth = 0;
  const topSegments: { content: string; placement: "left" | "right" }[] = [];
  const overflowSegments: RenderedLayoutSegment[] = [];
  let overflow = false;

  for (const segment of primarySegments) {
    const neededWidth = segment.width + (topSegments.length > 0 ? sepWidth : 0);
    if (!overflow && primaryWidth + neededWidth <= availableWidth) {
      topSegments.push({ content: segment.content, placement: segment.placement });
      primaryWidth += neededWidth;
    } else {
      overflow = true;
      overflowSegments.push(segment);
    }
  }

  // Keep layout-group order after the explicit row boundary. Start a new row
  // instead of dropping content. Wrap one indivisible oversized segment with
  // ANSI styles intact, without adding a right-edge ellipsis.
  const secondaryRows: string[][] = [];
  let currentRow: string[] = [];
  let currentRowWidth = 0;
  const flushSecondaryRow = () => {
    if (currentRow.length === 0) return;
    secondaryRows.push(currentRow);
    currentRow = [];
    currentRowWidth = 0;
  };

  for (const segment of [...overflowSegments, ...groups.secondary]) {
    if (segment.width > availableWidth) {
      flushSecondaryRow();
      for (const line of wrapTextWithAnsi(segment.content, Math.max(1, availableWidth))) {
        if (visibleWidth(line) > 0) secondaryRows.push([line]);
      }
      continue;
    }

    const neededWidth = segment.width + (currentRow.length > 0 ? sepWidth : 0);
    if (currentRow.length > 0 && currentRowWidth + neededWidth > availableWidth) {
      flushSecondaryRow();
    }
    currentRow.push(segment.content);
    currentRowWidth += segment.width + (currentRow.length > 1 ? sepWidth : 0);
  }
  flushSecondaryRow();

  const secondaryLines = secondaryRows.map((row) => buildContentFromParts(row, separatorStyle));
  return {
    topContent: buildAlignedPrimaryContent(
      topSegments.filter((segment) => segment.placement === "left").map((segment) => segment.content),
      topSegments.filter((segment) => segment.placement === "right").map((segment) => segment.content),
      separatorStyle,
      availableWidth,
    ),
    secondaryContent: secondaryLines[0] ?? "",
    secondaryLines,
  };
}

function computeResponsiveLayout(
  ctx: SegmentContext,
  presetDef: ReturnType<typeof getPreset>,
  mergedSegments: ReturnType<typeof mergeSegmentsWithCustomItems>,
  availableWidth: number,
): ResponsiveLayout {
  const renderGroup = (segmentIds: readonly StatusLineSegmentId[]): RenderedLayoutSegment[] => segmentIds.flatMap((segmentId) => {
    const rendered = renderSegmentWithWidth(segmentId, ctx);
    return rendered.visible ? [{ content: rendered.content, width: rendered.width }] : [];
  });

  return buildResponsiveLayout({
    left: renderGroup(mergedSegments.leftSegments),
    right: renderGroup(mergedSegments.rightSegments),
    secondary: renderGroup(mergedSegments.secondarySegments),
  }, presetDef, availableWidth, config.separator ?? presetDef.separator);
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════════

const WIDGET_SPACING_PATCH = Symbol.for("pi-powerline-footer.widget-spacing-patch");
const FOOTER_LAYOUT_PATCH = Symbol.for("pi-powerline-footer.footer-layout-patch");
const WELCOME_HEADER_PATCH = Symbol.for("pi-powerline-footer.welcome-header-patch");
const POWERLINE_FOOTER_FACTORY = Symbol.for("pi-powerline-footer.footer-factory");
const POWERLINE_WELCOME_HEADER_FACTORY = Symbol.for("pi-powerline-footer.welcome-header-factory");
const POWERLINE_WELCOME_FORCE_RESOURCES = Symbol.for("pi-powerline-footer.welcome-force-resources");
const POWERLINE_WELCOME_HEADER_REMOVED = Symbol.for("pi-powerline-footer.welcome-header-removed");
const POWERLINE_WELCOME_HEADER_COMPONENT = Symbol.for("pi-powerline-footer.welcome-header-component");
const SESSION_TITLE_WIDGET_KEY = "powerline-session-title";

type RenderWidgetContainer = (
  container: unknown,
  widgets: Map<string, unknown>,
  spacerWhenEmpty: boolean,
  leadingSpacer: boolean,
) => void;

type WidgetSpacingPatchState = {
  originalRenderWidgetContainer: RenderWidgetContainer;
};

type WidgetSpacingPrototype = {
  renderWidgetContainer?: RenderWidgetContainer;
} & Record<symbol, WidgetSpacingPatchState | undefined>;

type WidgetSpacingConfig = Pick<PowerlineConfig, "placement" | "sessionTitle">;
type WidgetSpacingConfigProvider = () => WidgetSpacingConfig;

function suppressLeadingWidgetSpacer(
  widgets: ReadonlyMap<string, unknown>,
  widgetConfig: WidgetSpacingConfig,
): boolean {
  return widgets.has(SESSION_TITLE_WIDGET_KEY)
    && !(widgetConfig.placement === "below" && widgetConfig.sessionTitle.alignment === "left");
}

/** Suppress Pi's generic leading spacer, except for a left-aligned title below the editor. */
export function installPowerlineWidgetSpacingPatch(
  prototype: object = InteractiveMode.prototype,
  getWidgetConfig: WidgetSpacingConfigProvider = () => config,
): void {
  const patchable = prototype as WidgetSpacingPrototype;
  if (patchable[WIDGET_SPACING_PATCH]) return;

  const originalRenderWidgetContainer = patchable.renderWidgetContainer;
  if (typeof originalRenderWidgetContainer !== "function") return;

  const state: WidgetSpacingPatchState = { originalRenderWidgetContainer };
  patchable[WIDGET_SPACING_PATCH] = state;
  patchable.renderWidgetContainer = function patchedRenderWidgetContainer(
    this: unknown,
    container: unknown,
    widgets: Map<string, unknown>,
    spacerWhenEmpty: boolean,
    leadingSpacer: boolean,
  ): void {
    state.originalRenderWidgetContainer.call(
      this,
      container,
      widgets,
      spacerWhenEmpty,
      leadingSpacer && !suppressLeadingWidgetSpacer(widgets, getWidgetConfig()),
    );
  };
}

type SetExtensionFooter = (factory: unknown) => void;

type FooterLayoutPatchState = {
  originalSetExtensionFooter: SetExtensionFooter;
};

type FooterLayoutPrototype = {
  setExtensionFooter?: SetExtensionFooter;
} & Record<symbol, FooterLayoutPatchState | undefined>;

type FooterLayoutEntry = {
  component: unknown;
  minSize?: number;
};

type FooterLayoutStack = {
  entries?: FooterLayoutEntry[];
};

type FooterLayoutMode = {
  footerContainer?: unknown;
  fullscreenLayoutRoot?: FooterLayoutStack;
};

type FooterLayoutConfig = Pick<PowerlineConfig, "placement">;
type FooterLayoutConfigProvider = () => FooterLayoutConfig;

function updatePowerlineFooterMinimumSize(mode: unknown, minimumSize: number): void {
  const interactiveMode = mode as FooterLayoutMode;
  const footerContainer = interactiveMode.footerContainer;
  const rootEntries = interactiveMode.fullscreenLayoutRoot?.entries;
  if (footerContainer === undefined || rootEntries === undefined) return;

  for (const rootEntry of rootEntries) {
    const dock = rootEntry.component as FooterLayoutStack | undefined;
    const footerEntry = dock?.entries?.find((entry) => entry.component === footerContainer);
    if (footerEntry !== undefined) {
      footerEntry.minSize = minimumSize;
      return;
    }
  }
}

function isPowerlineFooterFactory(factory: unknown): boolean {
  return typeof factory === "function"
    && (factory as unknown as Record<symbol, unknown>)[POWERLINE_FOOTER_FACTORY] === true;
}

function markPowerlineFooterFactory<T extends Function>(factory: T): T {
  Object.defineProperty(factory, POWERLINE_FOOTER_FACTORY, { value: true });
  return factory;
}

/** Remove Pi's reserved footer row only while Powerline renders its footer above the editor. */
export function installPowerlineFooterLayoutPatch(
  prototype: object = InteractiveMode.prototype,
  getFooterConfig: FooterLayoutConfigProvider = () => config,
): void {
  const patchable = prototype as FooterLayoutPrototype;
  if (patchable[FOOTER_LAYOUT_PATCH]) return;

  const originalSetExtensionFooter = patchable.setExtensionFooter;
  if (typeof originalSetExtensionFooter !== "function") return;

  const state: FooterLayoutPatchState = { originalSetExtensionFooter };
  patchable[FOOTER_LAYOUT_PATCH] = state;
  patchable.setExtensionFooter = function patchedSetExtensionFooter(
    this: unknown,
    factory: unknown,
  ): void {
    state.originalSetExtensionFooter.call(this, factory);
    const removeReservedRow = isPowerlineFooterFactory(factory)
      && getFooterConfig().placement === "above";
    updatePowerlineFooterMinimumSize(this, removeReservedRow ? 0 : 1);
  };
}

type SetExtensionHeader = (factory: unknown) => void;
type ShowLoadedResources = (options?: unknown) => void;

type WelcomeHeaderPatchState = {
  originalSetExtensionHeader: SetExtensionHeader;
  originalShowLoadedResources: ShowLoadedResources;
};

type WelcomeHeaderPrototype = {
  setExtensionHeader?: SetExtensionHeader;
  showLoadedResources?: ShowLoadedResources;
} & Record<symbol, WelcomeHeaderPatchState | undefined>;

type WelcomeHeaderComponent = {
  dispose?: () => void;
  setRequestRender?: (requestRender: () => void) => void;
};

type WelcomeHeaderRegistration = {
  factory: () => WelcomeHeaderComponent;
  forceResources: boolean;
  component?: WelcomeHeaderComponent;
  startedComponents: WeakSet<WelcomeHeaderComponent>;
  onRemoved?: () => void;
};

type PowerlineWelcomeHeaderFactory = (() => WelcomeHeaderComponent) & Record<symbol, unknown>;

type WelcomeHeaderMode = {
  loadedResourcesContainer?: {
    children: unknown[];
    addChild?: (component: unknown) => void;
  };
  ui?: { requestRender?: () => void };
} & Record<symbol, WelcomeHeaderRegistration | undefined>;

function isPowerlineWelcomeHeaderFactory(factory: unknown): factory is PowerlineWelcomeHeaderFactory {
  return typeof factory === "function"
    && (factory as unknown as Record<symbol, unknown>)[POWERLINE_WELCOME_HEADER_FACTORY] === true;
}

function markPowerlineWelcomeHeaderFactory<T extends Function>(
  factory: T,
  onRemoved: () => void,
  forceResources: boolean,
): T {
  Object.defineProperty(factory, POWERLINE_WELCOME_HEADER_FACTORY, { value: true });
  Object.defineProperty(factory, POWERLINE_WELCOME_FORCE_RESOURCES, { value: forceResources });
  Object.defineProperty(factory, POWERLINE_WELCOME_HEADER_REMOVED, { value: onRemoved });
  return factory;
}

function detachPowerlineWelcomeComponent(
  mode: WelcomeHeaderMode,
  dispose = true,
): WelcomeHeaderComponent | undefined {
  const registration = mode[POWERLINE_WELCOME_HEADER_COMPONENT];
  if (registration === undefined || registration.component === undefined) return undefined;
  const component = registration.component;

  const children = mode.loadedResourcesContainer?.children;
  const index = children?.indexOf(component) ?? -1;
  if (index >= 0) children?.splice(index, 1);
  if (dispose) component.dispose?.();
  registration.component = undefined;
  return component;
}

function removePowerlineWelcomeHeader(mode: unknown): void {
  const interactiveMode = mode as WelcomeHeaderMode;
  const registration = interactiveMode[POWERLINE_WELCOME_HEADER_COMPONENT];
  if (registration === undefined) return;

  detachPowerlineWelcomeComponent(interactiveMode);
  interactiveMode[POWERLINE_WELCOME_HEADER_COMPONENT] = undefined;
  registration.onRemoved?.();
}

function appendPowerlineWelcomeHeader(
  mode: unknown,
  component?: WelcomeHeaderComponent,
): void {
  const interactiveMode = mode as WelcomeHeaderMode;
  const registration = interactiveMode[POWERLINE_WELCOME_HEADER_COMPONENT];
  const container = interactiveMode.loadedResourcesContainer;
  if (registration === undefined || container === undefined) return;

  detachPowerlineWelcomeComponent(interactiveMode);
  const nextComponent = component ?? registration.factory();
  if (container.addChild) container.addChild(nextComponent);
  else container.children.push(nextComponent);
  registration.component = nextComponent;
  if (!registration.startedComponents.has(nextComponent)) {
    registration.startedComponents.add(nextComponent);
    nextComponent.setRequestRender?.(() => {
      interactiveMode.ui?.requestRender?.();
    });
  }
}

/** Render Powerline's welcome banner after Pi's native loaded-resource sections. */
export function installPowerlineWelcomeHeaderPatch(
  prototype: object = InteractiveMode.prototype,
): void {
  const patchable = prototype as WelcomeHeaderPrototype;
  const previousState = patchable[WELCOME_HEADER_PATCH];
  if (previousState) {
    patchable.setExtensionHeader = previousState.originalSetExtensionHeader;
    patchable.showLoadedResources = previousState.originalShowLoadedResources;
    patchable[WELCOME_HEADER_PATCH] = undefined;
  }

  const originalSetExtensionHeader = patchable.setExtensionHeader;
  const originalShowLoadedResources = patchable.showLoadedResources;
  if (typeof originalSetExtensionHeader !== "function" || typeof originalShowLoadedResources !== "function") return;

  const state: WelcomeHeaderPatchState = { originalSetExtensionHeader, originalShowLoadedResources };
  patchable[WELCOME_HEADER_PATCH] = state;
  patchable.setExtensionHeader = function patchedSetExtensionHeader(
    this: unknown,
    factory: unknown,
  ): void {
    removePowerlineWelcomeHeader(this);

    if (!isPowerlineWelcomeHeaderFactory(factory)) {
      state.originalSetExtensionHeader.call(this, factory);
      return;
    }

    const interactiveMode = this as WelcomeHeaderMode;
    if (interactiveMode.loadedResourcesContainer === undefined) {
      state.originalSetExtensionHeader.call(this, factory);
      return;
    }

    const onRemoved = factory[POWERLINE_WELCOME_HEADER_REMOVED];
    interactiveMode[POWERLINE_WELCOME_HEADER_COMPONENT] = {
      factory,
      forceResources: factory[POWERLINE_WELCOME_FORCE_RESOURCES] === true,
      startedComponents: new WeakSet(),
      onRemoved: typeof onRemoved === "function" ? onRemoved as () => void : undefined,
    };
    appendPowerlineWelcomeHeader(interactiveMode);
    interactiveMode.ui?.requestRender?.();
  };
  patchable.showLoadedResources = function patchedShowLoadedResources(
    this: unknown,
    options?: unknown,
  ): void {
    const interactiveMode = this as WelcomeHeaderMode;
    const registration = interactiveMode[POWERLINE_WELCOME_HEADER_COMPONENT];
    const originalOptions = options !== null && typeof options === "object" ? options : {};

    // Pi rebuilds only native resource children. Preserve the banner instance so
    // its one-shot logo animation remains active during that rebuild.
    const banner = detachPowerlineWelcomeComponent(interactiveMode, false);
    state.originalShowLoadedResources.call(
      this,
      registration?.forceResources ? { ...originalOptions, force: true } : options,
    );
    appendPowerlineWelcomeHeader(interactiveMode, banner);
  };
}

async function installRunningPowerlineWelcomeHeaderPatch(): Promise<void> {
  const cliEntry = process.argv[1];
  if (!cliEntry) return;

  try {
    const packageRoot = dirname(dirname(realpathSync(cliEntry)));
    const packageJsonPath = join(packageRoot, "package.json");
    if (!existsSync(packageJsonPath)) return;

    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
    if (packageJson.name !== "@earendil-works/pi-coding-agent") return;

    const modulePath = join(packageRoot, "dist", "modes", "interactive", "interactive-mode.js");
    if (!existsSync(modulePath)) return;

    const runningModule = await import(pathToFileURL(modulePath).href) as {
      InteractiveMode?: { prototype?: object };
    };
    const runningPrototype = runningModule.InteractiveMode?.prototype;
    if (runningPrototype) installPowerlineWelcomeHeaderPatch(runningPrototype);
  } catch (error) {
    console.debug("[powerline-footer] Unable to patch the running Pi header:", error);
  }
}

function warnInvalidSegmentSettings(ctx: any): void {
  if (config.invalidDisabledSegments.length > 0) {
    const invalid = config.invalidDisabledSegments.map((id) => JSON.stringify(id)).join(", ");
    const message = `Ignoring unknown powerline disabled segment${config.invalidDisabledSegments.length === 1 ? "" : "s"}: ${invalid}`;
    console.warn(`[powerline-footer] ${message}`);
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
  }

  if (config.invalidLayoutSegments.length > 0) {
    const invalid = config.invalidLayoutSegments.map((id) => JSON.stringify(id)).join(", ");
    const message = `Ignoring unknown powerline layout segment${config.invalidLayoutSegments.length === 1 ? "" : "s"}: ${invalid}`;
    console.warn(`[powerline-footer] ${message}`);
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
  }

  if (config.invalidPlacement !== null) {
    const message = `Ignoring invalid powerline placement: ${JSON.stringify(config.invalidPlacement)}`;
    console.warn(`[powerline-footer] ${message}`);
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
  }
}

export default function powerlineFooter(pi: ExtensionAPI) {
  const editorPerf = new EditorPerfProfiler(readEditorPerfOptions());
  const startupSettings = readSettings();
  config = parsePowerlineConfig(startupSettings.powerline, PRESET_NAMES);
  installPowerlineWidgetSpacingPatch();
  installPowerlineFooterLayoutPatch();
  installPowerlineWelcomeHeaderPatch();
  const runningWelcomeHeaderPatchReady = installRunningPowerlineWelcomeHeaderPatch();
  let resolvedShortcuts = resolveShortcutConfig(startupSettings);

  let enabled = true;
  let sessionStartTime = Date.now();
  let sessionGeneration = 0;
  let currentCtx: any = null;
  let footerDataRef: ReadonlyFooterDataProvider | null = null;
  let footerDataCwd: string | null = null;
  let getThinkingLevelFn: (() => string) | null = null;
  let currentThinkingLevel: string | null = null;
  let liveAssistantUsage: SessionAssistantUsage | null = null;
  let approximateContextUsage: CoreContextUsage | null = null;
  let isStreaming = false;
  let tuiRef: any = null;
  let restoreFooterStatusRepaintHook: (() => void) | null = null;
  let shortcutInputUnsubscribe: (() => void) | null = null;
  let welcomePlacement: "loadedResources" | null = null;
  let welcomeRequest: AbortController | null = null;
  let welcomeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastUserPrompt = "";
  let showLastPrompt = true;
  let lastPromptRenderCache: {
    source: string;
    compact: string;
    width: number;
    color: string;
    lines: string[];
  } | null = null;
  let currentEditor: any = null;
  const queueStore = new PowerlineQueueStore();
  let queueSummaryCache: {
    cwd: string;
    sessionId?: string;
    compacting: boolean;
    expiresAt: number;
    summary: QueueSummary;
  } | null = null;
  let powerlineCompacting = false;
  let compactionGeneration = 0;
  let postCompactionDelivery: { generation: number; context: QueueContext } | null = null;
  let queueDeliveryTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingQueueDeliveries = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>();
  let maxThinkingWaveTimer: ReturnType<typeof setInterval> | null = null;

  // Cache for the top and secondary powerline widgets.
  let lastLayoutWidth = 0;
  let lastLayoutResult: ResponsiveLayout | null = null;
  let lastLayoutThinkingWaveFrame: number | null = null;
  let lastLayoutTimestamp = 0;
  let layoutDirty = true;
  let forceNextLayoutRecompute = false;
  let lastEditorInputAt = 0;

  // Cache for token counting: avoid re-scanning the full session event list
  // on every render (250ms-1s cadence). Revalidates the trailing event's
  // stats signature so in-place streaming updates are not served stale.
  const sessionBranchCache = new SessionBranchCache();
  const tokenStatsCache = new SessionTokenStatsCache();
  const coreContextUsageCache = new CoreContextUsageCache();

  const statusRenderScheduler = createRenderScheduler(() => {
    const msSinceInput = Date.now() - lastEditorInputAt;
    if (layoutDirty && !forceNextLayoutRecompute && msSinceInput < EDITOR_STATUS_DEFER_MS) {
      statusRenderScheduler.schedule(Math.max(0, EDITOR_STATUS_DEFER_MS - msSinceInput));
      return;
    }

    tuiRef?.requestRender();
  }, STATUS_RENDER_DEBOUNCE_MS);

  const invalidateLayoutCache = () => {
    lastLayoutResult = null;
    layoutDirty = true;
  };

  const resetLayoutCache = () => {
    invalidateLayoutCache();
    sessionBranchCache.reset();
    tokenStatsCache.reset();
    coreContextUsageCache.reset();
  };

  const requestStatusRender = (delayMs?: number) => {
    layoutDirty = true;
    statusRenderScheduler.schedule(delayMs);
  };

  const requestImmediateStatusRender = (options: { deferDuringTyping?: boolean } = {}) => {
    layoutDirty = true;
    if (options.deferDuringTyping !== false && Date.now() - lastEditorInputAt < EDITOR_STATUS_DEFER_MS) {
      statusRenderScheduler.schedule();
      return;
    }

    forceNextLayoutRecompute = true;
    statusRenderScheduler.cancel();
    statusRenderScheduler.schedule(0);
  };

  const stopMaxThinkingWave = () => {
    if (!maxThinkingWaveTimer) return;
    clearInterval(maxThinkingWaveTimer);
    maxThinkingWaveTimer = null;
  };

  const syncMaxThinkingWave = () => {
    const thinkingLevel = resolveThinkingLevel({
      current: currentThinkingLevel,
      sessionEvents: currentCtx?.sessionManager?.getBranch?.(),
      getCurrent: getThinkingLevelFn,
    });
    if (!enabled || thinkingLevel !== "max") {
      stopMaxThinkingWave();
      return;
    }
    if (maxThinkingWaveTimer) return;

    maxThinkingWaveTimer = setInterval(() => {
      // The cached layout contains the prior wave frame. A render replaces
      // only its ANSI colors, without rebuilding layout or token statistics.
      statusRenderScheduler.schedule(0);
    }, MAX_THINKING_WAVE_FRAME_MS);
  };

  const installFooterStatusRepaintHook = (footerData: ReadonlyFooterDataProvider) => {
    restoreFooterStatusRepaintHook?.();
    restoreFooterStatusRepaintHook = null;

    const writableFooterData = footerData as ReadonlyFooterDataProvider & {
      setExtensionStatus?: (key: string, text: string | undefined) => void;
      clearExtensionStatuses?: () => void;
    };
    if (typeof writableFooterData.setExtensionStatus !== "function") return;

    const originalSetExtensionStatus = writableFooterData.setExtensionStatus;
    const originalClearExtensionStatuses = writableFooterData.clearExtensionStatuses;
    const setExtensionStatusAndRepaint = function setExtensionStatusAndRepaint(this: unknown, key: string, text: string | undefined) {
      originalSetExtensionStatus.call(this, key, text);
      requestImmediateStatusRender();
    };
    writableFooterData.setExtensionStatus = setExtensionStatusAndRepaint;

    let clearExtensionStatusesAndRepaint: (() => void) | null = null;
    if (typeof originalClearExtensionStatuses === "function") {
      clearExtensionStatusesAndRepaint = function clearExtensionStatusesAndRepaint(this: unknown) {
        originalClearExtensionStatuses.call(this);
        requestImmediateStatusRender();
      };
      writableFooterData.clearExtensionStatuses = clearExtensionStatusesAndRepaint;
    }

    restoreFooterStatusRepaintHook = () => {
      if (writableFooterData.setExtensionStatus === setExtensionStatusAndRepaint) {
        writableFooterData.setExtensionStatus = originalSetExtensionStatus;
      }
      if (clearExtensionStatusesAndRepaint && writableFooterData.clearExtensionStatuses === clearExtensionStatusesAndRepaint) {
        writableFooterData.clearExtensionStatuses = originalClearExtensionStatuses;
      }
    };
  };

  function overlaySelectListTheme(theme: Theme) {
    return {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    };
  }

  async function showSelectOverlay(
    ctx: any,
    title: string,
    hint: string,
    items: SelectItem[],
    maxVisible: number,
  ): Promise<SelectItem | null> {
    return ctx.ui.custom(
      (tui: any, theme: Theme, _keybindings: any, done: (result: SelectItem | null) => void) => {
        const selectList = new SelectList(items, maxVisible, overlaySelectListTheme(theme));
        const border = (text: string) => theme.fg("dim", text);
        const wrapRow = (text: string, innerWidth: number): string => {
          return `${border("│")}${truncateToWidth(text, innerWidth, "…", true)}${border("│")}`;
        };

        selectList.onSelect = (item) => done(item);
        selectList.onCancel = () => done(null);

        return {
          render: (width: number) => {
            const innerWidth = Math.max(1, width - 2);
            const lines: string[] = [];

            lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
            lines.push(wrapRow(theme.fg("accent", theme.bold(title)), innerWidth));
            lines.push(border(`├${"─".repeat(innerWidth)}┤`));

            for (const line of selectList.render(innerWidth)) {
              lines.push(wrapRow(line, innerWidth));
            }

            lines.push(border(`├${"─".repeat(innerWidth)}┤`));
            lines.push(wrapRow(theme.fg("dim", hint), innerWidth));
            lines.push(border(`╰${"─".repeat(innerWidth)}╯`));

            return lines;
          },
          invalidate: () => selectList.invalidate(),
          handleInput: (data: string) => {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      },
      {
        overlay: true,
        overlayOptions: () => ({
          verticalAlign: "center",
          horizontalAlign: "center",
        }),
      },
    );
  }

  function getQueueSessionId(ctx: any): string | undefined {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    return typeof sessionId === "string" && sessionId.trim() ? sessionId : undefined;
  }

  function getQueueContext(ctx: any): QueueContext {
    return currentQueueContext(ctx.cwd ?? process.cwd(), getQueueSessionId(ctx));
  }

  function getQueueSummary(ctx: any): QueueSummary {
    const context = getQueueContext(ctx);
    const now = Date.now();
    if (
      queueSummaryCache
      && queueSummaryCache.cwd === context.cwd
      && queueSummaryCache.sessionId === context.sessionId
      && queueSummaryCache.compacting === powerlineCompacting
      && now < queueSummaryCache.expiresAt
    ) {
      return queueSummaryCache.summary;
    }

    const summary = queueStore.summarize(context, powerlineCompacting);
    queueSummaryCache = {
      cwd: context.cwd,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      compacting: powerlineCompacting,
      expiresAt: now + QUEUE_SUMMARY_CACHE_TTL_MS,
      summary,
    };
    return summary;
  }

  function requestQueueRender(): void {
    queueSummaryCache = null;
    requestImmediateStatusRender({ deferDuringTyping: false });
  }

  function queueItemLabel(item: PowerlineQueueItem): string {
    const status = item.status === "queued" ? item.intent : `${item.intent}/${item.status}`;
    return `${item.id} ${status} ${buildCompactTextPreview(item.text, 56)}`;
  }

  function queueItemDescription(item: PowerlineQueueItem): string {
    if (item.target.kind === "global") return "global";
    if (item.target.kind === "current-session") return "current session";
    return item.target.alias ? `@${item.target.alias}` : item.target.cwd;
  }

  function captureQueueItem(ctx: any, text: string, intent: QueueIntent, target: QueueTarget): PowerlineQueueItem {
    const item = queueStore.add({
      text,
      intent,
      target,
      source: getQueueContext(ctx),
    });
    requestQueueRender();
    return item;
  }

  function capturePostCompactPrompt(ctx: any, text: string): PowerlineQueueItem | null {
    const trimmed = text.trim();
    if (!trimmed) return null;

    const item = captureQueueItem(ctx, trimmed, "post-compact", { kind: "current-session" });
    ctx.ui.notify(`Queued for after compaction (${item.id})`, "info");
    return item;
  }

  function deliveryModeForItem(ctx: any, item: PowerlineQueueItem): "steer" | "followUp" | undefined {
    const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
    if (idle) return undefined;
    return item.intent === "steer" ? "steer" : "followUp";
  }

  function clearPendingQueueDelivery(id: string): void {
    const pending = pendingQueueDeliveries.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingQueueDeliveries.delete(id);
  }

  function trackPendingQueueDelivery(item: PowerlineQueueItem, text: string): void {
    clearPendingQueueDelivery(item.id);
    const timer = setTimeout(() => {
      pendingQueueDeliveries.delete(item.id);
      const current = queueStore.get(item.id);
      if (current?.status === "delivering") {
        queueStore.update(item.id, { status: "queued", error: "Queued message did not start" });
        requestQueueRender();
      }
    }, 60_000);
    pendingQueueDeliveries.set(item.id, { text, timer });
  }

  function requeuePendingQueueDeliveries(error: string): void {
    for (const id of [...pendingQueueDeliveries.keys()]) {
      clearPendingQueueDelivery(id);
      const current = queueStore.get(id);
      if (current?.status === "delivering") {
        queueStore.update(id, { status: "queued", error });
      }
    }
  }

  function finishPendingQueueDelivery(text: string, ctx: any): void {
    const normalized = text.replace(/\s+/g, " ").trim();
    for (const [id, pending] of pendingQueueDeliveries) {
      if (pending.text.replace(/\s+/g, " ").trim() !== normalized) continue;
      clearPendingQueueDelivery(id);
      const updated = queueStore.update(id, { status: "sent", error: undefined });
      if (!updated) return;
      try {
        ctx.ui.notify(`Sent queued item ${id}`, "info");
      } catch (error) {
        if (!isStaleExtensionContextError(error)) throw error;
        currentCtx = null;
      }
      requestQueueRender();
      return;
    }
  }

  function deliverQueueItem(ctx: any, item: PowerlineQueueItem): boolean {
    if (powerlineCompacting) {
      queueStore.update(item.id, { status: "queued" });
      requestQueueRender();
      return false;
    }

    queueStore.update(item.id, { status: "delivering", error: undefined });
    requestQueueRender();

    try {
      const deliverAs = deliveryModeForItem(ctx, item);
      const deliveryText = formatQueueDeliveryText(item);
      trackPendingQueueDelivery(item, deliveryText);
      if (deliverAs) {
        pi.sendUserMessage(deliveryText, { deliverAs });
      } else {
        pi.sendUserMessage(deliveryText);
      }
      return true;
    } catch (error) {
      clearPendingQueueDelivery(item.id);
      if (isStaleExtensionContextError(error)) {
        queueStore.update(item.id, { status: "queued", error: undefined });
        currentCtx = null;
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      queueStore.update(item.id, { status: "failed", error: message });
      ctx.ui.notify(`Failed to send ${item.id}: ${message}`, "error");
      requestQueueRender();
      return false;
    }
  }

  function cancelPostCompactionDelivery(): void {
    if (queueDeliveryTimer) clearTimeout(queueDeliveryTimer);
    queueDeliveryTimer = null;
    postCompactionDelivery = null;
  }

  function schedulePostCompactionDelivery(): void {
    if (!postCompactionDelivery) return;
    if (queueDeliveryTimer) clearTimeout(queueDeliveryTimer);
    const pending = postCompactionDelivery;
    queueDeliveryTimer = setTimeout(() => {
      queueDeliveryTimer = null;
      if (pending !== postCompactionDelivery) return;
      if (pending.generation !== sessionGeneration || !currentCtx) {
        cancelPostCompactionDelivery();
        return;
      }
      try {
        // Busy readiness checks must not read the inbox, render, or enqueue a late follow-up.
        if (!currentCtx.isIdle()) {
          schedulePostCompactionDelivery();
          return;
        }
        const items = queueStore.queuedDeliveryItems(pending.context, "post-compact");
        const item = items[0];
        if (items.length <= 1) cancelPostCompactionDelivery();
        if (!item) return;
        deliverQueueItem(currentCtx, item);
        schedulePostCompactionDelivery();
      } catch (error) {
        if (!isStaleExtensionContextError(error)) throw error;
        cancelPostCompactionDelivery();
        currentCtx = null;
      }
    }, 50);
  }

  function blockPostCompactionQueue(ctx: any, errorMessage: string): void {
    const items = queueStore.queuedDeliveryItems(getQueueContext(ctx), "post-compact");
    for (const item of items) {
      queueStore.update(item.id, { status: "blocked", error: errorMessage });
    }
    if (items.length > 0) {
      ctx.ui.notify(`Kept ${items.length} post-compaction item${items.length === 1 ? "" : "s"} blocked`, "warning");
      requestQueueRender();
    }
  }

  function finishFailedCompaction(ctx: any, errorMessage: string): void {
    compactionGeneration++;
    powerlineCompacting = false;
    cancelPostCompactionDelivery();
    blockPostCompactionQueue(ctx, errorMessage);
    requestQueueRender();
  }

  async function chooseQueueAction(ctx: any, item: PowerlineQueueItem): Promise<void> {
    const actions: SelectItem[] = [
      { value: "send", label: "Send to current session", description: "Deliver as prompt/follow-up" },
      { value: "edit", label: "Edit in prompt", description: "Move text into the editor" },
      { value: "retry", label: "Retry", description: "Mark queued and deliver" },
      { value: "clear", label: "Clear", description: "Mark item done" },
      { value: "cancel", label: "Cancel" },
    ];
    const selected = await showSelectOverlay(ctx, `Queue item ${item.id}`, buildCompactTextPreview(item.text, 72), actions, actions.length);
    if (!selected || selected.value === "cancel") return;

    if (selected.value === "send") {
      deliverQueueItem(ctx, item);
      return;
    }

    if (selected.value === "retry") {
      const updated = queueStore.update(item.id, { status: "queued", error: undefined });
      if (updated) deliverQueueItem(ctx, updated);
      return;
    }

    if (selected.value === "edit") {
      ctx.ui.setEditorText(item.text);
      queueStore.clear(item.id);
      requestQueueRender();
      return;
    }

    if (selected.value === "clear") {
      queueStore.clear(item.id);
      ctx.ui.notify(`Cleared ${item.id}`, "info");
      requestQueueRender();
    }
  }

  async function openQueuePicker(ctx: any): Promise<void> {
    const active = queueStore.activeItems(getQueueContext(ctx));
    if (active.length === 0) {
      ctx.ui.notify("No queued items", "info");
      return;
    }

    const items: SelectItem[] = active.map((item) => ({
      value: item.id,
      label: queueItemLabel(item),
      description: queueItemDescription(item),
    }));
    const selected = await showSelectOverlay(
      ctx,
      "Powerline queue",
      "↑↓ navigate • enter manage • esc cancel",
      items,
      Math.min(active.length, 12),
    );
    if (!selected) return;

    const item = active.find((candidate) => candidate.id === selected.value);
    if (item) await chooseQueueAction(ctx, item);
  }

  function resolveCommandTarget(ctx: any, spec: string): QueueTarget {
    const normalized = spec.trim().replace(/^@/, "");
    if (normalized === "current") return { kind: "current-session" };
    if (normalized === "global") return { kind: "global" };

    const cwd = queueStore.resolveAlias(normalized);
    if (!cwd) throw new Error(`Unknown project alias @${normalized}. Use /queue alias ${normalized} <path> first.`);
    return { kind: "project", cwd, alias: normalized };
  }

  function sendOrRetryQueueItem(ctx: any, idPrefix: string): void {
    const item = queueStore.get(idPrefix);
    if (!item) {
      ctx.ui.notify(`No unique queue item matches ${idPrefix}`, "warning");
      return;
    }
    const updated = queueStore.update(item.id, { status: "queued", error: undefined });
    if (updated) deliverQueueItem(ctx, updated);
  }

  // Track session start
  pi.on("session_start", async (event, ctx) => {
    dismissWelcome(currentCtx ?? ctx);
    await runningWelcomeHeaderPatchReady;
    sessionGeneration++;
    sessionStartTime = Date.now();
    currentCtx = ctx;
    footerDataRef = null;
    footerDataCwd = null;
    invalidateGitStatus();
    invalidateGitBranch();
    resetLayoutCache();
    customCompactionEnabled = detectCustomCompactionEnabled(ctx.cwd);
    lastUserPrompt = "";
    isStreaming = false;
    liveAssistantUsage = null;
    approximateContextUsage = event.reason === "reload" ? estimateUnknownContextUsage(ctx) : null;
    powerlineCompacting = false;
    cancelPostCompactionDelivery();

    const settings = readSettings(ctx.cwd);
    resolvedShortcuts = resolveShortcutConfig(settings);
    config = parsePowerlineConfig(settings.powerline, PRESET_NAMES);
    showLastPrompt = config.showLastPrompt && settings.showLastPrompt !== false;
    warnInvalidSegmentSettings(ctx);

    getThinkingLevelFn = () => currentCtx?.thinkingLevel ?? "off";
    // Pi can expose the previous level here while the restored session branch
    // already contains the new level. Keep this unset so the branch wins.
    currentThinkingLevel = null;
    syncMaxThinkingWave();

    if (ctx.hasUI) {

    }

    // Initialize vibe manager (needs modelRegistry from ctx)
    initVibeManager(ctx);
    setVibeWorkingMessageColor(config.workingVibes.color);

    if (enabled && ctx.hasUI) {
      setupCustomEditor(ctx);
      if (shouldShowStartupWelcome(event.reason, config.welcome)) {
        setupWelcomeResourcesBanner(ctx, settings.quietStartup !== true);
      } else {
        dismissWelcome(ctx);
      }
    }

  });

  pi.on("session_info_changed", async (_event, ctx) => {
    if (!enabled || !config.sessionTitle.enabled || !ctx.hasUI) return;
    currentCtx = ctx;
    tuiRef?.requestRender();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    sessionGeneration++;
    dismissWelcome(ctx);
    stopMaxThinkingWave();
    statusRenderScheduler.cancel();
    restoreFooterStatusRepaintHook?.();
    restoreFooterStatusRepaintHook = null;
    shortcutInputUnsubscribe?.();
    shortcutInputUnsubscribe = null;
    cancelPostCompactionDelivery();
    requeuePendingQueueDeliveries("Session ended before queued message started");
    powerlineCompacting = false;

    currentCtx = null;
    footerDataRef = null;
    getThinkingLevelFn = null;
    currentThinkingLevel = null;
    liveAssistantUsage = null;
    tuiRef = null;
    currentEditor = null;
    resetLayoutCache();
  });

  // Check if a bash command might change git branch
  const mightChangeGitBranch = (cmd: string): boolean => {
    const gitBranchPatterns = [
      /\bgit\s+(checkout|switch|branch\s+-[dDmM]|merge|rebase|pull|reset|worktree)/,
      /\bgit\s+stash\s+(pop|apply)/,
    ];
    return gitBranchPatterns.some(p => p.test(cmd));
  };

  // Invalidate git status on file changes, trigger re-render on potential branch changes
  pi.on("tool_result", async (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      invalidateGitStatus();
      requestStatusRender();
    }
    // Check for bash commands that might change git branch
    if (event.toolName === "bash" && event.input?.command) {
      const cmd = String(event.input.command);
      if (mightChangeGitBranch(cmd)) {
        // The command has completed, so start refreshing immediately.
        invalidateGitStatus();
        invalidateGitBranch();
        requestStatusRender();
      }
    }
  });

  // Also catch user escape commands (! prefix)
  // Note: This fires BEFORE execution, so we use a longer delay and multiple re-renders
  // to ensure we catch the update after the command completes.
  pi.on("user_bash", async (event) => {
    if (mightChangeGitBranch(event.command)) {
      // Invalidate immediately so next render fetches fresh data
      invalidateGitStatus();
      invalidateGitBranch();
      // Multiple staggered re-renders to catch fast and slow commands
      setTimeout(() => requestStatusRender(), 100);
      setTimeout(() => requestStatusRender(), 300);
      setTimeout(() => requestStatusRender(), 500);
    }
  });

  pi.on("model_select", async (_event, ctx) => {
    currentCtx = ctx;
    coreContextUsageCache.reset();
    syncMaxThinkingWave();
    requestStatusRender();
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    currentCtx = ctx;
    currentThinkingLevel = resolveThinkingLevelSelection(event.level, getThinkingLevelFn?.());
    syncMaxThinkingWave();
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  pi.on("session_tree", async (_event, ctx) => {
    currentCtx = ctx;
    currentThinkingLevel = null;
    liveAssistantUsage = null;
    syncMaxThinkingWave();
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  // Generate themed working message before agent starts (has access to user's prompt)
  pi.on("before_agent_start", async (event, ctx) => {
    cancelPendingWelcome();
    finishPendingQueueDelivery(event.prompt, ctx);
    lastUserPrompt = event.prompt;
    if (ctx.hasUI) {
      onVibeBeforeAgentStart(event.prompt, ctx.ui.setWorkingMessage);
    }
  });

  // Track streaming state (footer only shows status during streaming).
  pi.on("agent_start", async (_event, ctx) => {
    isStreaming = true;
    liveAssistantUsage = null;
    onVibeAgentStart();
    currentCtx = ctx;
  });

  pi.on("message_update", async (event, ctx) => {
    if (isSessionAssistantMessage(event.message)
      && event.message.stopReason !== "error"
      && event.message.stopReason !== "aborted"
      && getUsageTokenTotal(event.message.usage) > 0) {
      liveAssistantUsage = event.message.usage;
      currentCtx = ctx;
      layoutDirty = true;
      statusRenderScheduler.schedule(CONTEXT_STATUS_RENDER_MS);
    }
  });

  pi.on("message_start", async (event, ctx) => {
    currentCtx = ctx;
    const message = event.message;
    if (isRecord(message) && message.role === "user") {
      finishPendingQueueDelivery(getPromptHistoryText(message.content), ctx);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    currentCtx = ctx;
    coreContextUsageCache.reset();
    if (isSessionAssistantMessage(event.message)) {
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
        liveAssistantUsage = null;
      } else if (getUsageTokenTotal(event.message.usage) > 0) {
        liveAssistantUsage = event.message.usage;
      }
    }
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  pi.on("turn_end", async (_event, ctx) => {
    currentCtx = ctx;
    coreContextUsageCache.reset();
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    powerlineCompacting = true;
    currentCtx = ctx;
    isStreaming = false;
    liveAssistantUsage = null;
    approximateContextUsage = null;
    coreContextUsageCache.reset();
    compactionGeneration++;
    cancelPostCompactionDelivery();
    requestQueueRender();
  });

  pi.on("session_compact", async (event, ctx) => {
    powerlineCompacting = false;
    currentCtx = ctx;
    isStreaming = false;
    liveAssistantUsage = null;
    approximateContextUsage = estimateUnknownContextUsage(ctx);
    coreContextUsageCache.reset();
    compactionGeneration++;
    cancelPostCompactionDelivery();
    const context = getQueueContext(ctx);
    if (queueStore.queuedDeliveryItems(context, "post-compact").length > 0) {
      postCompactionDelivery = { generation: sessionGeneration, context };
      schedulePostCompactionDelivery();
    }
    requestQueueRender();
  });

  pi.on("session_compact_failed", async (event, ctx) => {
    finishFailedCompaction(ctx, event.errorMessage ?? "Compaction cancelled");
  });

  pi.on("agent_settled", async () => {
    schedulePostCompactionDelivery();
  });

  // Refresh vibe on tool calls if rate limits allow it.
  pi.on("tool_call", async (event, ctx) => {
    if (ctx.hasUI) {
      // Extract recent agent context from session for richer vibe generation
      const agentContext = getRecentAgentContext(ctx);
      onVibeToolCall(event.toolName, event.input, ctx.ui.setWorkingMessage, agentContext);
    }
  });

  // Helper to extract recent agent response text (skipping thinking blocks)
  function getRecentAgentContext(ctx: any): string | undefined {
    const sessionEvents = ctx.sessionManager?.getBranch?.() ?? [];

    // Find the most recent assistant message
    for (let i = sessionEvents.length - 1; i >= 0; i--) {
      const e = sessionEvents[i];
      if (e.type === "message" && e.message?.role === "assistant") {
        const content = e.message.content;
        if (!Array.isArray(content)) continue;

        // Extract text content, skip thinking blocks
        for (const block of content) {
          if (block.type === "text" && block.text) {
            // Return first ~200 chars of non-empty text
            const text = block.text.trim();
            if (text.length > 0) {
              return text.slice(0, 200);
            }
          }
        }
      }
    }
    return undefined;
  }

  function cancelPendingWelcome(): void {
    welcomeRequest?.abort();
    welcomeRequest = null;
    if (welcomeTimer) clearTimeout(welcomeTimer);
    welcomeTimer = null;
  }

  function dismissWelcome(ctx: any) {
    cancelPendingWelcome();
    const activePlacement = welcomePlacement;
    welcomePlacement = null;
    if (activePlacement === "loadedResources") {
      ctx.ui.setHeader(undefined);
    }
  }
  function copyTextToClipboard(ctx: any, text: string, successMessage?: string): void {
    copyToClipboard(text);
    if (successMessage) {
      ctx.ui.notify(successMessage, "info");
    }
  }

  function getEditorTextForClipboard(ctx: any): string | null {
    const text = getCurrentEditorText(ctx, currentEditor);
    if (hasNonWhitespaceText(text)) {
      return text;
    }

    ctx.ui.notify("Editor is empty", "info");
    return null;
  }

  function getPowerlineShortcutAction(data: string): PowerlineShortcutAction | null {
    if (isKeyRelease(data)) return null;

    if (matchesConfiguredShortcut(data, resolvedShortcuts.copyEditor)) {
      return { kind: "copyEditor" };
    }
    if (matchesConfiguredShortcut(data, resolvedShortcuts.cutEditor)) {
      return { kind: "cutEditor" };
    }
    if (matchesConfiguredShortcut(data, resolvedShortcuts.queueOpen)) {
      return { kind: "queueOpen" };
    }
    if (resolvedShortcuts.reply && matchesConfiguredShortcut(data, resolvedShortcuts.reply)) {
      return { kind: "reply" };
    }

    return null;
  }

  function runPowerlineShortcut(ctx: any, action: PowerlineShortcutAction): void {
    if (action.kind === "copyEditor" || action.kind === "cutEditor") {
      const text = getEditorTextForClipboard(ctx);
      if (!text) return;

      copyTextToClipboard(ctx, text, action.kind === "copyEditor" ? "Copied editor text" : undefined);
      if (action.kind === "cutEditor") {
        ctx.ui.setEditorText("");
        ctx.ui.notify("Cut editor text", "info");
      }
      return;
    }

    if (action.kind === "queueOpen") {
      void openQueuePicker(ctx);
      return;
    }
    if (action.kind === "reply") {
      void import("./quote-reply.ts").then(({ reply }) => reply("", ctx));
      return;
    }
  }

  pi.on("agent_end", async (_event, ctx) => {
    isStreaming = false;
    liveAssistantUsage = null;
    coreContextUsageCache.reset();

    let hasUI = false;
    try {
      hasUI = Boolean(ctx.hasUI);
    } catch (error) {
      if (!isStaleExtensionContextError(error)) throw error;
      currentCtx = null;
      return;
    }

    currentCtx = ctx;
    try {
      if (hasUI) {
        onVibeAgentEnd(ctx.ui.setWorkingMessage); // working-vibes internal state + reset message
      }
    } catch (error) {
      if (!isStaleExtensionContextError(error)) throw error;
      currentCtx = null;
      return;
    }

    requestStatusRender();
    schedulePostCompactionDelivery();
  });

  registerCdCommand(pi, () => currentCtx?.cwd ?? process.cwd());

  pi.registerCommand("reply", {
    description: "Quote a previous user or assistant message into the editor",
    handler: async (args, ctx) => {
      const { reply } = await import("./quote-reply.ts");
      await reply(args, ctx);
    },
  });

  pi.registerCommand("queue", {
    description: "Manage Powerline queued prompts and project aliases",
    handler: async (args, ctx) => {
      currentCtx = ctx;
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts[0];

      if (!action) {
        await openQueuePicker(ctx);
        return;
      }

      if (action === "alias") {
        const alias = parts[1];
        const aliasPath = parts.slice(2).join(" ") || ctx.cwd || process.cwd();
        if (!alias) {
          ctx.ui.notify("Usage: /queue alias <name> [path]", "info");
          return;
        }
        try {
          queueStore.setAlias(alias, aliasPath);
          ctx.ui.notify(`Alias @${alias} → ${aliasPath}`, "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      if (action === "send" || action === "retry") {
        const id = parts[1];
        if (!id) {
          const item = queueStore.queuedDeliveryItems(getQueueContext(ctx))[0];
          if (!item) {
            ctx.ui.notify("No queued item to send", "info");
            return;
          }
          sendOrRetryQueueItem(ctx, item.id);
          return;
        }
        sendOrRetryQueueItem(ctx, id);
        return;
      }

      if (action === "clear") {
        const id = parts[1];
        if (id === "all") {
          const active = queueStore.activeItems(getQueueContext(ctx));
          for (const item of active) queueStore.clear(item.id);
          ctx.ui.notify(`Cleared ${active.length} queued item${active.length === 1 ? "" : "s"}`, "info");
          requestQueueRender();
          return;
        }
        if (!id) {
          ctx.ui.notify("Usage: /queue clear <id|all>", "info");
          return;
        }
        const item = queueStore.get(id);
        if (!item) {
          ctx.ui.notify(`No unique queued item matches ${id}`, "warning");
          return;
        }
        queueStore.clear(item.id);
        ctx.ui.notify(`Cleared ${item.id}`, "info");
        requestQueueRender();
        return;
      }

      if (action === "target") {
        const id = parts[1];
        const spec = parts[2];
        if (!id || !spec) {
          ctx.ui.notify("Usage: /queue target <id> @alias|global|current", "info");
          return;
        }
        const item = queueStore.get(id);
        if (!item) {
          ctx.ui.notify(`No unique queue item matches ${id}`, "warning");
          return;
        }
        try {
          const target = resolveCommandTarget(ctx, spec);
          queueStore.update(item.id, { target });
          ctx.ui.notify(`Retargeted ${item.id}`, "info");
          requestQueueRender();
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      ctx.ui.notify("Usage: /queue [send|retry|clear|target|alias]", "info");
    },
  });

  // Command to toggle/configure
  pi.registerCommand("powerline", {
    description: "Configure powerline status (toggle, preset)",
    handler: async (args, ctx) => {
      // Update context reference (command ctx may have more methods)
      currentCtx = ctx;

      if (!args?.trim()) {
        // Toggle
        enabled = !enabled;
        if (enabled) {
          setupCustomEditor(ctx);
          syncMaxThinkingWave();
          ctx.ui.notify("Powerline enabled", "info");
        } else {
          dismissWelcome(ctx);
          clearEditorHistorySnapshot();
          restoreFooterStatusRepaintHook?.();
          restoreFooterStatusRepaintHook = null;
          shortcutInputUnsubscribe?.();
          shortcutInputUnsubscribe = null;
          // Clear all custom UI components
          ctx.ui.setEditorComponent(undefined);
          ctx.ui.setFooter(undefined);
          ctx.ui.setHeader(undefined);
          ctx.ui.setWidget("powerline-top", undefined);
          ctx.ui.setWidget("powerline-secondary", undefined);
          ctx.ui.setWidget("powerline-bash-transcript", undefined);
          ctx.ui.setWidget("powerline-status", undefined);
          ctx.ui.setWidget("powerline-queue-preview", undefined);
          ctx.ui.setWidget("powerline-last-prompt", undefined);
          ctx.ui.setWidget("powerline-session-title", undefined);
          footerDataRef = null;
          tuiRef = null;
          currentEditor = null;
          stopMaxThinkingWave();
          statusRenderScheduler.cancel();
          resetLayoutCache();
          ctx.ui.notify("Powerline disabled", "info");
        }
        return;
      }

      const normalizedArgs = args.trim().toLowerCase();
      const placementMatch = /^placement(?:\s+(above|below|toggle))?$/.exec(normalizedArgs);
      if (placementMatch) {
        const requestedPlacement = placementMatch[1];
        config.placement = requestedPlacement === "above" || requestedPlacement === "below"
          ? requestedPlacement
          : config.placement === "above" ? "below" : "above";
        config.invalidPlacement = null;
        if (enabled && ctx.hasUI) setupCustomEditor(ctx);

        if (writePowerlineOptionSetting(ctx.cwd, { placement: config.placement }, config.preset)) {
          ctx.ui.notify(`Powerline placement set to: ${config.placement}`, "info");
        } else {
          ctx.ui.notify(`Powerline placement set to: ${config.placement} (not persisted; check settings.json)`, "warning");
        }
        return;
      }

      const preset = normalizePreset(args);
      if (preset) {
        config.preset = preset;
        resetLayoutCache();
        if (enabled) {
          setupCustomEditor(ctx);
        }

        if (writePowerlinePresetSetting(preset, ctx.cwd)) {
          ctx.ui.notify(`Preset set to: ${preset}`, "info");
        } else {
          ctx.ui.notify(`Preset set to: ${preset} (not persisted; check settings.json)`, "warning");
        }
        return;
      }

      // Show available presets
      const presetList = Object.keys(PRESETS).join(", ");
      ctx.ui.notify(`Available presets: ${presetList}`, "info");
    },
  });


  // Command to set working message theme
  pi.registerCommand("vibe", {
    description: "Set working message theme. Usage: /vibe [theme|off|mode|model|generate]",
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/) || [];
      const subcommand = parts[0]?.toLowerCase();

      // No args: show current status
      if (!args || !args.trim()) {
        const theme = getVibeTheme();
        const mode = getVibeMode();
        const model = getVibeModel();
        let status = `Vibe: ${theme || "off"} | Mode: ${mode} | Model: ${model}`;
        if (theme && mode === "file") {
          const count = getVibeFileCount(theme);
          status += count > 0 ? ` | File: ${count} vibes` : " | File: not found";
        }
        ctx.ui.notify(status, "info");
        return;
      }

      // /vibe model [spec] - show or set model
      if (subcommand === "model") {
        const modelSpec = parts.slice(1).join(" ");
        if (!modelSpec) {
          ctx.ui.notify(`Current vibe model: ${getVibeModel()}`, "info");
          return;
        }
        // Validate format (provider/modelId)
        if (!modelSpec.includes("/")) {
          ctx.ui.notify("Invalid model format. Use: provider/modelId (e.g., openai-codex/gpt-5.4-mini)", "error");
          return;
        }
        const persisted = setVibeModel(modelSpec);
        if (persisted) {
          ctx.ui.notify(`Vibe model set to: ${modelSpec}`, "info");
        } else {
          ctx.ui.notify(`Vibe model set to: ${modelSpec} (not persisted; check settings.json)`, "warning");
        }
        return;
      }

      // /vibe mode [generate|file] - show or set mode
      if (subcommand === "mode") {
        const newMode = parts[1]?.toLowerCase();
        if (!newMode) {
          ctx.ui.notify(`Current vibe mode: ${getVibeMode()}`, "info");
          return;
        }
        if (newMode !== "generate" && newMode !== "file") {
          ctx.ui.notify("Invalid mode. Use: generate or file", "error");
          return;
        }
        // Check if file exists when switching to file mode
        const theme = getVibeTheme();
        if (newMode === "file" && theme && !hasVibeFile(theme)) {
          ctx.ui.notify(`No vibe file for "${theme}". Run /vibe generate ${theme} first`, "error");
          return;
        }
        const persisted = setVibeMode(newMode);
        if (persisted) {
          ctx.ui.notify(`Vibe mode set to: ${newMode}`, "info");
        } else {
          ctx.ui.notify(`Vibe mode set to: ${newMode} (not persisted; check settings.json)`, "warning");
        }
        return;
      }

      // /vibe generate <theme> [count] - generate vibes and save to file
      if (subcommand === "generate") {
        const parsed = parseVibeGenerateArgs(parts.slice(1));
        if (!parsed) {
          ctx.ui.notify("Usage: /vibe generate <theme> [count]", "error");
          return;
        }

        const { theme, count } = parsed;
        ctx.ui.notify(`Generating ${count} vibes for "${theme}"...`, "info");

        const result = await generateVibesBatch(theme, count);

        if (result.success) {
          ctx.ui.notify(`Generated ${result.count} vibes for "${theme}" → ${result.filePath}`, "info");
        } else {
          ctx.ui.notify(`Failed to generate vibes: ${result.error}`, "error");
        }
        return;
      }

      // /vibe off - disable
      if (subcommand === "off") {
        const persisted = setVibeTheme(null);
        if (persisted) {
          ctx.ui.notify("Vibe disabled", "info");
        } else {
          ctx.ui.notify("Vibe disabled (not persisted; check settings.json)", "warning");
        }
        return;
      }

      // /vibe <theme> - set theme (preserve original casing)
      const theme = args.trim();
      const persisted = setVibeTheme(theme);
      const mode = getVibeMode();
      if (mode === "file" && !hasVibeFile(theme)) {
        const suffix = persisted ? "" : " (not persisted; check settings.json)";
        ctx.ui.notify(`Vibe set to: ${theme} (file mode, but no file found - run /vibe generate ${theme})${suffix}`, "warning");
      } else if (persisted) {
        ctx.ui.notify(`Vibe set to: ${theme}`, "info");
      } else {
        ctx.ui.notify(`Vibe set to: ${theme} (not persisted; check settings.json)`, "warning");
      }
    },
  });

  function buildSegmentContext(ctx: any, theme: Theme, allSegmentIds: StatusLineSegmentId[]): SegmentContext {
    setVibeWorkingMessageTheme(theme);
    const presetDef = getPreset(config.preset);
    const colors: ColorScheme = presetDef.colors ?? getDefaultColors();

    // Build usage stats and get thinking level from session (cached; the full
    // event list is only re-scanned when events are appended or the trailing
    // event's stats-relevant fields change, e.g. in-place streaming updates)
    const sessionEvents = sessionBranchCache.get(ctx.sessionManager);
    const tokenStats = tokenStatsCache.get(sessionEvents);
    const { input, output, cacheRead, cacheWrite, cost, subagentCost } = tokenStats;
    const lastAssistant = tokenStats.lastAssistant;
    const thinkingLevelFromSession = tokenStats.thinkingLevelFromSession;

    // Calculate context percentage.
    const latestUsage = isStreaming ? liveAssistantUsage ?? lastAssistant?.usage : lastAssistant?.usage;
    const coreContextUsage = isStreaming && liveAssistantUsage ? null : coreContextUsageCache.get(ctx);
    const fallbackContextTokens = latestUsage ? getUsageTokenTotal(latestUsage) : 0;
    const {
      contextTokens,
      contextWindow,
      contextPercent,
    } = resolveDisplayContextUsage({
      coreContextUsage,
      unknownCoreFallback: approximateContextUsage,
      fallbackContextTokens,
      fallbackContextWindow: ctx.model?.contextWindow ?? 0,
    });
    const contextApproximate = coreContextUsage?.contextTokens === null && approximateContextUsage !== null;

    const segmentOptions = mergeSegmentOptions(presetDef.segmentOptions, config.segmentOptions);

    const gitOptions = segmentOptions.git;
    const showGit = allSegmentIds.includes("git") && [
      gitOptions?.showBranch, gitOptions?.showStaged, gitOptions?.showUnstaged, gitOptions?.showUntracked,
    ].some((visible) => visible !== false);
    const gitBranch = showGit && footerDataCwd === ctx.cwd
      ? footerDataRef?.getGitBranch() ?? null
      : null;
    // Full mode retains counts for dirty branch coloring, even with hidden indicators.
    const gitStatus = showGit
      ? getGitStatus(gitBranch, gitOptions?.polling, ctx.cwd)
      : { branch: null, staged: 0, unstaged: 0, untracked: 0 };
    const extensionStatuses = footerDataRef?.getExtensionStatuses() ?? new Map();
    const customItemsById = new Map(config.customItems.map((item) => [item.id, item]));
    const hiddenExtensionStatusKeys = collectHiddenExtensionStatusKeys(config.customItems);

    // Check if using OAuth subscription
    const usingSubscription = ctx.model
      ? ctx.modelRegistry?.isUsingOAuth?.(ctx.model) ?? false
      : false;

    const thinkingLevel = currentThinkingLevel ?? thinkingLevelFromSession ?? getThinkingLevelFn?.() ?? "off";
    const queueSummary: QueueSummary = allSegmentIds.includes("queue") ? getQueueSummary(ctx) : {
      queueCount: 0,
      blockedCount: 0,
      compacting: powerlineCompacting,
      leadingText: null,
      leadingIntent: null,
      leadingStatus: null,
    };

    return {
      model: ctx.model,
      thinkingLevel,
      thinkingWaveFrame: Math.floor(Date.now() / MAX_THINKING_WAVE_FRAME_MS),
      sessionId: ctx.sessionManager?.getSessionId?.(),
      cwd: ctx.cwd,
      usageStats: { input, output, cacheRead, cacheWrite, cost, subagentCost },
      contextTokens,
      contextPercent,
      contextWindow,
      contextApproximate,
      autoCompactEnabled: ctx.settingsManager?.getCompactionSettings?.()?.enabled ?? true,
      customCompactionEnabled: customCompactionEnabled || extensionStatuses.has(CUSTOM_COMPACTION_STATUS_KEY),
      usingSubscription,
      queueSummary,
      sessionStartTime,
      git: gitStatus,
      extensionStatuses,
      hiddenExtensionStatusKeys,
      customItemsById,
      options: segmentOptions,
      theme,
      colors,
    };
  }

  /**
   * Get cached responsive layout or compute fresh one.
   * The segment context scans session state, so keep it stable across render bursts.
   */
  function getResponsiveLayout(width: number, theme: Theme): ResponsiveLayout {
    const now = Date.now();
    const cacheTtl = isStreaming ? STREAMING_LAYOUT_CACHE_TTL_MS : LAYOUT_CACHE_TTL_MS;

    if (lastLayoutResult && lastLayoutWidth === width) {
      const msSinceInput = now - lastEditorInputAt;
      const typingRecently = msSinceInput < EDITOR_STATUS_DEFER_MS;

      if (!forceNextLayoutRecompute && typingRecently && (layoutDirty || now - lastLayoutTimestamp >= cacheTtl)) {
        return refreshMaxThinkingWave(lastLayoutResult, lastLayoutThinkingWaveFrame, Math.floor(now / MAX_THINKING_WAVE_FRAME_MS));
      }

      if (!layoutDirty && now - lastLayoutTimestamp < cacheTtl) {
        return refreshMaxThinkingWave(lastLayoutResult, lastLayoutThinkingWaveFrame, Math.floor(now / MAX_THINKING_WAVE_FRAME_MS));
      }
    }

    const presetDef = getPreset(config.preset);
    const mergedSegments = mergeSegmentsWithCustomItems(presetDef, config.customItems, {
      layout: config.layout,
      disabledSegments: config.disabledSegments,
    });
    const allSegmentIds = [
      ...mergedSegments.leftSegments,
      ...mergedSegments.rightSegments,
      ...mergedSegments.secondarySegments,
    ];
    let segmentCtx: SegmentContext;
    try {
      segmentCtx = editorPerf.options.enabled
        ? editorPerf.measure("layout.segment-context", () => buildSegmentContext(currentCtx, theme, allSegmentIds))
        : buildSegmentContext(currentCtx, theme, allSegmentIds);
    } catch (error) {
      if (!isStaleExtensionContextError(error)) throw error;
      currentCtx = null;
      lastLayoutWidth = width;
      lastLayoutResult = { topContent: "", secondaryContent: "", secondaryLines: [] };
      lastLayoutThinkingWaveFrame = null;
      lastLayoutTimestamp = now;
      layoutDirty = false;
      forceNextLayoutRecompute = false;
      return lastLayoutResult;
    }

    lastLayoutWidth = width;
    lastLayoutResult = computeResponsiveLayout(segmentCtx, presetDef, mergedSegments, width);
    lastLayoutThinkingWaveFrame = segmentCtx.thinkingLevel === "max" ? segmentCtx.thinkingWaveFrame ?? null : null;
    lastLayoutTimestamp = now;
    layoutDirty = false;
    forceNextLayoutRecompute = false;

    return lastLayoutResult;
  }

  function renderPowerlineStatusLines(width: number): string[] {
    if (!currentCtx || !footerDataRef) return [];

    const statuses = footerDataRef.getExtensionStatuses();
    if (!statuses || statuses.size === 0) return [];
    const hiddenExtensionStatusKeys = collectHiddenExtensionStatusKeys(config.customItems);

    const notifications: string[] = [];
    for (const value of getNotificationExtensionStatuses(statuses, hiddenExtensionStatusKeys)) {
      const lineContent = ` ${value}`;
      if (visibleWidth(lineContent) <= width) {
        notifications.push(lineContent);
      }
    }

    return notifications;
  }

  function renderPowerlinePrimaryLines(width: number, theme: Theme): string[] {
    if (!currentCtx) return [];

    const layout = getResponsiveLayout(width, theme);
    return layout.topContent ? [layout.topContent] : [];
  }

  function renderPowerlineSecondaryLines(width: number, theme: Theme): string[] {
    if (!currentCtx) return [];

    const layout = getResponsiveLayout(width, theme);
    return layout.secondaryLines;
  }

  function renderPowerlineQueuePreviewLines(width: number, theme: Theme): string[] {
    if (!currentCtx) return [];
    const summary = getQueueSummary(currentCtx);
    if (!summary.leadingText) return [];

    const prefix = summary.leadingStatus === "blocked" || summary.leadingStatus === "failed"
      ? "blocked: "
      : summary.leadingStatus === "delivering"
        ? "sending: "
        : "queued: ";
    const text = `${prefix}${summary.leadingText.replace(/\s+/g, " ").trim()}`;
    const color = summary.leadingStatus === "blocked" || summary.leadingStatus === "failed" ? "warning" : "dim";
    return [` ${theme.fg(color, truncateToWidth(text, Math.max(1, width - 1), "…"))}`];
  }

  function renderSessionTitleLines(width: number, theme: Theme): string[] {
    if (!config.sessionTitle.enabled || !currentCtx) return [];

    const sessionName = currentCtx.sessionManager?.getSessionName?.()?.trim();
    if (!sessionName) return [];

    return buildSessionTitleLines(
      theme.fg("accent", sessionName),
      width,
      config.sessionTitle.alignment,
    );
  }

  function renderLastPromptLines(width: number): string[] {
    if (!showLastPrompt || !lastUserPrompt) return [];

    const color = getFgAnsiCode("sep");
    if (
      lastPromptRenderCache
      && lastPromptRenderCache.source === lastUserPrompt
      && lastPromptRenderCache.width === width
      && lastPromptRenderCache.color === color
    ) {
      return lastPromptRenderCache.lines;
    }

    const compact = lastPromptRenderCache?.source === lastUserPrompt
      ? lastPromptRenderCache.compact
      : lastUserPrompt.replace(/\s+/g, " ").trim();
    const prefix = ` ${color}↳${ansi.reset} `;
    const availableWidth = width - visibleWidth(prefix);
    const lines = compact && availableWidth >= 10
      ? [truncateToWidth(`${prefix}${color}${truncateToWidth(compact, availableWidth, "…")}${ansi.reset}`, width, "…")]
      : [];

    lastPromptRenderCache = { source: lastUserPrompt, compact, width, color, lines };
    return lines;
  }

  function installPowerlineWidgets(ctx: any) {
    if (!editorPerf.options.widgets) return;

    const measureWidget = (name: string, render: () => string[]): string[] => {
      return editorPerf.options.enabled ? editorPerf.measure(`widget.${name}`, render) : render();
    };

    ctx.ui.setWidget("powerline-status", () => ({
      dispose() {},
      invalidate() {
        requestStatusRender();
      },
      render(width: number): string[] {
        return measureWidget("status", () => renderPowerlineStatusLines(width));
      },
    }), { placement: "aboveEditor" });

    ctx.ui.setWidget(
      "powerline-top",
      config.placement === "above"
        ? (_tui: any, theme: Theme) => ({
            dispose() {},
            invalidate() {
              resetLayoutCache();
            },
            render(width: number): string[] {
              return measureWidget("primary", () => renderPowerlinePrimaryLines(width, theme));
            },
          })
        : undefined,
      { placement: "aboveEditor" },
    );

    ctx.ui.setWidget("powerline-queue-preview", (_tui: any, theme: Theme) => ({
      dispose() {},
      invalidate() {},
      render(width: number): string[] {
        return measureWidget("queue-preview", () => renderPowerlineQueuePreviewLines(width, theme));
      },
    }), { placement: "belowEditor" });

    if (editorPerf.options.lastPrompt) {
      ctx.ui.setWidget("powerline-last-prompt", () => ({
        dispose() {},
        invalidate() {},
        render(width: number): string[] {
          return measureWidget("last-prompt", () => renderLastPromptLines(width));
        },
      }), { placement: "belowEditor" });
    }

    ctx.ui.setWidget("powerline-session-title", (_tui: any, theme: Theme) => ({
      dispose() {},
      invalidate() {},
      render(width: number): string[] {
        return renderSessionTitleLines(width, theme);
      },
    }), { placement: config.placement === "below" ? "aboveEditor" : "belowEditor" });
  }

  function setupCustomEditor(ctx: any) {
    snapshotEditorHistory(currentEditor);
    if (!enabled) {
      return;
    }

    shortcutInputUnsubscribe?.();
    shortcutInputUnsubscribe = typeof ctx.ui.onTerminalInput === "function"
      ? ctx.ui.onTerminalInput((data: string) => {
        if (!enabled || !ctx.hasUI || tuiRef?.hasOverlay?.()) {
          return undefined;
        }
        cancelPendingWelcome();
        const powerlineShortcutAction = getPowerlineShortcutAction(data);
        if (!powerlineShortcutAction) {
          return undefined;
        }

        runPowerlineShortcut(ctx, powerlineShortcutAction);
        tuiRef?.requestRender();
        return { consume: true };
      })
      : null;

    ctx.ui.setWidget("powerline-top", undefined);
    ctx.ui.setWidget("powerline-secondary", undefined);
    ctx.ui.setWidget("powerline-status", undefined);
    ctx.ui.setWidget("powerline-queue-preview", undefined);
    ctx.ui.setWidget("powerline-last-prompt", undefined);
    ctx.ui.setWidget("powerline-session-title", undefined);

    let autocompleteFixed = false;
    const previousEditorFactory = typeof ctx.ui.getEditorComponent === "function" ? ctx.ui.getEditorComponent() : undefined;

    const editorFactory = (tui: any, editorTheme: any, keybindings: any) => {
      const previousEditor = previousEditorFactory?.(tui, editorTheme, keybindings);
      const editor = new PowerlineEditor(tui, editorTheme, keybindings, {
        editorBoundaryShortcuts: {
          start: resolvedShortcuts.editorStart,
          end: resolvedShortcuts.editorEnd,
        },
      });

      // Reserve one menu row for the closing autocomplete border.
      const setAutocompleteMaxVisible = editor.setAutocompleteMaxVisible.bind(editor);
      editor.setAutocompleteMaxVisible = (maxVisible: number) =>
        setAutocompleteMaxVisible(Math.max(3, maxVisible - 1));

      let installingPowerlineAutocompleteProvider = false;
      const originalSetAutocompleteProvider = editor.setAutocompleteProvider.bind(editor);
      editor.setAutocompleteProvider = (provider: AutocompleteProvider) => {
        if (installingPowerlineAutocompleteProvider) {
          originalSetAutocompleteProvider(provider);
          return;
        }

        originalSetAutocompleteProvider(passAutocompleteProviderThroughPreviousEditor(provider, previousEditor));
        attachAutocompleteProvider();
      };

      const getInstalledAutocompleteProvider = (): AutocompleteProvider | undefined => {
        return getEditorAutocompleteProvider(editor) ?? getEditorAutocompleteProvider(previousEditor);
      };

      const attachAutocompleteProvider = (): boolean => {
        if (editor.hasWrappedProvider()) return true;
        const defaultProvider = getInstalledAutocompleteProvider();
        if (!defaultProvider) return false;

        installingPowerlineAutocompleteProvider = true;
        try {
          editor.installAutocompleteProvider(defaultProvider);
        } finally {
          installingPowerlineAutocompleteProvider = false;
        }
        return true;
      };

      currentEditor = editor;
      trackEditorHistory(editor);
      restoreEditorHistory(editor);
      attachAutocompleteProvider();

      const baseHandleInput = editor.handleInput.bind(editor);
      const originalHandleInput = editorPerf.options.enabled
        ? (data: string) => editorPerf.measure("input.base-editor", () => baseHandleInput(data))
        : baseHandleInput;
      const handlePowerlineEditorInput = (data: string) => {
        lastEditorInputAt = Date.now();
        cancelPendingWelcome();
        const isSubmit = keybindings.matches(data, "tui.input.submit") && !keybindings.matches(data, "tui.input.newLine");
        const isFollowUpSubmit = keybindings.matches(data, "app.message.followUp");
        if (!powerlineCompacting && isSubmit && typeof ctx.compact === "function") {
          const editorText = editor.getExpandedText().trim();
          const compactQueuedPrompt = config.queue.compactPromptMode === "queue"
            ? parseCompactQueuedPrompt(editorText)
            : null;
          if (editorText === "/compact" || compactQueuedPrompt) {
            editor.addToHistory?.(editorText);
            editor.setText("");
            if (compactQueuedPrompt) {
              capturePostCompactPrompt(ctx, compactQueuedPrompt);
            }
            powerlineCompacting = true;
            cancelPostCompactionDelivery();
            const generation = sessionGeneration;
            const operation = ++compactionGeneration;
            requestQueueRender();
            ctx.compact({
              onError: (error: Error) => {
                // Preparation can fail before session_before_compact increments the operation.
                if (generation !== sessionGeneration || compactionGeneration > operation + 1 || !powerlineCompacting) return;
                finishFailedCompaction(ctx, error.message);
                ctx.ui.notify(error.message, "error");
              },
            });
            return;
          }
        }

        if (powerlineCompacting && (isSubmit || isFollowUpSubmit)) {
          const text = editor.getExpandedText().trim();
          if (!text) return;
          if (text.startsWith("/")) {
            originalHandleInput(data);
            return;
          }
          editor.addToHistory?.(text);
          editor.setText("");
          capturePostCompactPrompt(ctx, text);
          return;
        }

        const powerlineShortcutAction = getPowerlineShortcutAction(data);
        if (powerlineShortcutAction) {
          runPowerlineShortcut(ctx, powerlineShortcutAction);
          return;
        }

        if (!autocompleteFixed && !getInstalledAutocompleteProvider()) {
          autocompleteFixed = true;
          snapshotEditorHistory(editor);
          ctx.ui.setEditorComponent(editorFactory);
          currentEditor?.handleInput(data);
          return;
        }

        attachAutocompleteProvider();
        originalHandleInput(data);
      };
      editor.handleInput = editorPerf.options.enabled
        ? (data: string) => {
            editorPerf.measure("input.total", () => handlePowerlineEditorInput(data));
            const state = Reflect.get(editor, "state");
            const lines = state && typeof state === "object" ? Reflect.get(state, "lines") : null;
            if (Array.isArray(lines)) editorPerf.observeDraft(lines);
          }
        : handlePowerlineEditorInput;

      const originalRender = editor.render.bind(editor);
      editor.render = (width: number): string[] => {
        const renderPowerlineEditor = (): string[] => {

          if (editorPerf.options.fastRender) {
            const fastLines = editorPerf.options.enabled
              ? editorPerf.measure("editor.render.fast-probe", () => renderFastPowerlineEditor(editor, width))
              : renderFastPowerlineEditor(editor, width);
            if (fastLines) {
              if (editorPerf.options.enabled) editorPerf.count("editor.render.fast-hit");
              return fastLines;
            }
          }

          if (width < 10) {
            return editorPerf.options.enabled
              ? editorPerf.measure("editor.render.base", () => originalRender(width))
              : originalRender(width);
          }

          const bc = (s: string) => `${getFgAnsiCode("sep")}${s}${ansi.reset}`;
          const promptGlyph = ">";
          const promptColor = ansi.getFgAnsi(200, 200, 200);
          const prompt = `${promptColor}${promptGlyph}${ansi.reset}`;
          const promptPrefix = `${prompt} `;
          const contPrefix = "  ";
          const contentWidth = Math.max(1, width - 2);
          const lines = editorPerf.options.enabled
            ? editorPerf.measure("editor.render.base", () => originalRender(contentWidth))
            : originalRender(contentWidth);

          if (lines.length === 0) return lines;

          let bottomBorderIndex = lines.length - 1;
          for (let i = lines.length - 1; i >= 1; i--) {
            const stripped = lines[i]?.replace(/\x1b\[[0-9;]*m/g, "") || "";
            if (stripped.length > 0 && /^─{3,}/.test(stripped)) {
              bottomBorderIndex = i;
              break;
            }
          }
          const hasAutocompleteLines = editor.isShowingAutocomplete() && lines.length > bottomBorderIndex + 1;

          const result: string[] = [];
          result.push(bc("─".repeat(width)));

          for (let i = 1; i < bottomBorderIndex; i++) {
            const prefix = i === 1 ? promptPrefix : contPrefix;
            result.push(`${prefix}${lines[i] || ""}`);
          }

          if (bottomBorderIndex === 1) {
            result.push(`${promptPrefix}${" ".repeat(contentWidth)}`);
          }

          result.push(bc("─".repeat(width)));

          for (let i = bottomBorderIndex + 1; i < lines.length; i++) {
            result.push(lines[i] || "");
          }
          if (hasAutocompleteLines) {
            result.push(bc("─".repeat(width)));
          }

          return result;
        };

        return editorPerf.options.enabled
          ? editorPerf.measure("editor.render.total", renderPowerlineEditor)
          : renderPowerlineEditor();
      };

      return editor;
    };

    ctx.ui.setEditorComponent(editorFactory);

    const footerFactory = markPowerlineFooterFactory((
      tui: any,
      theme: Theme,
      footerData: ReadonlyFooterDataProvider,
    ) => {
      footerDataRef = footerData;
      // Pi sets the provider cwd from sessionManager before binding session_start.
      // Do not treat its branch as authoritative if the extension cwd differs.
      footerDataCwd = ctx.sessionManager?.getCwd?.() ?? null;
      tuiRef = tui;
      installFooterStatusRepaintHook(footerData);
      const unsub = footerData.onBranchChange(() => {
        invalidateGitStatus();
        invalidateGitBranch();
        requestStatusRender();
      });
      const unsubGitUpdates = subscribeGitUpdates(() => requestStatusRender());

      return {
        dispose() {
          unsub();
          unsubGitUpdates();
          footerDataRef = null;
          footerDataCwd = null;
          restoreFooterStatusRepaintHook?.();
          restoreFooterStatusRepaintHook = null;
        },
        invalidate() {
          requestStatusRender();
        },
        render(width: number): string[] {
          return buildPowerlineFooterLines(
            config.placement,
            renderPowerlinePrimaryLines(width, theme),
            renderPowerlineSecondaryLines(width, theme),
          );
        },
      };
    });
    ctx.ui.setFooter(footerFactory);

    installPowerlineWidgets(ctx);
  }

  function beginWelcomeRequest(ctx: any): AbortController {
    dismissWelcome(ctx);
    welcomeRequest = new AbortController();
    return welcomeRequest;
  }

  function canShowWelcome(ctx: any, request: AbortController, generation: number): boolean {
    if (request !== welcomeRequest || request.signal.aborted || generation !== sessionGeneration
      || !enabled || !config.welcome || !ctx.hasUI || isStreaming
      || ctx.ui.getEditorText()) return false;
    const sessionEvents = ctx.sessionManager?.getBranch?.() ?? [];
    return !sessionEvents.some((entry: unknown) => {
      if (!isRecord(entry)) return false;
      if (entry.type === "tool_call" || entry.type === "tool_result") return true;
      return entry.type === "message" && isRecord(entry.message) && entry.message.role === "assistant";
    });
  }

  function createWelcomeBanner(
    ctx: any,
    recentSessions: Awaited<ReturnType<typeof getRecentSessions>>,
    options: { trailingSpacing?: boolean } = {},
  ): WelcomeHeader {
    const modelName = ctx.model?.name || ctx.model?.id || "No model";
    const providerName = ctx.model?.provider || "Unknown";
    const loadedCounts = discoverLoadedCounts();
    const initialContextTokens = estimateInitialContextTokens(ctx);
    const preset = getPreset(config.preset);
    const modelOptions = mergeSegmentOptions(preset.segmentOptions, config.segmentOptions).model ?? {};

    return new WelcomeHeader(modelName, providerName, recentSessions, loadedCounts, initialContextTokens, {
      ...options,
      modelAppearance: {
        color: modelOptions.color,
        colors: preset.colors,
        bold: modelOptions.bold ?? false,
      },
    });
  }

  function setupWelcomeResourcesBanner(ctx: any, forceResources: boolean): void {
    const request = beginWelcomeRequest(ctx);
    const generation = sessionGeneration;
    // Keep optional archive discovery off the session_start completion path.
    welcomeTimer = setTimeout(async () => {
      welcomeTimer = null;
      try {
        if (!canShowWelcome(ctx, request, generation)) return;
        const recentSessions = await getRecentSessions(3, request.signal);
        if (!canShowWelcome(ctx, request, generation)) return;

        ctx.ui.setHeader(markPowerlineWelcomeHeaderFactory(
          () => createWelcomeBanner(ctx, recentSessions),
          () => {
            if (welcomePlacement === "loadedResources") welcomePlacement = null;
          },
          forceResources,
        ));
        welcomePlacement = "loadedResources";
        if (welcomeRequest === request) welcomeRequest = null;
      } catch (error: unknown) {
        if (!request.signal.aborted || error !== request.signal.reason) {
          console.debug("[powerline-footer] Welcome banner failed:", error);
        }
      }
    }, 0);
  }
}
