// Shared, NaN-safe time helpers. The service's contract is: store and transmit
// time in universal units (epoch ms for true instants, ISO YYYY-MM-DD for
// date-only values) and leave all localization to the CLI/UI. These helpers
// guarantee a malformed provider/import value degrades to `null` rather than
// silently serializing as `NaN` -> `null` deep inside `JSON.stringify`.

/** Finite epoch-ms from a number (finite passthrough) or a string (`Date.parse`,
 * then a finite check), else `null`. Any non-finite result (empty string,
 * garbage, `NaN`, `Infinity`) becomes `null`. */
export function parseInstant(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A finite number or `null`. Rejects `NaN`/`Infinity` and non-number input. */
export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `YYYY-MM-DD` (UTC) for an epoch-ms instant, or `null`. This is the canonical
 * calendar-date representation for genuinely date-only values (e.g. Claude Web
 * credit expiries) — consumers should render it verbatim and must not reapply a
 * local timezone. */
export function toUtcDateString(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}
