import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  getPowerlineArgumentCompletions,
  getQueueArgumentCompletions,
  getVibeArgumentCompletions,
  type CommandCompletionContext,
} from "../command-completions.ts";
import { PowerlineQueueStore } from "../queue/store.ts";

function values(items: ReturnType<typeof getQueueArgumentCompletions>): string[] {
  return items?.map((item) => item.value) ?? [];
}

function withContext(run: (context: CommandCompletionContext) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "powerline-command-completions-"));
  const store = new PowerlineQueueStore(join(dir, "inbox.jsonl"), join(dir, "projects.json"));
  const cwd = join(dir, "project");
  const context: CommandCompletionContext = {
    cwd,
    sessionId: "session-1",
    queueStore: store,
    getModelSpecs: () => ["anthropic/claude-sonnet", "openai/gpt-5.4-mini"],
    getVibeThemes: () => ["star trek", "pirate"],
  };

  try {
    store.setAlias("docs", join(dir, "docs"));
    store.add({
      text: "send deployment notes",
      source: { cwd, sessionId: "session-1" },
      target: { kind: "current-session" },
      intent: "follow-up",
      now: 2,
    });
    run(context);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("queue completes actions, active queue ids, aliases, targets, and alias paths", () => withContext((context) => {
  const queueItem = context.queueStore.activeItems({ cwd: context.cwd, sessionId: context.sessionId })[0];
  assert.ok(queueItem);

  assert.deepEqual(values(getQueueArgumentCompletions("", context)), ["alias ", "send ", "retry ", "clear ", "target "]);
  assert.deepEqual(values(getQueueArgumentCompletions("send ", context)), [`send ${queueItem.id}`]);
  assert.deepEqual(values(getQueueArgumentCompletions("clear ", context)), ["clear all", `clear ${queueItem.id}`]);
  assert.deepEqual(values(getQueueArgumentCompletions("target ", context)), [`target ${queueItem.id} `]);
  assert.deepEqual(values(getQueueArgumentCompletions(`target ${queueItem.id} @d`, context)), [`target ${queueItem.id} @docs`]);
  assert.deepEqual(values(getQueueArgumentCompletions("alias docs ", context)), ["alias docs ../", "alias docs ~/"]);
}));

test("powerline and vibe complete every fixed argument and live values", () => withContext((context) => {
  assert.deepEqual(values(getPowerlineArgumentCompletions("placement ", context)), [
    "placement above",
    "placement below",
    "placement toggle",
  ]);
  assert.ok(values(getPowerlineArgumentCompletions("", context)).includes("default"));

  assert.deepEqual(values(getVibeArgumentCompletions("mode ", context)), ["mode generate", "mode file"]);
  assert.deepEqual(values(getVibeArgumentCompletions("model open", context)), ["model openai/gpt-5.4-mini"]);
  assert.deepEqual(values(getVibeArgumentCompletions("generate star", context)), ["generate star trek"]);
  assert.deepEqual(values(getVibeArgumentCompletions("star", context)), ["star trek"]);
}));
