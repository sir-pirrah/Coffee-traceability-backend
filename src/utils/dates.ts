/**
 * Calendar-day helpers for comparing date-only form input against stored
 * timestamps.
 *
 * `<input type="date">` submits "2026-08-07", which parses to UTC midnight,
 * while a stored `createdAt` carries a real time of day. Comparing those two as
 * instants would reject a processing run recorded on the same day the batch was
 * registered — the most common case there is. Comparing whole UTC days instead
 * only rejects a date that is genuinely earlier.
 */

/** Midnight-UTC timestamp for the calendar day a date falls on. */
export function utcDayIndex(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** True when `date` lands on an earlier calendar day than `reference`. */
export function isBeforeDay(date: Date, reference: Date): boolean {
  return utcDayIndex(date) < utcDayIndex(reference);
}

/** `YYYY-MM-DD`, matching what a date input expects for its `min`/`value`. */
export function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}
