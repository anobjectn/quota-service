// Shared formatting/reporting logic used by the CLI, HTTP API, and MCP
// server so all three surfaces present identical data and identical
// stale/unavailable semantics.

import type { Database } from "bun:sqlite";
import { ENABLED_PROVIDERS } from "./config";
import { getLatestResetCredits, getLatestSnapshot, getManualEntries } from "./db";
import { POLL_FLOORS_MS } from "./collect";
import type { CollectorResult, ManualEntry, Provider, ResetCreditsResult } from "./types";

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
  capturedAt: number | null;
  snapshot: CollectorResult["snapshot"];
  error?: string;
  manualEntries: ManualEntry[];
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
    };
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
    snapshot: latest.snapshot,
    error: isStaleByAge
      ? `collector last ran ${Math.round(collectorAgeMs / 1000)}s ago, exceeding ${STALE_AGE_MULTIPLIER}x the ${provider} poll floor (${Math.round(floorMs! / 1000)}s) — poll loop may be stalled`
      : latest.error,
    manualEntries,
  };
}

export interface ResetsReport {
  generatedAt: number;
  windows: Array<{
    provider: Provider;
    window: "fiveHour" | "weekly";
    usedPercent: number;
    resetsAt: number | null;
  }>;
  pools: Array<{
    provider: Provider;
    used: number;
    limit: number;
    usedPercent: number;
    refreshesAt: number | null;
    cadence?: string;
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
    const latest = getLatestSnapshot(db, provider);
    if (!latest?.snapshot) continue;
    if (latest.snapshot.kind === "window") {
      if (latest.snapshot.fiveHour) {
        windows.push({
          provider,
          window: "fiveHour",
          usedPercent: latest.snapshot.fiveHour.usedPercent,
          resetsAt: latest.snapshot.fiveHour.resetsAt,
        });
      }
      if (latest.snapshot.weekly) {
        windows.push({
          provider,
          window: "weekly",
          usedPercent: latest.snapshot.weekly.usedPercent,
          resetsAt: latest.snapshot.weekly.resetsAt,
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
