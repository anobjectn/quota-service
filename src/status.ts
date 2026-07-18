import { ENABLED_PROVIDERS } from "./config";
import type { Provider } from "./types";

export interface ServiceStatus {
  ok: true;
  uptimeMs: number;
  pollMs: number;
  enabledProviders: readonly Provider[];
}

export function buildServiceStatus(
  pollMs: number,
  enabledProviders: readonly Provider[] = ENABLED_PROVIDERS,
  uptimeMs = process.uptime() * 1000,
): ServiceStatus {
  return { ok: true, uptimeMs, pollMs, enabledProviders };
}
