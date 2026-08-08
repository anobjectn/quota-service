import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CollectorResult,
  ManualEntry,
  Provider,
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
  const row = db
    .query(
      `SELECT provider, status, source, data_as_of as dataAsOf, captured_at as capturedAt, snapshot_json as snapshotJson, error
       FROM snapshots WHERE provider = ? ORDER BY captured_at DESC LIMIT 1`,
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
): { snapshots: number; resetCredits: number } {
  if (retentionMs === null) return { snapshots: 0, resetCredits: 0 };
  return {
    snapshots: pruneHistoryTable(db, "snapshots", retentionMs, now),
    resetCredits: pruneHistoryTable(db, "reset_credits", retentionMs, now),
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
