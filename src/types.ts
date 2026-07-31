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
  /** Percentage of the window consumed, on a 0–100 scale (NOT a 0–1 fraction).
   * A future provider change that starts emitting a fraction would surface here
   * as an obviously-wrong dial rather than a silent 100x error. Guaranteed
   * finite: a non-finite provider value causes the window to be omitted/null
   * upstream rather than propagating `NaN`. */
  usedPercent: number;
  /** unix ms epoch, or null if unknown */
  resetsAt: number | null;
}

/** Usage-credits balance (Anthropic's "Usage credits" add-on, and analogous
 * per-provider spend-based fallback balances). First-class, not a raw blob,
 * so presenters don't need to know the provider's wire shape. */
export interface UsageCredits {
  enabled: boolean;
  /** Major currency units, e.g. dollars (already divided by the wire exponent).
   * Every monetary amount across this contract is in major units — never
   * re-divide by an exponent. */
  spentAmount: number;
  /** Major currency units (dollars), or null if the provider reports no cap. */
  limitAmount: number | null;
  currency: string;
  /** unix ms epoch, or null if the provider doesn't report a reset date */
  resetsAt: number | null;
}

/** OpenAI/Codex account credits reported alongside rate-limit windows. */
export interface CodexCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance: number | null;
}

/** Claude Web-only prepaid-credit details. Claude Code's OAuth token cannot
 * read these endpoints, so this is an explicitly user-imported snapshot with
 * its own timestamp and provenance rather than being presented as live API
 * data. */
export interface AnthropicWebCredits {
  source: "claude_web_manual";
  capturedAt: number;
  updatedAt: number;
  /** Canonical spendable prepaid balance, in major currency units (dollars) —
   * the "Current balance" line in Claude Settings → Usage. This is the total
   * currently spendable across all sources (it includes any unexpired
   * promotional credit). Consumers wanting "money the user can spend right now"
   * should read this field. */
  currentBalance: number | null;
  /**
   * @deprecated Legacy duplicate with no distinct source in Claude's current
   * usage UI — every visible balance maps to `currentBalance` or a
   * `promotionalTranches[]` entry. Retained (and still accepted on import) only
   * for backward compatibility; prefer `currentBalance`. If a future Claude UI
   * introduces a genuinely separate non-dollar credit quantity, redocument this
   * field then rather than reusing it silently.
   */
  balanceCredits: number | null;
  currency: string;
  autoReloadEnabled: boolean | null;
  /** unix ms epoch of the soonest credit expiry. For date-only imports this is
   * UTC-midnight; read `nextExpiresOn` for the calendar-date representation. */
  nextExpiresAt: number | null;
  /** `YYYY-MM-DD` (UTC) canonical calendar date for `nextExpiresAt` when the
   * expiry is genuinely date-only (Claude Web credit expiries are calendar
   * dates). Render verbatim; do NOT reapply a local timezone. null when unknown. */
  nextExpiresOn: string | null;
  promotionalTranches: Array<{
    /** Major currency units (dollars). */
    remainingAmount: number;
    /** Major currency units (dollars), or null. */
    grantedAmount: number | null;
    /** unix ms epoch (UTC-midnight for date-only imports). */
    expiresAt: number | null;
    /** `YYYY-MM-DD` (UTC) companion to `expiresAt`; render verbatim. */
    expiresOn: string | null;
  }>;
  campaign: {
    id: string;
    granted: boolean | null;
    /** Major currency units (dollars), or null. */
    amount: number | null;
    /** unix ms epoch (UTC-midnight for date-only imports). */
    expiresAt: number | null;
    /** `YYYY-MM-DD` (UTC) companion to `expiresAt`; render verbatim. */
    expiresOn: string | null;
  } | null;
  purchases: {
    /** Major currency units (dollars), or null. */
    purchasedThisMonthAmount: number | null;
    /** Major currency units (dollars), or null. */
    monthlyCapAmount: number | null;
    resetsAt: number | null;
    maxDiscountPercent: number | null;
  } | null;
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
  /** Codex credits, measured in provider-defined credits rather than money. */
  codexCredits?: CodexCredits | null;
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

/** One contiguous burst of activity in a local Codex/Claude session log.
 * Bursts are split after 30 minutes idle so a thread resumed days later does
 * not masquerade as one enormous run. Dollar amounts are API-list-price
 * equivalents, not subscription charges. */
export interface RunUsage {
  id: string;
  provider: "codex" | "anthropic";
  title: string;
  startedAt: number;
  endedAt: number;
  model: string;
  effort: string | null;
  isSubagent: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
  apiEquivalentUsd: number;
  rateLabel: string;
}
