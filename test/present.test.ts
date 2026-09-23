import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
      provider TEXT NOT NULL, status TEXT NOT NULL, captured_at INTEGER NOT NULL,
      available_count INTEGER, total_earned_count INTEGER, credits_json TEXT, error TEXT
    );
    CREATE TABLE manual_entries (
      provider TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, note TEXT,
      updated_at INTEGER NOT NULL, PRIMARY KEY (provider, field)
    );
  `);
  return db;
}

// The API boundary must transmit raw universal units — epoch ms and durations
// as numbers — with all localization/formatting left to the CLI/UI. This locks
// that contract so a future refactor can't accidentally preformat a date string.
test("buildUsageReport emits numeric epoch/duration fields, never preformatted strings", () => {
  const db = testDb();
  const now = Date.now();
  const result: CollectorResult = {
    provider: "anthropic",
    status: "ok",
    source: "anthropic_api",
    dataAsOf: now - 5_000,
    capturedAt: now - 5_000,
    snapshot: {
      kind: "window",
      fiveHour: { usedPercent: 20, resetsAt: now + 3_600_000 },
      weekly: { usedPercent: 30, resetsAt: now + 86_400_000 },
    },
  };
  saveSnapshot(db, result);

  const report = buildUsageReport(db, ["anthropic"]);
  expect(typeof report.generatedAt).toBe("number");
  const provider = report.providers[0]!;
  expect(typeof provider.capturedAt).toBe("number");
  expect(typeof provider.dataAgeMs).toBe("number");
  const snapshot = provider.snapshot!;
  expect(snapshot.kind).toBe("window");
  if (snapshot.kind === "window") {
    expect(typeof snapshot.fiveHour!.resetsAt).toBe("number");
    expect(typeof snapshot.weekly!.resetsAt).toBe("number");
  }
  db.close();
});

function anthropicRow(capturedAt: number, overrides: Partial<CollectorResult> = {}): CollectorResult {
  return {
    provider: "anthropic",
    status: "ok",
    source: "anthropic_api",
    dataAsOf: capturedAt,
    capturedAt,
    snapshot: {
      kind: "window",
      fiveHour: { usedPercent: 42, resetsAt: capturedAt + 3_600_000 },
      weekly: { usedPercent: 61, resetsAt: capturedAt + 86_400_000 },
    },
    ...overrides,
  };
}

function rateLimited(capturedAt: number): CollectorResult {
  return anthropicRow(capturedAt, {
    status: "unavailable",
    dataAsOf: null,
    snapshot: null,
    error: "oauth/usage HTTP 429",
  });
}

test("a failed newest attempt serves the last reading as stale with its real age", () => {
  const db = testDb();
  const now = Date.now();
  const goodAt = now - 18 * 60_000;
  saveSnapshot(db, anthropicRow(goodAt));
  saveSnapshot(db, rateLimited(now - 7 * 60_000));
  saveSnapshot(db, rateLimited(now - 60_000));

  const provider = buildUsageReport(db, ["anthropic"]).providers[0]!;

  expect(provider.status).toBe("stale");
  expect(provider.servingLastGood).toBe(true);
  expect(provider.capturedAt).toBe(goodAt);
  expect(provider.lastAttemptAt).toBe(now - 60_000);
  expect(provider.dataAgeMs).toBeGreaterThanOrEqual(18 * 60_000);
  expect(provider.error).toBe("oauth/usage HTTP 429");
  expect(provider.snapshot?.kind === "window" && provider.snapshot.fiveHour?.usedPercent).toBe(42);
  db.close();
});

test("a failed attempt with no earlier reading still reports no values", () => {
  const db = testDb();
  saveSnapshot(db, rateLimited(Date.now() - 60_000));

  const provider = buildUsageReport(db, ["anthropic"]).providers[0]!;

  expect(provider.status).toBe("unavailable");
  expect(provider.servingLastGood).toBe(false);
  expect(provider.snapshot).toBeNull();
  db.close();
});

test("the resets report keeps the last known windows when the newest attempt failed", () => {
  const db = testDb();
  const now = Date.now();
  saveSnapshot(db, anthropicRow(now - 10 * 60_000));
  saveSnapshot(db, rateLimited(now - 60_000));

  const report = buildResetsReport(db, ["anthropic"]);

  expect(report.windows.map((window) => window.window)).toEqual(["fiveHour", "weekly"]);
  expect(report.windows[0]!.capturedAt).toBe(now - 10 * 60_000);
  db.close();
});
