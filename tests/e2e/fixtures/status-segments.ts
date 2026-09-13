import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function statusSegmentsFixture(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("e2e-red", "\x1b[31mRED\x1b[0m");
    ctx.ui.setStatus("e2e-green", "\x1b[32mGREEN\x1b[0m");
    ctx.ui.setStatus("e2e-secondary", "SECONDARY-E2E");
  });
}
