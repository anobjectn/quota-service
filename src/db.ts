import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CollectorResult,
  ManualEntry,
  PlanAssignment,
  Provider,
  QuotaLifecycleMarker,
  ResetCreditsResult,
} from "./types";

const DEFAULT_DB_PATH = join(homedir(), ".quota-service", "quota.db");

export function resolveDbPath(): string {
  return process.env.QUOTA_DB_PATH ?? DEFAULT_DB_PATH;
}

let dbInstance: Database | null = null;

export function openDb(path: string = resolveDbPath()): Database {
  if (dbInstance) return dbInstance;
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      data_as_of INTEGER,
      captured_at INTEGER NOT NULL,
      snapshot_json TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_provider_captured
      ON snapshots (provider, captured_at DESC);

    CREATE TABLE IF NOT EXISTS reset_credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      available_count INTEGER,
      total_earned_count INTEGER,
      credits_json TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reset_credits_provider_captured
      ON reset_credits (provider, captured_at DESC);

    CREATE TABLE IF NOT EXISTS manual_entries (
      provider TEXT NOT NULL,
      field TEXT NOT NULL,
      value TEXT NOT NULL,
      note TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, field)
    );

    CREATE TABLE IF NOT EXISTS plan_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      plan_label TEXT NOT NULL,
      effective_from INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plan_assignments_provider_effective
      ON plan_assignments (provider, effective_from, id);

    CREATE TABLE IF NOT EXISTS lifecycle_markers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      event TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(provider, session_id, event, occurred_at)
    );
    CREATE INDEX IF NOT EXISTS idx_lifecycle_markers_provider_occurred
      ON lifecycle_markers (provider, occurred_at, id);

    CREATE TABLE IF NOT EXISTS provider_health (
      provider TEXT PRIMARY KEY,
      last_attempt_at INTEGER NOT NULL,
      last_success_at INTEGER,
      last_observation_at INTEGER,
      failure_reason TEXT
    );
  `);
  dbInstance = db;
  return db;
}

export function saveSnapshot(db: Database, result: CollectorResult): void {
  db.run(
    `INSERT INTO snapshots (provider, status, source, data_as_of, captured_at, snapshot_json, error)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM snapshots WHERE provider = ? AND captured_at = ?
     )`,
    [
      result.provider,
      result.status,
      result.source,
      result.dataAsOf,
      result.capturedAt,
      result.snapshot ? JSON.stringify(result.snapshot) : null,
      result.error ?? null,
      result.provider,
      result.capturedAt,
    ],
  );
}

export function getLatestSnapshot(
  db: Database,
  provider: Provider,
): CollectorResult | null {
  return readLatestSnapshotRow(db, provider, false);
}

/** The newest row that carries quota values. A failed attempt (HTTP 429,
 * expired token, timeout) stores a row with no snapshot; readers that must
 * keep showing the last reading use this instead of `getLatestSnapshot`. */
export function getLatestSnapshotWithData(
  db: Database,
  provider: Provider,
): CollectorResult | null {
  return readLatestSnapshotRow(db, provider, true);
}

/** Error strings of the newest rows, newest first. The collect loop reads
 * these to count consecutive rate-limit failures for its back-off. */
export function getRecentSnapshotErrors(
  db: Database,
  provider: Provider,
  limit: number,
): Array<string | null> {
  const rows = db
    .query(`SELECT error FROM snapshots WHERE provider = ? ORDER BY captured_at DESC LIMIT ?`)
    .all(provider, limit) as Array<{ error: string | null }>;
  return rows.map((row) => row.error);
}

function readLatestSnapshotRow(
  db: Database,
  provider: Provider,
  requireData: boolean,
): CollectorResult | null {
  const row = db
    .query(
      `SELECT provider, status, source, data_as_of as dataAsOf, captured_at as capturedAt, snapshot_json as snapshotJson, error
       FROM snapshots WHERE provider = ?${requireData ? " AND snapshot_json IS NOT NULL" : ""}
       ORDER BY captured_at DESC LIMIT 1`,
    )
    .get(provider) as
    | {
        provider: Provider;
        status: CollectorResult["status"];
        source: string;
        dataAsOf: number | null;
        capturedAt: number;
        snapshotJson: string | null;
        error: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    provider: row.provider,
    status: row.status,
    source: row.source,
    dataAsOf: row.dataAsOf,
    capturedAt: row.capturedAt,
    snapshot: row.snapshotJson ? JSON.parse(row.snapshotJson) : null,
    error: row.error ?? undefined,
  };
}

export function saveResetCredits(db: Database, result: ResetCreditsResult): void {
  db.run(
    `INSERT INTO reset_credits (provider, status, captured_at, available_count, total_earned_count, credits_json, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      result.provider,
      result.status,
      result.capturedAt,
      result.availableCount,
      result.totalEarnedCount,
      JSON.stringify(result.credits),
      result.error ?? null,
    ],
  );
}

export function getLatestResetCredits(
  db: Database,
  provider: Provider,
): ResetCreditsResult | null {
  const row = db
    .query(
      `SELECT provider, status, captured_at as capturedAt, available_count as availableCount,
              total_earned_count as totalEarnedCount, credits_json as creditsJson, error
       FROM reset_credits WHERE provider = ? ORDER BY captured_at DESC LIMIT 1`,
    )
    .get(provider) as
    | {
        provider: Provider;
        status: ResetCreditsResult["status"];
        capturedAt: number;
        availableCount: number | null;
        totalEarnedCount: number | null;
        creditsJson: string | null;
        error: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    provider: row.provider,
    status: row.status,
    capturedAt: row.capturedAt,
    availableCount: row.availableCount,
    totalEarnedCount: row.totalEarnedCount,
    credits: row.creditsJson ? JSON.parse(row.creditsJson) : [],
    error: row.error ?? undefined,
  };
}

export function setManualEntry(
  db: Database,
  entry: Omit<ManualEntry, "updatedAt">,
): void {
  db.run(
    `INSERT INTO manual_entries (provider, field, value, note, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider, field) DO UPDATE SET value = excluded.value, note = excluded.note, updated_at = excluded.updated_at`,
    [entry.provider, entry.field, entry.value, entry.note, Date.now()],
  );
}

export function setPlanAssignment(
  db: Database,
  assignment: Omit<PlanAssignment, "createdAt">,
  now = Date.now(),
): void {
  const transaction = db.transaction(() => {
    db.run(
      `INSERT INTO plan_assignments (provider, plan_id, plan_label, effective_from, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [assignment.provider, assignment.planId, assignment.planLabel, assignment.effectiveFrom, now],
    );
    setManualEntry(db, {
      provider: assignment.provider,
      field: "plan_tier",
      value: assignment.planId,
      note: assignment.planLabel,
    });
  });
  transaction();
}

export function getPlanAssignmentAt(
  db: Database,
  provider: Provider,
  observedAt: number,
): PlanAssignment | null {
  return (db.query(
    `SELECT provider, plan_id AS planId, plan_label AS planLabel,
            effective_from AS effectiveFrom, created_at AS createdAt
     FROM plan_assignments
     WHERE provider = ? AND effective_from <= ?
     ORDER BY effective_from DESC, id DESC LIMIT 1`,
  ).get(provider, observedAt) as PlanAssignment | undefined) ?? null;
}

export function saveLifecycleMarker(db: Database, marker: QuotaLifecycleMarker): void {
  db.run(
    `INSERT OR IGNORE INTO lifecycle_markers
       (provider, session_id, event, occurred_at, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [marker.provider, marker.sessionId, marker.event, marker.occurredAt, marker.source, Date.now()],
  );
}

export function getLifecycleMarkers(
  db: Database,
  from: number,
  to: number,
): QuotaLifecycleMarker[] {
  return db.query(
    `SELECT provider, session_id AS sessionId, event, occurred_at AS occurredAt, source
     FROM lifecycle_markers
     WHERE provider = 'anthropic' AND occurred_at BETWEEN ? AND ?
     ORDER BY occurred_at, id`,
  ).all(from, to) as QuotaLifecycleMarker[];
}

export function recordProviderAttempt(
  db: Database,
  provider: Provider,
  attemptedAt: number,
  result: CollectorResult | null,
  failureReason: string | null,
): void {
  const successAt = result?.snapshot && result.status !== "unavailable" ? attemptedAt : null;
  const observationAt = result?.snapshot ? result.dataAsOf ?? result.capturedAt : null;
  db.run(
    `INSERT INTO provider_health
       (provider, last_attempt_at, last_success_at, last_observation_at, failure_reason)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       last_attempt_at = excluded.last_attempt_at,
       last_success_at = COALESCE(excluded.last_success_at, provider_health.last_success_at),
       last_observation_at = COALESCE(excluded.last_observation_at, provider_health.last_observation_at),
       failure_reason = excluded.failure_reason`,
    [provider, attemptedAt, successAt, observationAt, failureReason],
  );
}

export type ProviderHealthRow = {
  provider: Provider;
  lastAttemptAt: number;
  lastSuccessAt: number | null;
  lastObservationAt: number | null;
  failureReason: string | null;
};

export function getProviderHealth(db: Database, provider: Provider): ProviderHealthRow | null {
  return (db.query(
    `SELECT provider, last_attempt_at AS lastAttemptAt, last_success_at AS lastSuccessAt,
            last_observation_at AS lastObservationAt, failure_reason AS failureReason
     FROM provider_health WHERE provider = ?`,
  ).get(provider) as ProviderHealthRow | undefined) ?? null;
}

/** Delete rows in a captured_at-indexed history table older than
 * `now - retentionMs`, but always keep the most-recent row per provider so a
 * provider that hasn't polled recently never loses its latest known state
 * (that latest row is what every "getLatest*" read and the staleness rule
 * depend on). Returns the number of rows deleted. */
function pruneHistoryTable(db: Database, table: string, retentionMs: number, now: number): number {
  const cutoff = now - retentionMs;
  const result = db.run(
    `DELETE FROM ${table}
     WHERE captured_at < ?
       AND id NOT IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY provider ORDER BY captured_at DESC) AS rn
           FROM ${table}
         ) WHERE rn = 1
       )`,
    [cutoff],
  );
  return result.changes;
}

/** Prune both history tables (`snapshots`, `reset_credits`) to the retention
 * window. A `null` window disables pruning. Best-effort at the call site (the
 * poll loop guards it) — this only runs SQL and returns per-table deletion
 * counts. */
export function pruneHistory(
  db: Database,
  retentionMs: number | null,
  now: number = Date.now(),
): { snapshots: number; resetCredits: number; lifecycleMarkers: number } {
  if (retentionMs === null) return { snapshots: 0, resetCredits: 0, lifecycleMarkers: 0 };
  const markerCutoff = now - retentionMs;
  return {
    snapshots: pruneHistoryTable(db, "snapshots", retentionMs, now),
    resetCredits: pruneHistoryTable(db, "reset_credits", retentionMs, now),
    lifecycleMarkers: db.run(
      "DELETE FROM lifecycle_markers WHERE occurred_at < ?",
      [markerCutoff],
    ).changes,
  };
}

export function getManualEntries(db: Database, provider: Provider): ManualEntry[] {
  const rows = db
    .query(
      `SELECT provider, field, value, note, updated_at as updatedAt FROM manual_entries WHERE provider = ?`,
    )
    .all(provider) as ManualEntry[];
  return rows;
}
