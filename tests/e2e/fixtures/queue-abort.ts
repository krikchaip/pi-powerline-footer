import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const expectedPrompt = process.env.QUEUE_E2E_EXPECTED_PROMPT;
const beforeAgentPath = process.env.QUEUE_E2E_BEFORE_AGENT_PATH;
const beforeProviderPath = process.env.QUEUE_E2E_BEFORE_PROVIDER_PATH;
const configuredAbortDelay = Number(process.env.QUEUE_E2E_ABORT_DELAY_MS ?? "250");
const abortDelayMs = Number.isFinite(configuredAbortDelay) && configuredAbortDelay >= 0
  ? configuredAbortDelay
  : 250;
const blockBeforeProvider = process.env.QUEUE_E2E_BLOCK_BEFORE_PROVIDER === "1";

function writeMarker(path: string | undefined, value: string): void {
  if (path) writeFileSync(path, value, "utf8");
}

export default function queueAbortFixture(pi: ExtensionAPI): void {
  pi.registerProvider("e2e-abort", {
    name: "E2E abort provider",
    baseUrl: "http://127.0.0.1:9",
    apiKey: "e2e-do-not-use",
    api: "openai-completions",
    models: [{
      id: "queue-fixture",
      name: "Queue Fixture",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 256,
    }],
  });

  pi.on("before_agent_start", async (event) => {
    if (!expectedPrompt || event.prompt !== expectedPrompt) return;
    writeMarker(beforeAgentPath, event.prompt);

    // Powerline runs first. Give its queue acknowledgement time to render, then
    // stop this isolated Pi process before it can open a provider stream.
    if (blockBeforeProvider) {
      setTimeout(() => process.exit(86), abortDelayMs);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, abortDelayMs));
    process.exit(86);
  });

  pi.on("before_provider_request", async (event) => {
    writeMarker(beforeProviderPath, blockBeforeProvider
      ? "blocked-before-stream"
      : JSON.stringify(event.payload));
    if (blockBeforeProvider) {
      await new Promise<void>(() => {});
    }
  });
}
