// Orchestrates running collectors and persisting results, honoring each
// provider's polite-polling floor. Used by both the on-demand CLI
// (collect-on-query) and the foreground server's poll loop.

import type { Database } from "bun:sqlite";
import { getLatestSnapshot, saveResetCredits, saveSnapshot } from "./db";
import { collectAnthropic, ANTHROPIC_POLL_FLOOR_MS } from "./collectors/anthropic";
import { collectCodexFromApi, collectCodexResetCredits } from "./collectors/codex";
import { collectWarp } from "./collectors/warp";
import type { CollectorResult, Provider } from "./types";

/** CodexBar-style politeness floor for Codex's undocumented network path; the file tactic has no floor. */
const CODEX_API_POLL_FLOOR_MS = 60_000;

function isWithinFloor(db: Database, provider: Provider, floorMs: number): boolean {
  const latest = getLatestSnapshot(db, provider);
  if (!latest) return false;
  return Date.now() - latest.capturedAt < floorMs;
}

export async function collectCodexAndSave(db: Database, opts: { force?: boolean } = {}): Promise<CollectorResult> {
  if (!opts.force && isWithinFloor(db, "codex", CODEX_API_POLL_FLOOR_MS)) {
    return getLatestSnapshot(db, "codex")!;
  }
  const result = await collectCodexFromApi();
  saveSnapshot(db, result);
  // Reset credits share the same auth + politeness floor; fetch alongside.
  const resetCredits = await collectCodexResetCredits();
  saveResetCredits(db, resetCredits);
  return result;
}

export async function collectAnthropicAndSave(db: Database, opts: { force?: boolean } = {}): Promise<CollectorResult> {
  if (!opts.force && isWithinFloor(db, "anthropic", ANTHROPIC_POLL_FLOOR_MS)) {
    return getLatestSnapshot(db, "anthropic")!;
  }
  const result = await collectAnthropic();
  saveSnapshot(db, result);
  return result;
}

export async function collectWarpAndSave(db: Database): Promise<CollectorResult> {
  // Cheap local read; no floor needed.
  const result = await collectWarp();
  saveSnapshot(db, result);
  return result;
}

export async function collectAll(
  db: Database,
  opts: { force?: boolean } = {},
): Promise<Record<Provider, CollectorResult>> {
  const [codex, anthropic, warp] = await Promise.all([
    collectCodexAndSave(db, opts),
    collectAnthropicAndSave(db, opts),
    collectWarpAndSave(db),
  ]);
  return { codex, anthropic, warp };
}
