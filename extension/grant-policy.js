export const DEFAULT_GRANT_MINUTES = 15;
export const MIN_GRANT_MINUTES = 1;
export const MAX_GRANT_MINUTES = 480;

export function normalizeGrantMinutes(value) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < MIN_GRANT_MINUTES || minutes > MAX_GRANT_MINUTES) {
    return DEFAULT_GRANT_MINUTES;
  }
  return minutes;
}
