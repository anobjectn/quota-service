import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RETENTION_DAYS,
  parseEnabledProviders,
  parseRetentionDays,
  requireEnabledProvider,
} from "../src/config";
import { buildServiceStatus } from "../src/status";

describe("provider configuration", () => {
  test("defaults to Codex and Anthropic", () => {
    expect(parseEnabledProviders(undefined)).toEqual(["codex", "anthropic"]);
  });

  test("trims entries and preserves ordering", () => {
    expect(parseEnabledProviders(" warp, codex ,anthropic ")).toEqual(["warp", "codex", "anthropic"]);
  });

  test.each([
    ["", "non-empty"],
    ["codex,", "empty provider"],
    ["codex,codex", "duplicate provider"],
    ["codex,other", "unknown provider"],
  ])("rejects invalid value %p", (raw, expectedMessage) => {
    expect(() => parseEnabledProviders(raw)).toThrow(expectedMessage);
  });

  test("distinguishes unknown and disabled manual-entry providers", () => {
    expect(() => requireEnabledProvider("other", ["codex"])).toThrow('unknown provider "other"');
    expect(() => requireEnabledProvider("warp", ["codex"])).toThrow('provider "warp" is disabled');
    expect(requireEnabledProvider("codex", ["codex"])).toBe("codex");
  });

  test("status exposes enabled providers in configured order", () => {
    expect(buildServiceStatus({ pollMs: 300_000, enabledProviders: ["warp", "codex"], uptimeMs: 1_000 }))
      .toMatchObject({
        ok: true,
        uptimeMs: 1_000,
        pollMs: 300_000,
        enabledProviders: ["warp", "codex"],
      });
  });
});

describe("retention configuration", () => {
  test("preserves all history by default when unset or blank", () => {
    expect(parseRetentionDays(undefined)).toBe(DEFAULT_RETENTION_DAYS);
    expect(parseRetentionDays("  ")).toBe(DEFAULT_RETENTION_DAYS);
    expect(DEFAULT_RETENTION_DAYS).toBeNull();
  });

  test("accepts a positive number of days to opt into periodic pruning", () => {
    expect(parseRetentionDays("365")).toBe(365);
  });

  test('accepts "forever" to disable automatic pruning', () => {
    expect(parseRetentionDays(" forever ")).toBeNull();
  });

  test.each(["0", "-1", "never", "NaN"])("rejects invalid value %p", (raw) => {
    expect(() => parseRetentionDays(raw)).toThrow('positive number of days or "forever"');
  });
});

describe("entrypoint startup validation", () => {
  for (const entrypoint of ["src/server.ts", "src/mcp.ts", "src/cli.ts"]) {
    test(`${entrypoint} exits before startup for invalid configuration`, async () => {
      const proc = Bun.spawn([process.execPath, "run", entrypoint, "help"], {
        cwd: import.meta.dir + "/..",
        env: { ...process.env, QUOTA_PROVIDERS: "codex,unknown" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Invalid QUOTA_PROVIDERS: unknown provider "unknown"');
    });
  }
});
