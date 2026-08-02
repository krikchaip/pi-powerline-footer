import { maxEffortWave } from "./theme.ts";

export interface ThinkingWaveLayout {
  topContent: string;
  secondaryContent: string;
}

/**
 * Updates only the ANSI colors of a cached think:max segment.
 *
 * The layout stays cached, so this is safe to call on every animation frame,
 * including while the editor is handling input.
 */
export function refreshMaxThinkingWave(
  layout: ThinkingWaveLayout,
  cachedFrame: number | null,
  currentFrame: number,
): ThinkingWaveLayout {
  if (cachedFrame === null || cachedFrame === currentFrame) return layout;

  const cachedWave = maxEffortWave("think:max", cachedFrame);
  const currentWave = maxEffortWave("think:max", currentFrame);
  const replaceWave = (content: string) => content.replaceAll(cachedWave, currentWave);

  return {
    topContent: replaceWave(layout.topContent),
    secondaryContent: replaceWave(layout.secondaryContent),
  };
}
