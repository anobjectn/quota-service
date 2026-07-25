import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "./types";

export const ALL_PROVIDERS = ["codex", "anthropic", "warp"] as const satisfies readonly Provider[];
export const DEFAULT_PROVIDERS = ["codex", "anthropic"] as const satisfies readonly Provider[];

const REPO_ENV_PATH = join(import.meta.dir, "..", ".env");

/** Load the repository-local environment without overriding exported values. */
function loadRepoEnv(path = REPO_ENV_PATH): void {
  if (!existsSync(path)) return;
  for (const originalLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().replace(/^export\s+/, "");
    if (!key || process.env[key] !== undefined) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadRepoEnv();

export function isProvider(value: string): value is Provider {
  return (ALL_PROVIDERS as readonly string[]).includes(value);
}

export function parseEnabledProviders(raw: string | undefined): Provider[] {
  if (raw === undefined) return [...DEFAULT_PROVIDERS];
  if (raw.trim() === "") {
    throw new Error("Invalid QUOTA_PROVIDERS: expected a non-empty comma-separated provider list");
  }

  const values = raw.split(",").map((value) => value.trim());
  if (values.some((value) => value === "")) {
    throw new Error("Invalid QUOTA_PROVIDERS: empty provider entries are not allowed");
  }

  const seen = new Set<string>();
  const providers: Provider[] = [];
  for (const value of values) {
    if (!isProvider(value)) {
      throw new Error(`Invalid QUOTA_PROVIDERS: unknown provider "${value}"; expected codex, anthropic, or warp`);
    }
    if (seen.has(value)) {
      throw new Error(`Invalid QUOTA_PROVIDERS: duplicate provider "${value}"`);
    }
    seen.add(value);
    providers.push(value);
  }
  return providers;
}

export const ENABLED_PROVIDERS: readonly Provider[] = Object.freeze(
  parseEnabledProviders(process.env.QUOTA_PROVIDERS),
);

export function requireEnabledProvider(
  value: string,
  enabledProviders: readonly Provider[] = ENABLED_PROVIDERS,
): Provider {
  if (!isProvider(value)) throw new Error(`unknown provider "${value}"`);
  if (!enabledProviders.includes(value)) throw new Error(`provider "${value}" is disabled by QUOTA_PROVIDERS`);
  return value;
}

/** History retention window in days. Snapshots/reset-credit rows older than
 * this are pruned on the poll cycle (the latest row per provider is always
 * kept regardless of age — see `pruneHistory`). The default is intentionally
 * generous: the AIUO consumer's "window reached 100%" history and banked-reset
 * consumption inference read retained rows, so lowering this shortens the
 * consumer's visible history. */
export const DEFAULT_RETENTION_DAYS = 90;

export function parseRetentionDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid QUOTA_RETENTION_DAYS: expected a positive number of days, got "${raw}"`);
  }
  return parsed;
}

export const RETENTION_DAYS = parseRetentionDays(process.env.QUOTA_RETENTION_DAYS);
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
