import type { Database } from "bun:sqlite";
import { RETENTION_DAYS } from "./config";
import { getPlanAssignmentAt } from "./db";
import type { CollectorResult, Provider, QuotaObservation, QuotaSnapshot } from "./types";

const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_LIMIT = 5_000;
const DEFAULT_LIMIT = 1_000;

type Cursor = {
  v: 1;
  provider: Provider;
  from: number;
  to: number;
  limit: number;
  historyVersion: number;
  observedAt: number;
  rowId: number;
};

type SnapshotRow = {
  rowId: number;
  provider: Provider;
  status: CollectorResult["status"];
  source: string;
  dataAsOf: number | null;
  capturedAt: number;
  snapshotJson: string;
  observedAt: number;
};

export class HistoryRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function finiteInteger(value: string | null, label: string): number {
  if (value === null || value.trim() === "") throw new HistoryRequestError(`${label} is required`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HistoryRequestError(`${label} must be a non-negative epoch-millisecond integer`);
  }
  return parsed;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): Cursor {
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    if (
      value.v !== 1 ||
      typeof value.provider !== "string" ||
      !Number.isSafeInteger(value.from) ||
      !Number.isSafeInteger(value.to) ||
      !Number.isSafeInteger(value.limit) ||
      !Number.isSafeInteger(value.historyVersion) ||
      !Number.isSafeInteger(value.observedAt) ||
      !Number.isSafeInteger(value.rowId)
    ) throw new Error("invalid cursor fields");
    return value as Cursor;
  } catch {
    throw new HistoryRequestError("cursor is invalid or malformed");
  }
}

function cycleId(at: number | null, observedAt: number): string {
  return at === null
    ? `observed:${observedAt}`
    : `reset:${Math.floor(at / 60_000) * 60_000}`;
}

function timeSource(source: string, dataAsOf: number | null): QuotaObservation["timeSource"] {
  if (dataAsOf === null) return "collector";
  if (source === "warp_plist" || source.endsWith("_file")) return "source_mtime";
  return "provider";
}

function providerPlan(snapshot: QuotaSnapshot): string | null {
  if (snapshot.kind !== "window") return null;
  const candidate = snapshot.extra?.planType ?? snapshot.extra?.subscriptionType;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

export function normalizeSnapshotRow(db: Database, row: SnapshotRow): QuotaObservation {
  const snapshot = JSON.parse(row.snapshotJson) as QuotaSnapshot;
  const assigned = getPlanAssignmentAt(db, row.provider, row.observedAt);
  const reportedPlan = providerPlan(snapshot);
  const plan = assigned
    ? { id: assigned.planId, label: assigned.planLabel, source: "configured" as const, effectiveFrom: assigned.effectiveFrom }
    : reportedPlan
      ? { id: reportedPlan, label: reportedPlan, source: "provider" as const, effectiveFrom: null }
      : { id: null, label: null, source: "unknown" as const, effectiveFrom: null };
  const base = {
    schemaVersion: 1 as const,
    provider: row.provider,
    capturedAt: row.capturedAt,
    observedAt: row.observedAt,
    timeSource: timeSource(row.source, row.dataAsOf),
    status: row.status === "stale" ? "stale" as const : "ok" as const,
    source: row.source,
    plan,
  };

  if (snapshot.kind === "window") {
    const windows = (["fiveHour", "weekly"] as const).flatMap((id) => {
      const window = snapshot[id];
      if (!window || !Number.isFinite(window.usedPercent)) return [];
      return [{
        id,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt,
        cycleId: cycleId(window.resetsAt, row.observedAt),
      }];
    });
    return { ...base, quota: { kind: "windows", windows } };
  }

  const { used, limit, usedPercent: storedPercent, refreshesAt, cadence } = snapshot.pool;
  if (![used, limit, storedPercent].every(Number.isFinite) || limit <= 0) {
    throw new HistoryRequestError(`snapshot ${row.rowId} has an invalid Warp pool limit`, 422);
  }
  const usedPercent = used / limit * 100;
  if (Math.abs(usedPercent - storedPercent) > 0.11) {
    throw new HistoryRequestError(`snapshot ${row.rowId} has conflicting Warp pool percentages`, 422);
  }
  return {
    ...base,
    quota: {
      kind: "pool",
      pool: {
        id: "monthly",
        usedUnits: used,
        limitUnits: limit,
        unit: "warp_credit",
        unitSource: "provider_docs_and_local_schema",
        usedPercent,
        refreshesAt,
        cadence: cadence ?? null,
        cycleId: cycleId(refreshesAt, row.observedAt),
      },
    },
  };
}

export type HistoryResponse = {
  schemaVersion: 1;
  provider: Provider;
  from: number;
  to: number;
  historyVersion: number;
  earliestObservationAt: number | null;
  retentionDays: number | null;
  retentionMode: "forever" | "finite";
  observations: QuotaObservation[];
  nextCursor: string | null;
};

export function buildHistoryResponse(
  db: Database,
  params: URLSearchParams,
  enabledProviders: readonly Provider[],
): HistoryResponse {
  const provider = params.get("provider") as Provider | null;
  if (!provider || !enabledProviders.includes(provider)) {
    throw new HistoryRequestError("provider must name one enabled provider");
  }
  const from = finiteInteger(params.get("from"), "from");
  const to = finiteInteger(params.get("to"), "to");
  if (to < from) throw new HistoryRequestError("to must be greater than or equal to from");
  if (to - from > MAX_RANGE_MS) throw new HistoryRequestError("history ranges may not exceed 31 days");
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new HistoryRequestError("limit must be an integer from 1 through 5000");
  }

  const suppliedCursor = params.get("cursor");
  const cursor = suppliedCursor ? decodeCursor(suppliedCursor) : null;
  if (cursor && (
    cursor.provider !== provider || cursor.from !== from || cursor.to !== to || cursor.limit !== limit
  )) throw new HistoryRequestError("cursor does not match this history request");

  const historyVersion = cursor?.historyVersion ?? ((db.query(
    "SELECT COALESCE(MAX(id), 0) AS version FROM snapshots WHERE provider = ?",
  ).get(provider) as { version: number }).version);
  const earliestObservationAt = (db.query(
    `SELECT MIN(COALESCE(data_as_of, captured_at)) AS at
     FROM snapshots WHERE provider = ? AND snapshot_json IS NOT NULL AND status IN ('ok', 'stale')`,
  ).get(provider) as { at: number | null }).at;
  const rows = db.query(
    `SELECT id AS rowId, provider, status, source, data_as_of AS dataAsOf,
            captured_at AS capturedAt, snapshot_json AS snapshotJson,
            COALESCE(data_as_of, captured_at) AS observedAt
     FROM snapshots
     WHERE provider = ? AND id <= ? AND snapshot_json IS NOT NULL
       AND status IN ('ok', 'stale')
       AND COALESCE(data_as_of, captured_at) BETWEEN ? AND ?
       AND (? IS NULL OR COALESCE(data_as_of, captured_at) > ?
            OR (COALESCE(data_as_of, captured_at) = ? AND id > ?))
     ORDER BY observedAt, id
     LIMIT ?`,
  ).all(
    provider,
    historyVersion,
    from,
    to,
    cursor?.observedAt ?? null,
    cursor?.observedAt ?? null,
    cursor?.observedAt ?? null,
    cursor?.rowId ?? null,
    limit + 1,
  ) as SnapshotRow[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last
    ? encodeCursor({ v: 1, provider, from, to, limit, historyVersion, observedAt: last.observedAt, rowId: last.rowId })
    : null;

  return {
    schemaVersion: 1,
    provider,
    from,
    to,
    historyVersion,
    earliestObservationAt,
    retentionDays: RETENTION_DAYS,
    retentionMode: RETENTION_DAYS === null ? "forever" : "finite",
    observations: page.map((row) => normalizeSnapshotRow(db, row)),
    nextCursor,
  };
}
