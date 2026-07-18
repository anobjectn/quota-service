import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { collectAll, type CollectorRunners } from "../src/collect";
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
