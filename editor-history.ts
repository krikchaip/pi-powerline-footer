const EDITOR_HISTORY_LIMIT = 100;
const EDITOR_HISTORY_TRACKED = Symbol.for("powerlineEditorHistoryTracked");
const EDITOR_HISTORY_STATE_KEY = Symbol.for("powerlineEditorHistoryState");

interface EditorWithHistory {
  addToHistory?: (text: string) => void;
}

type EditorHistoryState = { savedEntries: string[] };

function isEditorHistoryState(value: unknown): value is EditorHistoryState {
  return typeof value === "object"
    && value !== null
    && Array.isArray((value as EditorHistoryState).savedEntries)
    && (value as EditorHistoryState).savedEntries.every((entry) => typeof entry === "string");
}

function getEditorHistoryState(): EditorHistoryState {
  const existing = Reflect.get(globalThis, EDITOR_HISTORY_STATE_KEY);
  if (isEditorHistoryState(existing)) return existing;

  const state: EditorHistoryState = { savedEntries: [] };
  Reflect.set(globalThis, EDITOR_HISTORY_STATE_KEY, state);
  return state;
}

function readEditorHistory(editor: EditorWithHistory | null | undefined): string[] {
  if (!editor) return [];
  const history = Reflect.get(editor, "history");
  if (!Array.isArray(history)) return [];

  const entries: string[] = [];
  for (const entry of history) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || entries[entries.length - 1] === trimmed) continue;
    entries.push(trimmed);
    if (entries.length >= EDITOR_HISTORY_LIMIT) break;
  }
  return entries;
}

export function snapshotEditorHistory(editor: EditorWithHistory | null | undefined): void {
  const history = readEditorHistory(editor);
  if (history.length > 0) {
    getEditorHistoryState().savedEntries = history;
  }
}

export function restoreEditorHistory(editor: EditorWithHistory | null | undefined): void {
  const { savedEntries } = getEditorHistoryState();
  if (!savedEntries.length || typeof editor?.addToHistory !== "function") return;

  for (let i = savedEntries.length - 1; i >= 0; i--) {
    editor.addToHistory(savedEntries[i]);
  }
}

export function trackEditorHistory(editor: EditorWithHistory | null | undefined): void {
  if (!editor || typeof editor.addToHistory !== "function") return;
  if (Reflect.get(editor, EDITOR_HISTORY_TRACKED)) {
    snapshotEditorHistory(editor);
    return;
  }

  const originalAddToHistory = editor.addToHistory.bind(editor);
  editor.addToHistory = (text: string) => {
    originalAddToHistory(text);
    snapshotEditorHistory(editor);
  };
  Reflect.set(editor, EDITOR_HISTORY_TRACKED, true);
  snapshotEditorHistory(editor);
}

export function clearEditorHistorySnapshot(): void {
  getEditorHistoryState().savedEntries = [];
}
