import { maxEffortWave } from "./theme.ts";

export interface ThinkingWaveLayout {
  topContent: string;
  secondaryContent: string;
  secondaryLines?: string[];
}

/**
 * Updates only the ANSI colors of a cached think:max segment.
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

  const cachedWave = maxEffortWave("think:max", cachedFrame);
  const currentWave = maxEffortWave("think:max", currentFrame);
  const replaceWave = (content: string) => content.replaceAll(cachedWave, currentWave);

  return {
    ...layout,
    topContent: replaceWave(layout.topContent),
    secondaryContent: replaceWave(layout.secondaryContent),
    ...(layout.secondaryLines
      ? { secondaryLines: layout.secondaryLines.map(replaceWave) }
      : {}),
  };
}
