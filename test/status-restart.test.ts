import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { saveLifecycleMarker, saveSnapshot } from "../src/db";
import { buildServiceStatus } from "../src/status";
import {
  authorizeRestart,
  buildSuccessorCommand,
  isLoopbackAddress,
  restartStrategy,
  selfOrigins,
} from "../src/restart";
import type { CollectorResult } from "../src/types";

function testDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, status TEXT NOT NULL,
      source TEXT NOT NULL, data_as_of INTEGER, captured_at INTEGER NOT NULL,
      snapshot_json TEXT, error TEXT
    );
    CREATE TABLE provider_health (
      provider TEXT PRIMARY KEY, last_attempt_at INTEGER NOT NULL, last_success_at INTEGER,
      last_observation_at INTEGER, failure_reason TEXT
    );
    CREATE TABLE lifecycle_markers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, session_id TEXT NOT NULL,
      event TEXT NOT NULL, occurred_at INTEGER NOT NULL, source TEXT NOT NULL,
      created_at INTEGER NOT NULL, UNIQUE(provider, session_id, event, occurred_at)
    );
  `);
  return db;
}

describe("service status detail", () => {
  test("reports process identity, listener, retention, and marker health", () => {
    const db = testDb();
    const now = 1_000_000;
    const snapshot: CollectorResult = {
      provider: "anthropic", status: "ok", source: "anthropic_api",
      dataAsOf: now - 60_000, capturedAt: now - 60_000,
      snapshot: { kind: "window", fiveHour: { usedPercent: 4, resetsAt: now + 3_600_000 }, weekly: null, extra: {} },
    };
    saveSnapshot(db, snapshot);
    saveLifecycleMarker(db, {
      provider: "anthropic", sessionId: "session-1", event: "session_start",
      occurredAt: now - 30_000, source: "claude_hook",
    });

    const status = buildServiceStatus({
      pollMs: 300_000,
      enabledProviders: ["anthropic"],
      uptimeMs: 120_000,
      db,
      listen: { host: "127.0.0.1", port: 8787 },
      now,
    });

    expect(status.pid).toBe(process.pid);
    expect(status.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(status.startedAt).toBe(now - 120_000);
    expect(status.listen).toEqual({ host: "127.0.0.1", port: 8787 });
    expect(status.retention?.mode).toBe(status.retention?.days === null ? "forever" : "days");
    expect(status.markers).toEqual({ count: 1, lastOccurredAt: now - 30_000 });
    expect(status.providers?.[0]).toMatchObject({ provider: "anthropic", freshness: "current" });
    db.close();
  });

  test("still answers when the database predates the lifecycle marker table", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, status TEXT NOT NULL,
      source TEXT NOT NULL, data_as_of INTEGER, captured_at INTEGER NOT NULL,
      snapshot_json TEXT, error TEXT
    );
    CREATE TABLE provider_health (
      provider TEXT PRIMARY KEY, last_attempt_at INTEGER NOT NULL, last_success_at INTEGER,
      last_observation_at INTEGER, failure_reason TEXT
    );`);
    const status = buildServiceStatus({ pollMs: 1_000, enabledProviders: ["codex"], db });
    expect(status.ok).toBe(true);
    expect(status.markers).toBeUndefined();
    expect(status.providers?.[0]?.freshness).toBe("unavailable");
    db.close();
  });
});

describe("restart authorization", () => {
  const origins = selfOrigins("127.0.0.1", 8787);

  test("accepts a confirmed same-origin request from loopback", () => {
    expect(authorizeRestart({
      peerAddress: "127.0.0.1", confirmHeader: "1",
      origin: "http://127.0.0.1:8787", selfOrigins: origins,
    })).toEqual({ ok: true });
  });

  test("refuses a peer that is not on loopback", () => {
    expect(authorizeRestart({
      peerAddress: "100.64.0.7", confirmHeader: "1", origin: null, selfOrigins: origins,
    })).toMatchObject({ ok: false, status: 403 });
  });

  test("requires the confirmation header that forces a browser preflight", () => {
    expect(authorizeRestart({
      peerAddress: "127.0.0.1", confirmHeader: null, origin: null, selfOrigins: origins,
    })).toMatchObject({ ok: false, status: 400 });
  });

  test("refuses a cross-origin page that reached the handler anyway", () => {
    expect(authorizeRestart({
      peerAddress: "127.0.0.1", confirmHeader: "1",
      origin: "https://example.com", selfOrigins: origins,
    })).toMatchObject({ ok: false, status: 403 });
  });

  test("recognizes loopback in its IPv4, IPv6, and mapped forms", () => {
    expect(["127.0.0.1", "127.0.1.5", "::1", "::ffff:127.0.0.1", "localhost"].map(isLoopbackAddress))
      .toEqual([true, true, true, true, true]);
    expect(["100.64.0.7", "", null, undefined].map(isLoopbackAddress))
      .toEqual([false, false, false, false]);
  });
});

describe("restart mechanics", () => {
  test("defers to a supervisor instead of spawning a competing successor", () => {
    expect(restartStrategy({ XPC_SERVICE_NAME: "com.example.quota-service" })).toBe("supervisor");
    expect(restartStrategy({ QUOTA_SUPERVISED: "1" })).toBe("supervisor");
    expect(restartStrategy({ XPC_SERVICE_NAME: "0" })).toBe("respawn");
    expect(restartStrategy({})).toBe("respawn");
  });

  test("orphans the successor and quotes paths that contain spaces", () => {
    const [shell, flag, script] = buildSuccessorCommand({
      execPath: "/opt/homebrew/bin/bun",
      argv: ["/Users/someone/my quota-service/src/server.ts", "--port", "8787"],
      logDir: "/Users/someone/.quota-service",
      delayMs: 500,
    });
    expect([shell, flag]).toEqual(["/bin/sh", "-c"]);
    expect(script).toContain("'/Users/someone/my quota-service/src/server.ts'");
    expect(script).toContain("sleep 0.50");
    expect(script).toContain("'/Users/someone/.quota-service/quota-service.out.log'");
    expect(script?.trimEnd().endsWith("&")).toBe(true);
  });
});
