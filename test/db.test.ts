import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  getLatestResetCredits,
  getLatestSnapshot,
  pruneHistory,
  saveResetCredits,
  saveSnapshot,
} from "../src/db";
import type { CollectorResult, Provider, ResetCreditsResult } from "../src/types";

const DAY_MS = 24 * 60 * 60 * 1000;

function testDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      data_as_of INTEGER,
      captured_at INTEGER NOT NULL,
      snapshot_json TEXT,
      error TEXT
    );
    CREATE TABLE reset_credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      available_count INTEGER,
      total_earned_count INTEGER,
      credits_json TEXT,
      error TEXT
    );
  `);
  return db;
}

function snapshotAt(provider: Provider, capturedAt: number): CollectorResult {
  return { provider, status: "ok", source: `${provider}_test`, dataAsOf: capturedAt, capturedAt, snapshot: null };
}

function resetCreditsAt(provider: Provider, capturedAt: number): ResetCreditsResult {
  return { provider, status: "ok", capturedAt, availableCount: 1, totalEarnedCount: 1, credits: [] };
}

function snapshotCount(db: Database): number {
  return (db.query("SELECT COUNT(*) AS c FROM snapshots").get() as { c: number }).c;
}

test("pruneHistory drops rows older than retention but keeps the latest per provider", () => {
  const db = testDb();
  const now = Date.now();
  const retentionMs = 90 * DAY_MS;

  // codex: one stale row (deletable) + one fresh row (the latest)
  saveSnapshot(db, snapshotAt("codex", now - 100 * DAY_MS));
  saveSnapshot(db, snapshotAt("codex", now - 1 * DAY_MS));
  // anthropic: a single very old row — older than the window, but it is the
  // provider's only/latest known state and must survive.
  saveSnapshot(db, snapshotAt("anthropic", now - 200 * DAY_MS));
  // warp: two rows, both older than the window; only the newer one is kept.
  saveSnapshot(db, snapshotAt("warp", now - 99 * DAY_MS));
  saveSnapshot(db, snapshotAt("warp", now - 95 * DAY_MS));

  expect(snapshotCount(db)).toBe(5);
  const deleted = pruneHistory(db, retentionMs, now);
  expect(deleted.snapshots).toBe(2); // codex@-100d and warp@-99d

  expect(snapshotCount(db)).toBe(3);
  // Every provider still has its latest row available, even anthropic's ancient one.
  expect(getLatestSnapshot(db, "codex")?.capturedAt).toBe(now - 1 * DAY_MS);
  expect(getLatestSnapshot(db, "anthropic")?.capturedAt).toBe(now - 200 * DAY_MS);
  expect(getLatestSnapshot(db, "warp")?.capturedAt).toBe(now - 95 * DAY_MS);
  db.close();
});

test("pruneHistory prunes reset_credits with the same latest-per-provider guarantee", () => {
  const db = testDb();
  const now = Date.now();
  const retentionMs = 90 * DAY_MS;

  saveResetCredits(db, resetCreditsAt("codex", now - 120 * DAY_MS));
  saveResetCredits(db, resetCreditsAt("codex", now - 2 * DAY_MS));

  const deleted = pruneHistory(db, retentionMs, now);
  expect(deleted.resetCredits).toBe(1);
  const count = (db.query("SELECT COUNT(*) AS c FROM reset_credits").get() as { c: number }).c;
  expect(count).toBe(1);
  expect(getLatestResetCredits(db, "codex")?.capturedAt).toBe(now - 2 * DAY_MS);
  db.close();
});

test("pruneHistory is a no-op when everything is within the window", () => {
  const db = testDb();
  const now = Date.now();
  saveSnapshot(db, snapshotAt("codex", now - 1 * DAY_MS));
  saveSnapshot(db, snapshotAt("codex", now - 2 * DAY_MS));
  const deleted = pruneHistory(db, 90 * DAY_MS, now);
  expect(deleted.snapshots).toBe(0);
  expect(snapshotCount(db)).toBe(2);
  db.close();
});
