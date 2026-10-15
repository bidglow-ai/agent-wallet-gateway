// Local development policy, NOT a claim that Coinbase accepts these durations.
// Longer account delegation never renews an existing mandate or its budget.
export const DELEGATION_DURATION_HOURS=Object.freeze([1,4,24,720,2160]);
export const DEFAULT_DURATION_MS=2592000000;
export const MAX_DELEGATION_MS=7776000000;
const DURATION_MS=Object.freeze(DELEGATION_DURATION_HOURS.map(hours=>hours*3600000));
export function isAllowedDurationMs(value){
  return Number.isSafeInteger(value)&&DURATION_MS.includes(value);
}
export function isBoundedDelegationExpiry(expiresAt,now=Date.now()){
  return Number.isSafeInteger(now)&&now>0&&Number.isSafeInteger(expiresAt)&&
    expiresAt>now&&expiresAt-now<=MAX_DELEGATION_MS;
}
