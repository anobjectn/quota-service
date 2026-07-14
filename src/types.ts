// Shared types for the quota service.
//
// Two quota shapes exist across providers and must both be modeled cleanly:
//  - "window": a rolling time window that resets on a clock (Codex 5h/weekly,
//    Anthropic 5h/weekly). Expressed as a used percent + a reset timestamp.
//  - "pool": a fixed allotment that refreshes on a billing-cycle date (Warp's
//    monthly request pool). Expressed as used/limit counts + a refresh date.
//
// Every collector result carries an explicit status so stale/unavailable
// data is never silently presented as fresh.

export type CollectorStatus = "ok" | "stale" | "unavailable";

export type Provider = "codex" | "anthropic" | "warp";

export interface WindowQuota {
  /** 0-100 */
  usedPercent: number;
  /** unix ms epoch, or null if unknown */
  resetsAt: number | null;
}

/** Usage-credits balance (Anthropic's "Usage credits" add-on, and analogous
 * per-provider spend-based fallback balances). First-class, not a raw blob,
 * so presenters don't need to know the provider's wire shape. */
export interface UsageCredits {
  enabled: boolean;
  /** major currency units, e.g. dollars (already divided by the wire exponent) */
  spentAmount: number;
  limitAmount: number | null;
  currency: string;
  /** unix ms epoch, or null if the provider doesn't report a reset date */
  resetsAt: number | null;
}

export interface WindowSnapshot {
  kind: "window";
  fiveHour: WindowQuota | null;
  weekly: WindowQuota | null;
  /** Per-model weekly (or other) buckets keyed by whatever name the provider
   * reports (e.g. "Fable"). Generic by design — a provider may surface zero,
   * one, or several of these, and they can appear/disappear over time (e.g.
   * Anthropic's temporary Fable bucket) without any schema change. */
  modelWindows?: Record<string, WindowQuota>;
  /** Usage-credits / spend-based fallback balance, when the provider reports one. */
  usageCredits?: UsageCredits | null;
  /** provider-specific extras (plan type, raw per-model debug fields, etc.) */
  extra?: Record<string, unknown>;
}

export interface PoolQuota {
  used: number;
  limit: number;
  /** 0-100, derived if not provided directly */
  usedPercent: number;
  /** unix ms epoch of the next refresh, or null if unknown */
  refreshesAt: number | null;
  /** human label for the refresh cadence, e.g. "Monthly" */
  cadence?: string;
}

export interface PoolSnapshot {
  kind: "pool";
  pool: PoolQuota;
  extra?: Record<string, unknown>;
}

export type QuotaSnapshot = WindowSnapshot | PoolSnapshot;

export interface CollectorResult {
  provider: Provider;
  status: CollectorStatus;
  /** which tactic produced this result, e.g. "codex_file", "codex_api", "anthropic_api", "warp_plist" */
  source: string;
  /** unix ms epoch marking how old the underlying data is (event timestamp, file mtime, or fetch time for a live call) */
  dataAsOf: number | null;
  /** unix ms epoch when the collector ran */
  capturedAt: number;
  snapshot: QuotaSnapshot | null;
  /** present when status is "stale" or "unavailable" */
  error?: string;
}

/** Codex banked reset credits (rate-limit-reset-credits) — report only, never consumed. */
export interface ResetCredit {
  id: string;
  resetType: string | null;
  status: string | null;
  grantedAt: string | null;
  expiresAt: string | null;
  title: string | null;
  description: string | null;
}

export interface ResetCreditsResult {
  provider: Provider;
  status: CollectorStatus;
  capturedAt: number;
  availableCount: number | null;
  totalEarnedCount: number | null;
  credits: ResetCredit[];
  error?: string;
}

export interface ManualEntry {
  provider: Provider;
  field: string;
  value: string;
  note: string | null;
  updatedAt: number;
}
