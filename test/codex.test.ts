import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import apiFixture from "./fixtures/codex-api-weekly-only.json";
import fileFixture from "./fixtures/codex-file-weekly-only.json";
import {
  annotateFileFallback,
  toWindowSnapshotFromFile,
  toWindowSnapshotFromWham,
} from "../src/collectors/codex";
import { saveSnapshot } from "../src/db";
import { buildResetsReport, buildUsageReport } from "../src/present";
import type { CollectorResult } from "../src/types";

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
    CREATE TABLE manual_entries (
      provider TEXT NOT NULL,
      field TEXT NOT NULL,
      value TEXT NOT NULL,
      note TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, field)
    );
  `);
  return db;
}

test("file fallback classifies a lone seven-day primary window as weekly", () => {
  const snapshot = toWindowSnapshotFromFile(fileFixture.rate_limits);

  expect(snapshot.fiveHour).toBeNull();
  expect(snapshot.weekly).toEqual({
    usedPercent: 86,
    resetsAt: 1_784_981_120_000,
  });
});

test("file fallback leaves an ambiguous-duration window unclassified", () => {
  const snapshot = toWindowSnapshotFromFile({
    primary: { used_percent: 86, window_minutes: 1440, resets_at: 1_784_981_120 },
  });

  expect(snapshot.fiveHour).toBeNull();
  expect(snapshot.weekly).toBeNull();
});

test("file and API tactics normalize equivalent windows consistently", () => {
  const fromFile = toWindowSnapshotFromFile(fileFixture.rate_limits);
  const fromApi = toWindowSnapshotFromWham(apiFixture);

  expect({ fiveHour: fromFile.fiveHour, weekly: fromFile.weekly }).toEqual({
    fiveHour: fromApi.fiveHour,
    weekly: fromApi.weekly,
  });
});

test("normalizes OpenAI account credits without treating them as currency", () => {
  const snapshot = toWindowSnapshotFromWham({
    ...apiFixture,
    credits: { has_credits: true, unlimited: false, balance: "1250" },
  });

  expect(snapshot.codexCredits).toEqual({
    hasCredits: true,
    unlimited: false,
    balance: 1250,
  });
  expect(snapshot.extra?.credits).toEqual({
    has_credits: true,
    unlimited: false,
    balance: "1250",
  });
});

test("degraded file result preserves warning and weekly semantics through reports", () => {
  const capturedAt = Date.now();
  const fileResult: CollectorResult = {
    provider: "codex",
    status: "ok",
    source: "codex_file",
    dataAsOf: capturedAt,
    capturedAt,
    snapshot: toWindowSnapshotFromFile(fileFixture.rate_limits),
  };
  const result = annotateFileFallback(fileResult, "The operation timed out.");
  const db = testDb();
  saveSnapshot(db, result);

  const usage = buildUsageReport(db, ["codex"]).providers[0]!;
  expect(usage.error).toBe("api tactic failed (The operation timed out.), degraded to file tactic");
  expect(usage.snapshot?.kind === "window" && usage.snapshot.fiveHour).toBeNull();
  expect(usage.snapshot?.kind === "window" && usage.snapshot.weekly).toEqual({
    usedPercent: 86,
    resetsAt: 1_784_981_120_000,
  });
  expect(buildResetsReport(db, ["codex"]).windows).toEqual([
    {
      provider: "codex",
      window: "weekly",
      usedPercent: 86,
      resetsAt: 1_784_981_120_000,
    },
  ]);
  db.close();
});

test("saving one polling result twice persists one snapshot", () => {
  const capturedAt = Date.now();
  const result: CollectorResult = {
    provider: "codex",
    status: "ok",
    source: "codex_file",
    dataAsOf: capturedAt,
    capturedAt,
    snapshot: toWindowSnapshotFromFile(fileFixture.rate_limits),
  };
  const db = testDb();

  saveSnapshot(db, result);
  saveSnapshot(db, result);

  const row = db.query("SELECT COUNT(*) AS count FROM snapshots").get() as { count: number };
  expect(row.count).toBe(1);
  db.close();
});
