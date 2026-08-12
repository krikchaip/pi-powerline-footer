import type { AutocompleteItem } from "@earendil-works/pi-tui";

import { getCdArgumentCompletions } from "./cd-command.ts";
import { currentQueueContext, type PowerlineQueueStore } from "./queue/store.ts";
import type { PowerlineQueueItem } from "./queue/types.ts";

export interface CommandCompletionContext {
  cwd: string;
  sessionId?: string;
  queueStore: PowerlineQueueStore;
  getModelSpecs?: () => readonly string[];
  getVibeThemes?: () => readonly string[];
}

type Completion = {
  value: string;
  label?: string;
  description?: string;
};

function complete(prefix: string, completions: readonly Completion[]): AutocompleteItem[] | null {
  const normalizedPrefix = prefix.trimStart().toLowerCase();
  const seen = new Set<string>();
  const matches = completions.filter((completion) => {
    if (seen.has(completion.value)) return false;
    seen.add(completion.value);
    return completion.value.toLowerCase().startsWith(normalizedPrefix);
  });

  return matches.length > 0
    ? matches.map(({ value, label = value, description }) => ({ value, label, description }))
    : null;
}

function actionAndRemainder(prefix: string): { action: string; remainder: string; hasSeparator: boolean } {
  const input = prefix.trimStart();
  const separator = input.search(/\s/);
  if (separator < 0) return { action: input.toLowerCase(), remainder: "", hasSeparator: false };

  return {
    action: input.slice(0, separator).toLowerCase(),
    remainder: input.slice(separator).trimStart(),
    hasSeparator: true,
  };
}

function activeItems(context: CommandCompletionContext, intent?: PowerlineQueueItem["intent"]): PowerlineQueueItem[] {
  return context.queueStore.activeItems(currentQueueContext(context.cwd, context.sessionId))
    .filter((item) => intent === undefined || item.intent === intent);
}

function itemDescription(item: PowerlineQueueItem): string {
  const compactText = item.text.replace(/\s+/g, " ").trim();
  const preview = compactText.length > 50 ? `${compactText.slice(0, 49)}…` : compactText;
  return `${item.intent} · ${item.status} · ${preview}`;
}

function itemCompletions(action: string, idPrefix: string, items: readonly PowerlineQueueItem[]): AutocompleteItem[] | null {
  return complete("", items.map((item) => ({
    value: `${action} ${item.id}`,
    label: `${action} ${item.id}`,
    description: itemDescription(item),
  })).filter((item) => item.value.slice(action.length + 1).toLowerCase().startsWith(idPrefix.toLowerCase())));
}

function aliases(context: CommandCompletionContext): string[] {
  return Object.keys(context.queueStore.readAliases()).sort((a, b) => a.localeCompare(b));
}

export function getQueueArgumentCompletions(prefix: string, context: CommandCompletionContext): AutocompleteItem[] | null {
  const { action, remainder, hasSeparator } = actionAndRemainder(prefix);
  const queueItems = activeItems(context);

  if (!hasSeparator) {
    return complete(prefix, [
      { value: "alias ", description: "Save a project alias" },
      { value: "send ", description: "Send a queued prompt" },
      { value: "retry ", description: "Retry a queued prompt" },
      { value: "clear ", description: "Clear queued prompts" },
      { value: "target ", description: "Change a queued prompt target" },
    ]);
  }

  if (["send", "retry"].includes(action) && !/\s/.test(remainder)) {
    return itemCompletions(action, remainder, queueItems);
  }

  if (action === "clear" && !/\s/.test(remainder)) {
    return complete("", [
      { value: "clear all", description: "Clear all queued prompts" },
      ...queueItems.map((item) => ({ value: `clear ${item.id}`, description: itemDescription(item) })),
    ].filter((item) => item.value.slice("clear ".length).toLowerCase().startsWith(remainder.toLowerCase())));
  }

  if (action === "target") {
    const [id, ...targetParts] = remainder.split(/\s+/).filter(Boolean);
    if (!id) {
      return complete("", queueItems.map((item) => ({
        value: `target ${item.id} `,
        description: itemDescription(item),
      })).filter((item) => item.value.slice("target ".length).toLowerCase().startsWith(remainder.toLowerCase())));
    }

    const targetPrefix = targetParts.join(" ");
    if (targetParts.length <= 1) {
      return complete("", [
        { value: `target ${id} current`, description: "Current session" },
        { value: `target ${id} global`, description: "All projects" },
        ...aliases(context).map((alias) => ({ value: `target ${id} @${alias}`, description: "Saved project alias" })),
      ].filter((item) => item.value.slice(`target ${id} `.length).toLowerCase().startsWith(targetPrefix.toLowerCase())));
    }
    return null;
  }

  if (action === "alias") {
    const aliasSeparator = remainder.search(/\s/);
    if (aliasSeparator < 0) return null;

    const alias = remainder.slice(0, aliasSeparator);
    const pathPrefix = remainder.slice(aliasSeparator).trimStart();
    return getCdArgumentCompletions(pathPrefix, context.cwd).map((item) => ({
      value: `alias ${alias} ${item.value}`,
      label: `alias ${alias} ${item.label}`,
      description: item.description,
    }));
  }

  return null;
}

export function getPowerlineArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const { action, hasSeparator } = actionAndRemainder(prefix);
  const presets = ["default", "minimal", "compact", "full", "nerd", "ascii"];

  if (!hasSeparator) {
    return complete(prefix, [
      { value: "placement ", description: "Move the primary row" },
      ...presets.map((value) => ({ value, description: "Use this footer preset" })),
    ]);
  }

  if (action === "placement") {
    return complete(prefix, [
      { value: "placement above", description: "Place the row above the editor" },
      { value: "placement below", description: "Place the row below the editor" },
      { value: "placement toggle", description: "Switch the row placement" },
    ]);
  }

  return null;
}

export function getVibeArgumentCompletions(prefix: string, context: CommandCompletionContext): AutocompleteItem[] | null {
  const { action, remainder, hasSeparator } = actionAndRemainder(prefix);
  const themes = context.getVibeThemes?.() ?? [];

  if (!hasSeparator) {
    return complete(prefix, [
      { value: "off", description: "Disable themed working messages" },
      { value: "mode ", description: "Set generate or file mode" },
      { value: "model ", description: "Set the vibe model" },
      { value: "generate ", description: "Generate a saved vibe file" },
      ...themes.map((value) => ({ value, description: "Use this saved vibe theme" })),
    ]);
  }

  if (action === "mode" && !/\s/.test(remainder)) {
    return complete("", [
      { value: "mode generate", description: "Generate working messages on demand" },
      { value: "mode file", description: "Read working messages from a saved file" },
    ].filter((item) => item.value.slice("mode ".length).startsWith(remainder)));
  }

  if (action === "model" && !/\s/.test(remainder)) {
    return complete("", (context.getModelSpecs?.() ?? []).map((model) => ({
      value: `model ${model}`,
      description: "Use this model for vibe generation",
    })).filter((item) => item.value.slice("model ".length).toLowerCase().startsWith(remainder.toLowerCase())));
  }

  if (action === "generate") {
    const normalizedTheme = remainder.trim();
    if (themes.includes(normalizedTheme) && /\s$/.test(prefix)) {
      return complete("", [50, 100, 200, 500].map((count) => ({
        value: `generate ${normalizedTheme} ${count}`,
        description: `Generate ${count} saved vibes`,
      })));
    }
    if (!/\s/.test(remainder)) {
      return complete("", themes.map((theme) => ({
        value: `generate ${theme}`,
        description: "Generate vibes for this saved theme",
      })).filter((item) => item.value.slice("generate ".length).toLowerCase().startsWith(remainder.toLowerCase())));
    }
  }

  return null;
}
