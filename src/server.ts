#!/usr/bin/env bun
// Small local HTTP server. Binds to localhost by default; pass --host to
// listen on another interface (e.g. the tailnet) once that's wired up.
// Runs foreground with a poll loop while alive (on-demand + foreground mode
// per Plan B's current operational stance — no launchd load yet).

import { openDb } from "./db";
import { collectAll } from "./collect";
import { buildResetsReport, buildUsageReport } from "./present";

function parseArgs(argv: string[]): { host: string; port: number; pollMs: number } {
  let host = "127.0.0.1";
  let port = Number(process.env.QUOTA_PORT ?? 8787);
  let pollMs = Number(process.env.QUOTA_POLL_MS ?? 5 * 60_000);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--host" && argv[i + 1]) {
      host = argv[i + 1]!;
      i++;
    } else if (argv[i] === "--port" && argv[i + 1]) {
      port = Number(argv[i + 1]);
      i++;
    } else if (argv[i] === "--poll-ms" && argv[i + 1]) {
      pollMs = Number(argv[i + 1]);
      i++;
    }
  }
  return { host, port, pollMs };
}

const { host, port, pollMs } = parseArgs(process.argv.slice(2));
const db = openDb();

async function pollLoop(): Promise<void> {
  while (true) {
    try {
      await collectAll(db);
    } catch (err) {
      console.error("[quota-service] collection error:", err instanceof Error ? err.message : err);
    }
    await Bun.sleep(pollMs);
  }
}

// Kick off an immediate collection so /usage has data right away, then poll.
void collectAll(db).catch((err) => {
  console.error("[quota-service] initial collection error:", err instanceof Error ? err.message : err);
});
void pollLoop();

const server = Bun.serve({
  hostname: host,
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/usage") {
      return Response.json(buildUsageReport(db));
    }
    if (url.pathname === "/resets") {
      return Response.json(buildResetsReport(db));
    }
    if (url.pathname === "/status") {
      return Response.json({ ok: true, uptimeMs: process.uptime() * 1000, pollMs });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`quota-service listening on http://${server.hostname}:${server.port}`);
console.log(`  polling every ${Math.round(pollMs / 1000)}s (respects per-provider poll floors)`);
console.log(`  routes: GET /usage  GET /resets  GET /status`);
if (host === "127.0.0.1" || host === "localhost") {
  console.log(`  bound to localhost only; pass --host <tailnet-ip> to expose on the tailnet`);
}
