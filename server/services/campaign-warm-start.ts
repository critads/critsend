export const WARM_START_WINDOW_DAYS = 30;
export const WARM_START_MAX_RECIPIENTS = 50_000;

/** Pure cap rule, exported so boundary/cap behavior can be tested directly. */
export function calculateWarmStartCap(eligibleCount: number, clickerCount: number): number {
  const eligible = Math.max(0, Math.floor(eligibleCount));
  const clickers = Math.max(0, Math.floor(clickerCount));
  return Math.min(clickers, Math.floor(eligible * 0.30), WARM_START_MAX_RECIPIENTS);
}