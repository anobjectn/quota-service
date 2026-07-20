import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { collectAll, type CollectorRunners } from "../src/collect";
import { saveSnapshot } from "../src/db";
import type { CollectorResult, Provider } from "../src/types";

function result(provider: Provider): CollectorResult {
  return {
    provider,
    status: "ok",
    source: `${provider}_test`,
    dataAsOf: Date.now(),
    capturedAt: Date.now(),
    snapshot: null,
  };
}

test("collectAll invokes only enabled collectors and preserves configured ordering", async () => {
  const calls: Provider[] = [];
  const runner = (provider: Provider) => async () => {
    calls.push(provider);
    return result(provider);
  };
  const runners: CollectorRunners = {
    codex: runner("codex"),
    anthropic: runner("anthropic"),
    warp: runner("warp"),
  };

  const collected = await collectAll({} as Database, {}, ["warp", "codex"], runners);

  expect(calls).toEqual(["warp", "codex"]);
  expect(Object.keys(collected)).toEqual(["warp", "codex"]);
  expect(collected.anthropic).toBeUndefined();
});

test("concurrent polls share one provider result and persist it once", async () => {
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
    )
  `);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const codexResult = result("codex");
  const codex = async () => {
    calls++;
    await gate;
    saveSnapshot(db, codexResult);
    return codexResult;
  };
  const runners: CollectorRunners = {
    codex,
    anthropic: async () => result("anthropic"),
    warp: async () => result("warp"),
  };

  const first = collectAll(db, {}, ["codex"], runners);
  const second = collectAll(db, {}, ["codex"], runners);
  await Promise.resolve();
  expect(calls).toBe(1);
  release();
  await Promise.all([first, second]);

  const row = db.query("SELECT COUNT(*) AS count FROM snapshots").get() as { count: number };
  expect(row.count).toBe(1);
  db.close();
});
