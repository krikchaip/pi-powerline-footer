import { maxEffortWave } from "./theme.ts";

export interface ThinkingWaveLayout {
  topContent: string;
  secondaryContent: string;
  secondaryLines?: string[];
}

/**
 * Updates only the ANSI colors of cached max-thinking segments.
 *
 * The layout stays cached, so this is safe to call on every animation frame,
 * including while the editor is handling input.
 */
export function refreshMaxThinkingWave<T extends ThinkingWaveLayout>(
  layout: T,
  cachedFrame: number | null,
  currentFrame: number,
): T {
  if (cachedFrame === null || cachedFrame === currentFrame) return layout;

  const replaceWave = (content: string) => {
    for (const text of ["think:max", "max", "(max)", "[max]"]) {
      content = content.replaceAll(
        maxEffortWave(text, cachedFrame),
        maxEffortWave(text, currentFrame),
      );
    }
    return content;
  };

  return {
    ...layout,
    topContent: replaceWave(layout.topContent),
    secondaryContent: replaceWave(layout.secondaryContent),
    ...(layout.secondaryLines
      ? { secondaryLines: layout.secondaryLines.map(replaceWave) }
      : {}),
  };
}
