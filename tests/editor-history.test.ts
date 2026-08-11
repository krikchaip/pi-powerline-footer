import test from "node:test";
import assert from "node:assert/strict";
import {
  clearEditorHistorySnapshot,
  restoreEditorHistory,
  snapshotEditorHistory,
  trackEditorHistory,
} from "../editor-history.ts";

function createEditor(history: string[] = []) {
  return {
    history,
    addToHistory(text: string) {
      this.history.unshift(text);
    },
  };
}

test("native editor history survives Powerline editor reconstruction", () => {
  clearEditorHistorySnapshot();
  const previousEditor = createEditor(["second prompt", "first prompt"]);
  snapshotEditorHistory(previousEditor);

  const replacementEditor = createEditor();
  restoreEditorHistory(replacementEditor);

  assert.deepEqual(replacementEditor.history, ["second prompt", "first prompt"]);
});

test("tracked editor history updates the reconstruction snapshot", () => {
  clearEditorHistorySnapshot();
  const previousEditor = createEditor();
  trackEditorHistory(previousEditor);
  previousEditor.addToHistory("new prompt");

  const replacementEditor = createEditor();
  restoreEditorHistory(replacementEditor);

  assert.deepEqual(replacementEditor.history, ["new prompt"]);
});
