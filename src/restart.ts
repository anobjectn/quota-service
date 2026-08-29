// Self-restart support for the dashboard's "Restart service" button.
//
// Restarting is the one action here that ends the process serving the request,
// so the guards matter more than the mechanics: only a loopback peer may ask,
// a custom header is required (which forces a CORS preflight this server never
// answers, so no other site in the browser can trigger it), and a same-origin
// check rejects anything a page on another origin managed to send anyway.

import { join } from "node:path";

export type RestartStrategy = "respawn" | "supervisor";

const LOOPBACK_NAMES = new Set(["localhost", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const value = address.trim().toLowerCase();
  if (LOOPBACK_NAMES.has(value)) return true;
  return value.startsWith("127.") || value.startsWith("::ffff:127.");
}

/** launchd (and any other supervisor that sets these) restarts the job itself,
 * so spawning a successor there would race two processes for the port. */
export function restartStrategy(env: Record<string, string | undefined> = process.env): RestartStrategy {
  if (env.QUOTA_SUPERVISED === "1") return "supervisor";
  return env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME !== "0" ? "supervisor" : "respawn";
}

export function selfOrigins(host: string, port: number): string[] {
  const hosts = new Set([host, "127.0.0.1", "localhost"]);
  return [...hosts].map((value) => `http://${value.includes(":") ? `[${value}]` : value}:${port}`);
}

export type RestartDecision = { ok: true } | { ok: false; status: number; error: string };

export function authorizeRestart(input: {
  peerAddress: string | null | undefined;
  confirmHeader: string | null;
  origin: string | null;
  selfOrigins: readonly string[];
}): RestartDecision {
  if (!isLoopbackAddress(input.peerAddress)) {
    return { ok: false, status: 403, error: "restart is available to loopback clients only" };
  }
  if (input.confirmHeader !== "1") {
    return { ok: false, status: 400, error: "restart requires the x-quota-restart: 1 header" };
  }
  if (input.origin && !input.selfOrigins.includes(input.origin)) {
    return { ok: false, status: 403, error: "restart rejected a cross-origin request" };
  }
  return { ok: true };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The successor has to outlive the process that spawns it, so it goes into a
 * backgrounded subshell: the intermediate shell exits immediately, orphaning
 * the server to init rather than leaving it a child of something about to die.
 * The delay covers the moment between this response and the port being freed. */
export function buildSuccessorCommand(input: {
  execPath: string;
  argv: readonly string[];
  logDir: string;
  delayMs?: number;
}): string[] {
  const command = [input.execPath, ...input.argv].map(shellQuote).join(" ");
  const out = shellQuote(join(input.logDir, "quota-service.out.log"));
  const err = shellQuote(join(input.logDir, "quota-service.err.log"));
  const delaySeconds = ((input.delayMs ?? 750) / 1000).toFixed(2);
  return ["/bin/sh", "-c", `( sleep ${delaySeconds}; exec nohup ${command} >> ${out} 2>> ${err} < /dev/null ) &`];
}
