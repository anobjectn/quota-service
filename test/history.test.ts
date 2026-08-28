import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getLifecycleMarkers, pruneHistory, saveLifecycleMarker, saveSnapshot, setPlanAssignment } from "../src/db";
import { buildHistoryResponse, HistoryRequestError } from "../src/history";
import type { CollectorResult, Provider } from "../src/types";

function testDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, status TEXT NOT NULL,
      source TEXT NOT NULL, data_as_of INTEGER, captured_at INTEGER NOT NULL,
      snapshot_json TEXT, error TEXT
    );
    CREATE TABLE reset_credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, status TEXT NOT NULL,
      captured_at INTEGER NOT NULL, available_count INTEGER, total_earned_count INTEGER,
      credits_json TEXT, error TEXT
    );
    CREATE TABLE manual_entries (
      provider TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, note TEXT,
      updated_at INTEGER NOT NULL, PRIMARY KEY (provider, field)
    );
    CREATE TABLE plan_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, plan_id TEXT NOT NULL,
      plan_label TEXT NOT NULL, effective_from INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE lifecycle_markers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, session_id TEXT NOT NULL,
      event TEXT NOT NULL, occurred_at INTEGER NOT NULL, source TEXT NOT NULL,
      created_at INTEGER NOT NULL, UNIQUE(provider, session_id, event, occurred_at)
    );
  `);
  return db;
}

function windowResult(provider: Provider, observedAt: number, capturedAt = observedAt): CollectorResult {
  return {
    provider,
    status: "ok",
    source: provider === "codex" ? "codex_file" : "anthropic_api",
    dataAsOf: observedAt,
    capturedAt,
    snapshot: {
      kind: "window",
      fiveHour: { usedPercent: 12.5, resetsAt: 1_789_000_000_000 },
      weekly: null,
      extra: provider === "codex" ? { planType: "plus" } : {},
    },
  };
}

function params(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams(values);
}

describe("normalized quota history", () => {
  test("preserves observed time, fractional windows, cycle identity, and provider plan", () => {
    const db = testDb();
    saveSnapshot(db, windowResult("codex", 1_000, 9_000));
    const result = buildHistoryResponse(db, params({ provider: "codex", from: "0", to: "10000" }), ["codex"]);

    expect(result.historyVersion).toBe(1);
    expect(result.earliestObservationAt).toBe(1_000);
    expect(result.retentionMode).toBe("forever");
    expect(result.observations[0]).toMatchObject({
      capturedAt: 9_000,
      observedAt: 1_000,
      timeSource: "source_mtime",
      plan: { id: "plus", source: "provider" },
      quota: {
        kind: "windows",
        windows: [{ id: "fiveHour", usedPercent: 12.5, cycleId: "reset:1788999960000" }],
      },
    });
    db.close();
  });

  test("pins a row-ID history version across keyset pages", () => {
    const db = testDb();
    saveSnapshot(db, windowResult("codex", 1_000));
    saveSnapshot(db, windowResult("codex", 2_000));
    const first = buildHistoryResponse(db, params({ provider: "codex", from: "0", to: "10000", limit: "1" }), ["codex"]);
    expect(first.nextCursor).not.toBeNull();
    saveSnapshot(db, windowResult("codex", 1_500));

    const second = buildHistoryResponse(db, params({
      provider: "codex", from: "0", to: "10000", limit: "1", cursor: first.nextCursor!,
    }), ["codex"]);
    expect(second.historyVersion).toBe(first.historyVersion);
    expect(second.observations.map((row) => row.observedAt)).toEqual([2_000]);
    db.close();
  });

  test("uses effective-dated configured plans without relabeling earlier observations", () => {
    const db = testDb();
    saveSnapshot(db, windowResult("anthropic", 1_000));
    saveSnapshot(db, windowResult("anthropic", 3_000));
    setPlanAssignment(db, {
      provider: "anthropic", planId: "max-5x", planLabel: "Claude Max 5x", effectiveFrom: 2_000,
    }, 2_100);
    const result = buildHistoryResponse(db, params({ provider: "anthropic", from: "0", to: "4000" }), ["anthropic"]);
    expect(result.observations.map((row) => row.plan.source)).toEqual(["unknown", "configured"]);
    expect(result.observations[1]!.plan).toMatchObject({ id: "max-5x", effectiveFrom: 2_000 });
    db.close();
  });

  test("preserves Warp units and rejects conflicting stored percentages", () => {
    const db = testDb();
    const result: CollectorResult = {
      provider: "warp", status: "ok", source: "warp_plist", dataAsOf: 1_000, capturedAt: 2_000,
      snapshot: {
        kind: "pool",
        pool: { used: 1_097, limit: 1_500, usedPercent: 73.1, refreshesAt: 4_000, cadence: "Monthly" },
      },
    };
    saveSnapshot(db, result);
    const history = buildHistoryResponse(db, params({ provider: "warp", from: "0", to: "3000" }), ["warp"]);
    expect(history.observations[0]!.quota).toMatchObject({
      kind: "pool",
      pool: { usedUnits: 1_097, limitUnits: 1_500, unit: "warp_credit", unitSource: "provider_docs_and_local_schema" },
    });

    saveSnapshot(db, { ...result, capturedAt: 3_000, dataAsOf: 2_000, snapshot: { ...result.snapshot!, pool: { ...(result.snapshot as any).pool, usedPercent: 60 } } } as CollectorResult);
    expect(() => buildHistoryResponse(db, params({ provider: "warp", from: "0", to: "4000" }), ["warp"]))
      .toThrow(HistoryRequestError);
    db.close();
  });

  test("validates the bounded request", () => {
    const db = testDb();
    expect(() => buildHistoryResponse(db, params({ provider: "codex", from: "0", to: String(32 * 86_400_000) }), ["codex"]))
      .toThrow("31 days");
    expect(() => buildHistoryResponse(db, params({ provider: "codex", from: "0", to: "1", limit: "5001" }), ["codex"]))
      .toThrow("5000");
    db.close();
  });
});

test("lifecycle markers are content-free, deduplicated, and follow finite retention", () => {
  const db = testDb();
  const marker = { provider: "anthropic", sessionId: "session-1", event: "session_start", occurredAt: 1_000, source: "claude_hook" } as const;
  saveLifecycleMarker(db, marker);
  saveLifecycleMarker(db, marker);
  expect(getLifecycleMarkers(db, 0, 2_000)).toEqual([marker]);
  expect(pruneHistory(db, 500, 2_000).lifecycleMarkers).toBe(1);
  expect(getLifecycleMarkers(db, 0, 2_000)).toEqual([]);
  db.close();
});
