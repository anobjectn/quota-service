import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { saveSnapshot } from "../src/db";
import { buildUsageReport } from "../src/present";
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
