import { ENABLED_PROVIDERS, RETENTION_DAYS } from "./config";
import { POLL_FLOORS_MS } from "./collect";
import { getLatestSnapshot, getProviderHealth, resolveDbPath } from "./db";
import { restartStrategy, type RestartStrategy } from "./restart";
import pkg from "../package.json";
import type { Database } from "bun:sqlite";
import type { Provider } from "./types";

export interface ServiceStatus {
  ok: true;
  version: string;
  pid: number;
  startedAt: number;
  uptimeMs: number;
  pollMs: number;
  enabledProviders: readonly Provider[];
  listen?: { host: string; port: number };
  dbPath?: string;
  retention?: { days: number | null; mode: "forever" | "days" };
  restart?: { supported: boolean; strategy: RestartStrategy };
  markers?: { count: number; lastOccurredAt: number | null };
  providers?: Array<{
    provider: Provider;
    lastAttemptAt: number | null;
    lastSuccessAt: number | null;
    lastObservationAt: number | null;
    freshness: "current" | "stale" | "unavailable";
    failureReason: string | null;
  }>;
}

export interface ServiceStatusOptions {
  pollMs: number;
  enabledProviders?: readonly Provider[];
  uptimeMs?: number;
  db?: Database;
  listen?: { host: string; port: number };
  now?: number;
}

function safeReason(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/[\r\n]+/g, " ").slice(0, 160);
}

/** Marker counts are a diagnostic, not a contract: a database that predates the
 * lifecycle table must still return a status rather than fail the whole read. */
function markerSummary(db: Database): ServiceStatus["markers"] {
  try {
    const row = db.query(
      "SELECT COUNT(*) AS count, MAX(occurred_at) AS lastOccurredAt FROM lifecycle_markers",
    ).get() as { count: number; lastOccurredAt: number | null } | null;
    if (!row) return undefined;
    return { count: row.count, lastOccurredAt: row.lastOccurredAt ?? null };
  } catch {
    return undefined;
  }
}

export function buildServiceStatus(options: ServiceStatusOptions): ServiceStatus {
  const {
    pollMs,
    enabledProviders = ENABLED_PROVIDERS,
    uptimeMs = process.uptime() * 1000,
    db,
    listen,
    now = Date.now(),
  } = options;
  const status: ServiceStatus = {
    ok: true,
    version: pkg.version,
    pid: process.pid,
    startedAt: Math.round(now - uptimeMs),
    uptimeMs,
    pollMs,
    enabledProviders,
    retention: { days: RETENTION_DAYS, mode: RETENTION_DAYS === null ? "forever" : "days" },
    restart: { supported: true, strategy: restartStrategy() },
  };
  if (listen) status.listen = listen;
  if (!db) return status;
  status.dbPath = resolveDbPath();
  status.markers = markerSummary(db);
  status.providers = enabledProviders.map((provider) => {
    const health = getProviderHealth(db, provider);
    const latest = getLatestSnapshot(db, provider);
    const observedAt = health?.lastObservationAt ?? latest?.dataAsOf ?? latest?.capturedAt ?? null;
    const freshness = observedAt === null
      ? "unavailable" as const
      : now - observedAt > POLL_FLOORS_MS[provider] * 3
        ? "stale" as const
        : "current" as const;
    return {
      provider,
      lastAttemptAt: health?.lastAttemptAt ?? latest?.capturedAt ?? null,
      lastSuccessAt: health?.lastSuccessAt ?? (latest?.snapshot ? latest.capturedAt : null),
      lastObservationAt: observedAt,
      freshness,
      failureReason: safeReason(health?.failureReason ?? latest?.error ?? null),
    };
  });
  return status;
}
