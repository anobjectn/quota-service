// Shared formatting/reporting logic used by the CLI, HTTP API, and MCP
// server so all three surfaces present identical data and identical
// stale/unavailable semantics.

import type { Database } from "bun:sqlite";
import { ENABLED_PROVIDERS } from "./config";
import { getLatestResetCredits, getLatestSnapshot, getLatestSnapshotWithData, getManualEntries } from "./db";
import { POLL_FLOORS_MS } from "./collect";
import { finiteNumber, parseInstant, toUtcDateString } from "./lib/time";
import type {
  AnthropicWebCredits,
  CollectorResult,
  ManualEntry,
  Provider,
  ResetCreditsResult,
} from "./types";

/** A provider whose data is older than this multiple of its poll floor is
 * presented as "stale" regardless of what the last collector run reported —
 * this is what makes a wedged poll loop visible instead of silently serving
 * hours-old data under an "ok" badge (the Jul 13 incident this guards against). */
const STALE_AGE_MULTIPLIER = 3;

export interface ProviderReport {
  provider: Provider;
  status: CollectorResult["status"] | "unknown";
  source: string | null;
  dataAgeMs: number | null;
  /** When the served snapshot was collected. With `servingLastGood`, this is
   * the last successful collection, not the newest attempt. */
  capturedAt: number | null;
  /** When the collector last ran for this provider, successful or not. */
  lastAttemptAt?: number | null;
  /** True when the newest attempt returned no values and `snapshot` is the
   * last successful reading. `status` is then "stale" and `error` holds the
   * newest attempt's failure reason. */
  servingLastGood?: boolean;
  snapshot: CollectorResult["snapshot"];
  error?: string;
  manualEntries: ManualEntry[];
  /** Present only for Anthropic when the user has imported the Claude
   * Web-only prepaid-credit snapshot. */
  anthropicWebCredits?: AnthropicWebCredits | null;
}

export interface UsageReport {
  generatedAt: number;
  providers: ProviderReport[];
}

export function buildUsageReport(
  db: Database,
  providers: readonly Provider[] = ENABLED_PROVIDERS,
): UsageReport {
  const generatedAt = Date.now();
  const reports = providers.map((provider) => buildProviderReport(db, provider, generatedAt));
  return { generatedAt, providers: reports };
}

function buildProviderReport(db: Database, provider: Provider, now: number): ProviderReport {
  const latest = getLatestSnapshot(db, provider);
  const manualEntries = getManualEntries(db, provider);
  const anthropicWebCredits = provider === "anthropic"
    ? parseAnthropicWebCredits(manualEntries.find((entry) => entry.field === "claude_web_credit_snapshot"))
    : undefined;
  if (!latest) {
    return {
      provider,
      status: "unknown",
      source: null,
      dataAgeMs: null,
      capturedAt: null,
      snapshot: null,
      error: "no data collected yet",
      manualEntries,
      anthropicWebCredits,
    };
  }
  if (!latest.snapshot) {
    const lastGood = getLatestSnapshotWithData(db, provider);
    if (lastGood) {
      // The newest attempt failed (HTTP 429, expired token, timeout) and
      // stored no values. Serve the last reading under an explicit "stale"
      // status with its real age, and keep the failure reason in `error`, so
      // consumers show old numbers with a marker instead of an empty card.
      return {
        provider,
        status: "stale",
        source: lastGood.source,
        dataAgeMs: now - (lastGood.dataAsOf ?? lastGood.capturedAt),
        capturedAt: lastGood.capturedAt,
        lastAttemptAt: latest.capturedAt,
        servingLastGood: true,
        snapshot: lastGood.snapshot,
        error: latest.error ?? `latest ${provider} collection returned no data`,
        manualEntries,
        anthropicWebCredits,
      };
    }
  }
  const dataAgeMs = latest.dataAsOf != null ? now - latest.dataAsOf : null;
  // The wedge signal is "how long since the poll loop last successfully ran
  // this provider's collector" (capturedAt), not "how old is the underlying
  // event" (dataAsOf) — those two diverge for tactics like Warp's plist read,
  // where dataAsOf tracks Warp's own last-usage timestamp and can be legitimately
  // old (Warp just isn't running) even though the collector itself runs fine on
  // every poll/collect-on-query. capturedAt advances every time the collector
  // actually runs, so it's what a stalled poll loop would leave behind stale.
  const collectorAgeMs = now - latest.capturedAt;
  const floorMs = POLL_FLOORS_MS[provider];
  const isStaleByAge = latest.status === "ok" && floorMs != null && collectorAgeMs > floorMs * STALE_AGE_MULTIPLIER;
  return {
    provider,
    status: isStaleByAge ? "stale" : latest.status,
    source: latest.source,
    dataAgeMs,
    capturedAt: latest.capturedAt,
    lastAttemptAt: latest.capturedAt,
    servingLastGood: false,
    snapshot: latest.snapshot,
    error: isStaleByAge
      ? `collector last ran ${Math.round(collectorAgeMs / 1000)}s ago, exceeding ${STALE_AGE_MULTIPLIER}x the ${provider} poll floor (${Math.round(floorMs! / 1000)}s) — poll loop may be stalled`
      : latest.error,
    manualEntries,
    anthropicWebCredits,
  };
}

function parseAnthropicWebCredits(entry: ManualEntry | undefined): AnthropicWebCredits | null {
  if (!entry) return null;
  try {
    const raw = JSON.parse(entry.value) as Record<string, unknown>;
    const promotionalTranches = Array.isArray(raw.promotionalTranches)
      ? raw.promotionalTranches.flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const tranche = value as Record<string, unknown>;
          const remainingAmount = finiteNumber(tranche.remainingAmount);
          if (remainingAmount === null) return [];
          const expiresAt = parseInstant(tranche.expiresAt);
          return [{
            remainingAmount,
            grantedAmount: finiteNumber(tranche.grantedAmount),
            expiresAt,
            expiresOn: toUtcDateString(expiresAt),
          }];
        })
      : [];
    const rawCampaign = raw.campaign && typeof raw.campaign === "object"
      ? raw.campaign as Record<string, unknown>
      : null;
    const rawPurchases = raw.purchases && typeof raw.purchases === "object"
      ? raw.purchases as Record<string, unknown>
      : null;
    const nextExpiresAt = parseInstant(raw.nextExpiresAt);
    const campaignExpiresAt = rawCampaign ? parseInstant(rawCampaign.expiresAt) : null;
    return {
      source: "claude_web_manual",
      capturedAt: parseInstant(raw.capturedAt) ?? entry.updatedAt,
      updatedAt: entry.updatedAt,
      currentBalance: finiteNumber(raw.currentBalance),
      balanceCredits: finiteNumber(raw.balanceCredits),
      currency: typeof raw.currency === "string" ? raw.currency : "USD",
      autoReloadEnabled: typeof raw.autoReloadEnabled === "boolean" ? raw.autoReloadEnabled : null,
      nextExpiresAt,
      nextExpiresOn: toUtcDateString(nextExpiresAt),
      promotionalTranches,
      campaign: rawCampaign && typeof rawCampaign.id === "string"
        ? {
            id: rawCampaign.id,
            granted: typeof rawCampaign.granted === "boolean" ? rawCampaign.granted : null,
            amount: finiteNumber(rawCampaign.amount),
            expiresAt: campaignExpiresAt,
            expiresOn: toUtcDateString(campaignExpiresAt),
          }
        : null,
      purchases: rawPurchases
        ? {
            purchasedThisMonthAmount: finiteNumber(rawPurchases.purchasedThisMonthAmount),
            monthlyCapAmount: finiteNumber(rawPurchases.monthlyCapAmount),
            resetsAt: parseInstant(rawPurchases.resetsAt),
            maxDiscountPercent: finiteNumber(rawPurchases.maxDiscountPercent),
          }
        : null,
    };
  } catch {
    return null;
  }
}

export interface ResetsReport {
  generatedAt: number;
  windows: Array<{
    provider: Provider;
    window: "fiveHour" | "weekly";
    usedPercent: number;
    resetsAt: number | null;
    /** When this reading was collected. It can be older than the newest
     * attempt when that attempt failed. */
    capturedAt: number;
  }>;
  pools: Array<{
    provider: Provider;
    used: number;
    limit: number;
    usedPercent: number;
    refreshesAt: number | null;
    cadence?: string;
    capturedAt: number;
  }>;
  codexBankedResetCredits: {
    availableCount: number | null;
    totalEarnedCount: number | null;
    credits: ResetCreditsResult["credits"];
    capturedAt: number;
    status: ResetCreditsResult["status"];
    error?: string;
  } | null;
}

export function buildResetsReport(
  db: Database,
  providers: readonly Provider[] = ENABLED_PROVIDERS,
): ResetsReport {
  const generatedAt = Date.now();
  const windows: ResetsReport["windows"] = [];
  const pools: ResetsReport["pools"] = [];
  for (const provider of providers) {
    // A failed newest attempt stores no values; keep listing the last known
    // windows (with their capture time) instead of dropping the provider.
    const latest = getLatestSnapshotWithData(db, provider);
    if (!latest?.snapshot) continue;
    if (latest.snapshot.kind === "window") {
      if (latest.snapshot.fiveHour) {
        windows.push({
          provider,
          window: "fiveHour",
          usedPercent: latest.snapshot.fiveHour.usedPercent,
          resetsAt: latest.snapshot.fiveHour.resetsAt,
          capturedAt: latest.capturedAt,
        });
      }
      if (latest.snapshot.weekly) {
        windows.push({
          provider,
          window: "weekly",
          usedPercent: latest.snapshot.weekly.usedPercent,
          resetsAt: latest.snapshot.weekly.resetsAt,
          capturedAt: latest.capturedAt,
        });
      }
    } else if (latest.snapshot.kind === "pool") {
      pools.push({
        provider,
        used: latest.snapshot.pool.used,
        limit: latest.snapshot.pool.limit,
        usedPercent: latest.snapshot.pool.usedPercent,
        refreshesAt: latest.snapshot.pool.refreshesAt,
        cadence: latest.snapshot.pool.cadence,
        capturedAt: latest.capturedAt,
      });
    }
  }
  const codexResetCredits = providers.includes("codex") ? getLatestResetCredits(db, "codex") : null;
  return {
    generatedAt,
    windows,
    pools,
    codexBankedResetCredits: codexResetCredits
      ? {
          availableCount: codexResetCredits.availableCount,
          totalEarnedCount: codexResetCredits.totalEarnedCount,
          credits: codexResetCredits.credits,
          capturedAt: codexResetCredits.capturedAt,
          status: codexResetCredits.status,
          error: codexResetCredits.error,
        }
      : null,
  };
}

export function formatAge(ms: number | null): string {
  if (ms == null) return "unknown";
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

export function formatCountdown(ts: number | null): string {
  if (ts == null) return "unknown";
  const diffMs = ts - Date.now();
  if (diffMs <= 0) return "now";
  const sec = Math.floor(diffMs / 1000);
  const min = Math.floor(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 48) return `in ${hr}h ${remMin}m`;
  const days = Math.floor(hr / 24);
  const remHr = hr % 24;
  return `in ${days}d ${remHr}h`;
}

export function statusBadge(status: string): string {
  switch (status) {
    case "ok":
      return "OK";
    case "stale":
      return "STALE";
    case "unavailable":
      return "UNAVAILABLE";
    default:
      return "UNKNOWN";
  }
}
