// Orchestrates running collectors and persisting results, honoring each
// provider's polite-polling floor. Used by both the on-demand CLI
// (collect-on-query) and the foreground server's poll loop.

import { ENABLED_PROVIDERS } from "./config";
import type { Database } from "bun:sqlite";
import { getLatestSnapshot, recordProviderAttempt, saveResetCredits, saveSnapshot } from "./db";
import { collectAnthropic, ANTHROPIC_POLL_FLOOR_MS } from "./collectors/anthropic";
import { collectCodexFromApi, collectCodexResetCredits } from "./collectors/codex";
import { collectWarp } from "./collectors/warp";
import type { CollectorResult, Provider } from "./types";

/** CodexBar-style politeness floor for Codex's undocumented network path; the file tactic has no floor. */
const CODEX_API_POLL_FLOOR_MS = 60_000;
/** Warp's read is a cheap local `defaults read` with no politeness concern,
 * but it still needs a floor for the staleness-rule multiplier below (a
 * provider whose data age exceeds ~3x this must render "stale"). */
const WARP_READ_FLOOR_MS = 60_000;

/** Per-provider poll floors, shared with present.ts for the staleness rule
 * (data age > 3x floor => force "stale" regardless of collector status). */
export const POLL_FLOORS_MS: Record<Provider, number> = {
  codex: CODEX_API_POLL_FLOOR_MS,
  anthropic: ANTHROPIC_POLL_FLOOR_MS,
  warp: WARP_READ_FLOOR_MS,
};

/** Hard ceiling on a single collect-on-query re-collect attempt so an HTTP/
 * MCP/CLI read can never hang waiting on a wedged network call — this is on
 * top of (not instead of) each collector's own internal fetch timeout, as a
 * second line of defense. */
const COLLECT_ATTEMPT_TIMEOUT_MS = 12_000;

function isWithinFloor(db: Database, provider: Provider, floorMs: number): boolean {
  const latest = getLatestSnapshot(db, provider);
  if (!latest) return false;
  return Date.now() - latest.capturedAt < floorMs;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

/**
 * Attempt a fresh collect; on failure/timeout, don't clobber the DB with a
 * failure row if we have older data to fall back on — return the old
 * snapshot with an honest note instead ("serve the old data with honest
 * status" per the collect-on-query contract). The staleness rule in
 * present.ts is what actually flips the displayed status to "stale" once
 * the data is old enough; this function's job is just to not make things
 * worse by discarding good history on a transient failure.
 */
async function recollectOrServeStale(
  db: Database,
  provider: Provider,
  collect: () => Promise<CollectorResult>,
  cached: CollectorResult | null,
): Promise<CollectorResult> {
  try {
    const result = await withTimeout(collect(), COLLECT_ATTEMPT_TIMEOUT_MS, `${provider} collect`);
    saveSnapshot(db, result);
    recordProviderAttempt(db, provider, Date.now(), result, result.error ?? null);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cached) {
      recordProviderAttempt(db, provider, Date.now(), null, message);
      return {
        ...cached,
        error: `re-collect failed (${message}); serving last-known data`,
      };
    }
    const failResult: CollectorResult = {
      provider,
      status: "unavailable",
      source: `${provider}_api`,
      dataAsOf: null,
      capturedAt: Date.now(),
      snapshot: null,
      error: message,
    };
    saveSnapshot(db, failResult);
    recordProviderAttempt(db, provider, Date.now(), failResult, message);
    return failResult;
  }
}

export async function collectCodexAndSave(db: Database, opts: { force?: boolean } = {}): Promise<CollectorResult> {
  const cached = getLatestSnapshot(db, "codex");
  if (!opts.force && isWithinFloor(db, "codex", CODEX_API_POLL_FLOOR_MS)) {
    return cached!;
  }
  const result = await recollectOrServeStale(db, "codex", collectCodexFromApi, cached);
  // Reset credits share the same auth + politeness floor; fetch alongside,
  // best-effort (never let a reset-credits hiccup block the main snapshot).
  try {
    const resetCredits = await withTimeout(collectCodexResetCredits(), COLLECT_ATTEMPT_TIMEOUT_MS, "codex reset credits");
    saveResetCredits(db, resetCredits);
  } catch (err) {
    console.error("[quota-service] codex reset credits collect failed:", err instanceof Error ? err.message : err);
  }
  return result;
}

export async function collectAnthropicAndSave(db: Database, opts: { force?: boolean } = {}): Promise<CollectorResult> {
  const cached = getLatestSnapshot(db, "anthropic");
  if (!opts.force && isWithinFloor(db, "anthropic", ANTHROPIC_POLL_FLOOR_MS)) {
    return cached!;
  }
  return recollectOrServeStale(db, "anthropic", collectAnthropic, cached);
}

export async function collectWarpAndSave(db: Database): Promise<CollectorResult> {
  // Cheap local read; no politeness floor, but still guarded against a hang
  // in the `defaults read` subprocess so it can't wedge the caller either.
  const cached = getLatestSnapshot(db, "warp");
  return recollectOrServeStale(db, "warp", collectWarp, cached);
}

export async function collectAll(
  db: Database,
  opts: { force?: boolean } = {},
  providers: readonly Provider[] = ENABLED_PROVIDERS,
  runners: CollectorRunners = DEFAULT_COLLECTOR_RUNNERS,
): Promise<Partial<Record<Provider, CollectorResult>>> {
  const entries = await Promise.all(
    providers.map(async (provider) => [
      provider,
      await runProviderOnce(provider, () => runners[provider](db, opts)),
    ] as const),
  );
  return Object.fromEntries(entries) as Partial<Record<Provider, CollectorResult>>;
}

// The poll loop and collect-on-query routes can notice the same stale row at
// the same time. Share that provider's active run so they do not make duplicate
// network requests or persist nearly-identical snapshots a millisecond apart.
const IN_FLIGHT_COLLECTIONS = new Map<Provider, Promise<CollectorResult>>();

function runProviderOnce(
  provider: Provider,
  run: () => Promise<CollectorResult>,
): Promise<CollectorResult> {
  const active = IN_FLIGHT_COLLECTIONS.get(provider);
  if (active) return active;

  const pending = Promise.resolve()
    .then(run)
    .finally(() => {
      if (IN_FLIGHT_COLLECTIONS.get(provider) === pending) {
        IN_FLIGHT_COLLECTIONS.delete(provider);
      }
    });
  IN_FLIGHT_COLLECTIONS.set(provider, pending);
  return pending;
}

export type CollectorRunner = (
  db: Database,
  opts: { force?: boolean },
) => Promise<CollectorResult>;

export type CollectorRunners = Record<Provider, CollectorRunner>;

const DEFAULT_COLLECTOR_RUNNERS: CollectorRunners = {
  codex: collectCodexAndSave,
  anthropic: collectAnthropicAndSave,
  warp: (db) => collectWarpAndSave(db),
};
