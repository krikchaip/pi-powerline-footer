import { writeFileSync } from "node:fs";

export default function (pi: any): void {
  pi.on("input", (event: any) => {
    writeFileSync(process.env.CLICK_RESULT_PATH, event.text);
    return { action: "handled" };
  });
}
