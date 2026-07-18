#!/usr/bin/env bun
// Small local HTTP server. Binds to localhost by default; pass --host to
// listen on another interface (e.g. the tailnet) once that's wired up.
// Runs foreground with a poll loop while alive (on-demand + foreground mode
// per Plan B's current operational stance — no launchd load yet).

import { requireEnabledProvider } from "./config";
import { openDb } from "./db";
import { collectAll } from "./collect";
import { buildResetsReport, buildUsageReport } from "./present";
import { estimateCost, isValidTaskProfile, recommendModel } from "./estimation";
import { join } from "node:path";
import { collectRunHistory } from "./run-history";
import { buildServiceStatus } from "./status";

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

// Self-rescheduling setTimeout rather than a bare interval/while+sleep loop:
// each cycle only schedules the *next* cycle once this one has settled (via
// the finally below), so a hang anywhere inside can't pile up overlapping
// runs, and a watchdog timeout guarantees the schedule keeps moving even if
// collectAll() itself never resolves (the observed Jul 13 wedge — a fetch()
// with no deadline stalled after the Mac woke from sleep, and the old
// `while (true) { await collectAll(db); await Bun.sleep(pollMs) }` loop
// blocked on that await forever, so no further snapshots were ever written
// even though the process itself stayed up under launchd/KeepAlive).
const POLL_WATCHDOG_MS = 30_000;

let pollTimer: ReturnType<typeof setTimeout> | null = null;

async function runPollCycle(): Promise<void> {
  try {
    await Promise.race([
      collectAll(db),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("collectAll watchdog timeout")), POLL_WATCHDOG_MS);
      }),
    ]);
  } catch (err) {
    // Catch-all: one bad cycle (network hiccup, watchdog trip, anything)
    // must never stop the schedule.
    console.error("[quota-service] collection error:", err instanceof Error ? err.message : err);
  } finally {
    pollTimer = setTimeout(() => void runPollCycle(), pollMs);
  }
}

// Kick off an immediate collection so /usage has data right away, then poll.
void runPollCycle();

const PUBLIC_DIR = join(import.meta.dir, "..", "public");

function taskProfileParam(url: URL): string | undefined {
  return url.searchParams.get("taskProfile") ?? url.searchParams.get("profile") ?? undefined;
}

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" || pathname === "" ? "/index.html" : pathname;
  const filePath = join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) return new Response("forbidden", { status: 403 });
  const file = Bun.file(filePath);
  if (await file.exists()) return new Response(file);
  return new Response("not found", { status: 404 });
}

const server = Bun.serve({
  hostname: host,
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/usage") {
      // Collect-on-query: collectAll() only actually re-hits the network for
      // providers whose data has aged past their poll floor (see collect.ts);
      // otherwise this is just a cached-row read, so it's cheap on the
      // common path and only pays the network cost when the background poll
      // loop has genuinely fallen behind.
      await collectAll(db).catch(() => undefined);
      return Response.json(buildUsageReport(db));
    }
    if (url.pathname === "/resets") {
      await collectAll(db).catch(() => undefined);
      return Response.json(buildResetsReport(db));
    }
    if (url.pathname === "/runs") {
      return Response.json(await collectRunHistory(url.searchParams.get("refresh") === "1"));
    }
    if (url.pathname === "/status") {
      return Response.json(buildServiceStatus(pollMs));
    }
    if (url.pathname === "/estimate") {
      const raw = taskProfileParam(url);
      const profile = isValidTaskProfile(raw) ? raw : "feature";
      return Response.json(estimateCost(profile));
    }
    if (url.pathname === "/recommend") {
      await collectAll(db).catch(() => undefined);
      const raw = taskProfileParam(url);
      const profile = isValidTaskProfile(raw) ? raw : "feature";
      const usage = buildUsageReport(db);
      return Response.json(recommendModel(profile, usage));
    }
    if (url.pathname === "/manual" && req.method === "POST") {
      try {
        const body = (await req.json()) as { provider?: string; field?: string; value?: string; note?: string | null };
        if (!body.provider || !body.field || body.value === undefined) {
          return Response.json({ ok: false, error: "provider, field, value are required" }, { status: 400 });
        }
        const provider = requireEnabledProvider(body.provider);
        const { setManualEntry } = await import("./db");
        setManualEntry(db, {
          provider,
          field: body.field,
          value: String(body.value),
          note: body.note ?? null,
        });
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 });
      }
    }
    if (req.method === "GET") {
      return serveStatic(url.pathname);
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`quota-service listening on http://${server.hostname}:${server.port}`);
console.log(`  polling every ${Math.round(pollMs / 1000)}s (respects per-provider poll floors)`);
console.log(`  routes: GET /usage  GET /runs  GET /resets  GET /status  GET /estimate  GET /recommend  POST /manual`);
console.log(`  dashboard: http://${server.hostname}:${server.port}/`);
if (host === "127.0.0.1" || host === "localhost") {
  console.log(`  bound to localhost only; pass --host <tailnet-ip> to expose on the tailnet`);
}
