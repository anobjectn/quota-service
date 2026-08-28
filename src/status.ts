import { ENABLED_PROVIDERS } from "./config";
import { POLL_FLOORS_MS } from "./collect";
import { getLatestSnapshot, getProviderHealth } from "./db";
import type { Database } from "bun:sqlite";
import type { Provider } from "./types";

export interface ServiceStatus {
  ok: true;
  uptimeMs: number;
  pollMs: number;
  enabledProviders: readonly Provider[];
  providers?: Array<{
    provider: Provider;
    lastAttemptAt: number | null;
    lastSuccessAt: number | null;
    lastObservationAt: number | null;
    freshness: "current" | "stale" | "unavailable";
    failureReason: string | null;
  }>;
}

function safeReason(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/[\r\n]+/g, " ").slice(0, 160);
}

export function buildServiceStatus(
  pollMs: number,
  enabledProviders: readonly Provider[] = ENABLED_PROVIDERS,
  uptimeMs = process.uptime() * 1000,
  db?: Database,
): ServiceStatus {
  const status: ServiceStatus = { ok: true, uptimeMs, pollMs, enabledProviders };
  if (!db) return status;
  const now = Date.now();
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
