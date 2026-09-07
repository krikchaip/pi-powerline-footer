import test from "node:test";
import assert from "node:assert/strict";
import { PowerlineEditor } from "../editor.ts";

test("editor click hit-testing removes the Powerline prompt prefix", () => {
  const basePrototype = Object.getPrototypeOf(PowerlineEditor.prototype) as Record<string, unknown>;
  const originalHandleMouse = basePrototype.handleMouse;
  let receivedEvent: Record<string, unknown> | undefined;

  basePrototype.handleMouse = function handleMouse(event: Record<string, unknown>) {
    receivedEvent = event;
    return { handled: true, focus: true };
  };

  try {
    const editor = Object.create(PowerlineEditor.prototype) as PowerlineEditor;
    Reflect.set(editor, "mouseContentOffset", 2);
    Reflect.set(editor, "renderedVisibleLineCount", 1);

    const result = (editor as any).handleMouse({
      type: "click",
      button: "left",
      x: 4,
      y: 1,
      screenX: 4,
      screenY: 22,
      width: 80,
      height: 3,
      shift: false,
      alt: false,
      ctrl: false,
    });

    assert.deepEqual(result, { handled: true, focus: true });
    assert.equal(receivedEvent?.x, 2);
    assert.equal(receivedEvent?.screenX, 4);
  } finally {
    if (originalHandleMouse === undefined) delete basePrototype.handleMouse;
    else basePrototype.handleMouse = originalHandleMouse;
  }
});

test("autocomplete click hit-testing keeps its unprefixed column", () => {
  const basePrototype = Object.getPrototypeOf(PowerlineEditor.prototype) as Record<string, unknown>;
  const originalHandleMouse = basePrototype.handleMouse;
  let receivedEvent: Record<string, unknown> | undefined;

  basePrototype.handleMouse = function handleMouse(event: Record<string, unknown>) {
    receivedEvent = event;
    return { handled: true };
  };

  try {
    const editor = Object.create(PowerlineEditor.prototype) as PowerlineEditor;
    Reflect.set(editor, "mouseContentOffset", 2);
    Reflect.set(editor, "renderedVisibleLineCount", 1);

    (editor as any).handleMouse({
      type: "click",
      button: "left",
      x: 4,
      y: 3,
      screenX: 4,
      screenY: 24,
      width: 80,
      height: 6,
      shift: false,
      alt: false,
      ctrl: false,
    });

    assert.equal(receivedEvent?.x, 4);
  } finally {
    if (originalHandleMouse === undefined) delete basePrototype.handleMouse;
    else basePrototype.handleMouse = originalHandleMouse;
  }
});
