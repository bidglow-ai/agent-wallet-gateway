// Local development choices, not evidence of provider acceptance.
// Selecting a default never renews a delegation or resets a mandate budget.
export const DELEGATION_DURATION_HOURS: readonly number[] = Object.freeze([1, 4, 24, 720, 2160]);
export const DEFAULT_DURATION_MS = 2592000000;
export const MAX_DELEGATION_MS = 7776000000;
const DURATION_MS: readonly number[] = Object.freeze(DELEGATION_DURATION_HOURS.map(hours => hours * 3600000));
export function isAllowedDurationMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && DURATION_MS.includes(value);
}
