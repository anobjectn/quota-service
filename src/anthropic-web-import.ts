// Normalizer for the intentionally small, user-editable Claude Web credit
// import shape (POST /anthropic-web-import). Extracted from server.ts so it can
// be unit-tested without booting the HTTP server / poll loop. This path never
// accepts browser cookies or account-session credentials — only the handful of
// values a user copies out of Claude Settings → Usage.

import { parseInstant } from "./lib/time";

export function optionalNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${field} must be a non-negative number`);
  return parsed;
}

/** Parse an optional instant, throwing a field-specific error when a value is
 * present but unparseable. Accepts epoch ms or any `Date.parse`-able string
 * (including date-only `YYYY-MM-DD`, which resolves to UTC-midnight). */
export function optionalTimestamp(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = parseInstant(value);
  if (parsed === null) throw new Error(`${field} must be a valid date`);
  return parsed;
}

export function normalizeAnthropicWebImport(body: Record<string, unknown>): Record<string, unknown> {
  const promoRemaining = optionalNumber(body.promoRemaining, "promoRemaining");
  const promoGranted = optionalNumber(body.promoGranted, "promoGranted");
  const promoExpiresAt = optionalTimestamp(body.promoExpiresAt, "promoExpiresAt");
  const campaignId = typeof body.campaignId === "string" && body.campaignId.trim()
    ? body.campaignId.trim()
    : null;
  return {
    schemaVersion: 1,
    capturedAt: optionalTimestamp(body.capturedAt, "capturedAt") ?? Date.now(),
    currentBalance: optionalNumber(body.currentBalance, "currentBalance"),
    balanceCredits: optionalNumber(body.balanceCredits, "balanceCredits"),
    currency: typeof body.currency === "string" && body.currency.trim() ? body.currency.trim().toUpperCase() : "USD",
    autoReloadEnabled: typeof body.autoReloadEnabled === "boolean" ? body.autoReloadEnabled : null,
    nextExpiresAt: optionalTimestamp(body.nextExpiresAt, "nextExpiresAt") ?? promoExpiresAt,
    promotionalTranches: promoRemaining === null
      ? []
      : [{ remainingAmount: promoRemaining, grantedAmount: promoGranted, expiresAt: promoExpiresAt }],
    campaign: campaignId
      ? {
          id: campaignId,
          granted: typeof body.campaignGranted === "boolean" ? body.campaignGranted : null,
          amount: optionalNumber(body.campaignAmount, "campaignAmount") ?? promoGranted,
          expiresAt: optionalTimestamp(body.campaignExpiresAt, "campaignExpiresAt") ?? promoExpiresAt,
        }
      : null,
    purchases: {
      purchasedThisMonthAmount: optionalNumber(body.purchasedThisMonthAmount, "purchasedThisMonthAmount"),
      monthlyCapAmount: optionalNumber(body.monthlyCapAmount, "monthlyCapAmount"),
      resetsAt: optionalTimestamp(body.purchasesResetAt, "purchasesResetAt"),
      maxDiscountPercent: optionalNumber(body.maxDiscountPercent, "maxDiscountPercent"),
    },
  };
}
