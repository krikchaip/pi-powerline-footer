import { fileURLToPath } from "node:url";
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { matchesConfiguredShortcut } from "./shortcuts.ts";

interface EditorBoundaryShortcuts {
  start: string | null;
  end: string | null;
}

interface PowerlineEditorOptions {
  editorBoundaryShortcuts?: EditorBoundaryShortcuts;
}

const DEFAULT_EDITOR_BOUNDARY_SHORTCUTS: EditorBoundaryShortcuts = {
  start: "super+shift+up",
  end: "super+shift+down",
};

function isCommandUndoShortcut(data: string): boolean {
  return data === "\x1b[122;9u"
    || data === "\x1b[122;9:1u"
    || data === "\x1b[122;9:2u"
    || data === "\x1b[27;9;122~";
}

function bracketedPasteContent(data: string): string | null {
  const startMarker = "\x1b[200~";
  const endMarker = "\x1b[201~";
  const start = data.indexOf(startMarker);
  if (start !== 0) return null;

  const end = data.indexOf(endMarker, startMarker.length);
  if (end === -1 || end + endMarker.length !== data.length) return null;

  return data.slice(startMarker.length, end);
}

function decodeFileUriList(text: string): string | null {
  const entries = text
    .split(/\r?\n|\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("#"));

  if (entries.length === 0 || entries.some((entry) => !entry.startsWith("file://"))) {
    return null;
  }

  try {
    return entries.map((entry) => fileURLToPath(entry)).join(" ");
  } catch {
    return null;
  }
}

function droppedPathTextFromInput(data: string): string | null {
  const pasteContent = bracketedPasteContent(data);
  const text = pasteContent ?? data;
  const uriList = decodeFileUriList(text);
  if (uriList) return uriList;

  const trimmed = text.replace(/^[\r\n]+|[\r\n]+$/g, "");
  if (trimmed.length <= 1 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(trimmed)) {
    return null;
  }

  if (/^(?:\/|~\/|\.\.?\/)/.test(trimmed) && !/[\r\n]/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

export class PowerlineEditor extends CustomEditor {
  private readonly keybindingsRef: KeybindingsManager;
  private readonly optionsRef: PowerlineEditorOptions;
  private wrappedProviderInstalled = false;
  private promptHistoryDraft: string | null = null;
  private mouseContentOffset = 2;

  constructor(tui: any, theme: any, keybindings: KeybindingsManager, options: PowerlineEditorOptions) {
    super(tui, theme, keybindings);
    this.keybindingsRef = keybindings;
    this.optionsRef = options;
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    super.setAutocompleteProvider(provider);
    this.wrappedProviderInstalled = false;
  }

  installAutocompleteProvider(provider: AutocompleteProvider): void {
    this.setAutocompleteProvider(provider);
    this.wrappedProviderInstalled = true;
  }

  hasWrappedProvider(): boolean {
    return this.wrappedProviderInstalled;
  }

  handleMouse(event: any): any {
    const inheritedHandleMouse = Reflect.get(
      Object.getPrototypeOf(PowerlineEditor.prototype),
      "handleMouse",
    );
    if (typeof inheritedHandleMouse !== "function") return undefined;

    const renderedVisibleLineCount = Reflect.get(this, "renderedVisibleLineCount");
    const isEditorContent = Number.isInteger(renderedVisibleLineCount)
      && event.y > 0
      && event.y <= renderedVisibleLineCount;
    const adjustedEvent = isEditorContent
      ? { ...event, x: Math.max(0, event.x - this.mouseContentOffset) }
      : event;

    return inheritedHandleMouse.call(this, adjustedEvent);
  }

  handleInput(data: string): void {
    const droppedPathText = droppedPathTextFromInput(data);
    if (droppedPathText !== null) {
      this.insertTextAtCursor(droppedPathText);
      return;
    }

    const pasteInProgress = data.includes("\x1b[200~") || Reflect.get(this, "isInPaste") === true;
    if (pasteInProgress) {
      super.handleInput(data);
      if (Reflect.get(this, "isInPaste") === true) return;
    } else {
      if (isCommandUndoShortcut(data)) {
        const undo = Reflect.get(this, "undo");
        if (typeof undo === "function") undo.call(this);
        return;
      }

      const editorBoundaryShortcuts = this.optionsRef.editorBoundaryShortcuts ?? DEFAULT_EDITOR_BOUNDARY_SHORTCUTS;
      if (!isKeyRelease(data) && matchesConfiguredShortcut(data, editorBoundaryShortcuts.start)) {
        this.moveCursorToEditorBoundary("start");
        return;
      }

      if (!isKeyRelease(data) && matchesConfiguredShortcut(data, editorBoundaryShortcuts.end)) {
        this.moveCursorToEditorBoundary("end");
        return;
      }

      if (matchesKey(data, "up") && this.isPromptHistoryRecallPosition()) {
        const navigateHistory = Reflect.get(this, "navigateHistory");
        if (typeof navigateHistory === "function") {
          if (Reflect.get(this, "historyIndex") === -1) this.promptHistoryDraft = this.getText();
          navigateHistory.call(this, -1);
          return;
        }
      }

      if (matchesKey(data, "down") && Reflect.get(this, "historyIndex") > -1) {
        const isOnLastVisualLine = Reflect.get(this, "isOnLastVisualLine");
        if (typeof isOnLastVisualLine !== "function" || isOnLastVisualLine.call(this)) {
          const navigateHistory = Reflect.get(this, "navigateHistory");
          if (typeof navigateHistory === "function") {
            navigateHistory.call(this, 1);
            if (Reflect.get(this, "historyIndex") === -1 && this.promptHistoryDraft !== null) {
              const draft = this.promptHistoryDraft;
              this.promptHistoryDraft = null;
              const setTextInternal = Reflect.get(this, "setTextInternal");
              if (typeof setTextInternal === "function") setTextInternal.call(this, draft);
              else this.setText(draft);
            }
            return;
          }
        }
      }

      super.handleInput(data);
    }
  }

  private moveCursorToEditorBoundary(position: "start" | "end"): void {
    const state = Reflect.get(this, "state");
    const lines = state && typeof state === "object" ? Reflect.get(state, "lines") : null;
    if (!Array.isArray(lines)) throw new Error("Editor cursor state is unavailable");

    if (position === "start") {
      Reflect.set(state, "cursorLine", 0);
      Reflect.set(state, "cursorCol", 0);
    } else {
      const lastLine = Math.max(0, lines.length - 1);
      Reflect.set(state, "cursorLine", lastLine);
      Reflect.set(state, "cursorCol", typeof lines[lastLine] === "string" ? lines[lastLine].length : 0);
    }

    Reflect.set(this, "lastAction", null);
    Reflect.set(this, "preferredVisualCol", null);
    Reflect.set(this, "snappedFromCursorCol", null);
    this.tui.requestRender();
  }

  private isPromptHistoryRecallPosition(): boolean {
    if (this.isShowingAutocomplete()) return false;

    const history = Reflect.get(this, "history");
    if (!Array.isArray(history) || history.length === 0) return false;

    const lines = this.getLines();
    const cursor = this.getCursor();
    if (lines.length === 1) return cursor.line === 0 && cursor.col === (lines[0]?.length ?? 0);

    const isOnFirstVisualLine = Reflect.get(this, "isOnFirstVisualLine");
    if (typeof isOnFirstVisualLine === "function" && !isOnFirstVisualLine.call(this)) return false;

    return cursor.line === 0;
  }
}
