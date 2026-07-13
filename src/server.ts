#!/usr/bin/env bun
// Small local HTTP server. Binds to localhost by default; pass --host to
// listen on another interface (e.g. the tailnet) once that's wired up.
// Runs foreground with a poll loop while alive (on-demand + foreground mode
// per Plan B's current operational stance — no launchd load yet).

import { openDb } from "./db";
import { collectAll } from "./collect";
import { buildResetsReport, buildUsageReport } from "./present";
import { estimateCost, isValidTaskProfile, recommendModel } from "./estimation";
import { join } from "node:path";

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
      return Response.json(buildUsageReport(db));
    }
    if (url.pathname === "/resets") {
      return Response.json(buildResetsReport(db));
    }
    if (url.pathname === "/status") {
      return Response.json({ ok: true, uptimeMs: process.uptime() * 1000, pollMs });
    }
    if (url.pathname === "/estimate") {
      const raw = taskProfileParam(url);
      const profile = isValidTaskProfile(raw) ? raw : "feature";
      return Response.json(estimateCost(profile));
    }
    if (url.pathname === "/recommend") {
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
        if (!["codex", "anthropic", "warp"].includes(body.provider)) {
          return Response.json({ ok: false, error: `unknown provider "${body.provider}"` }, { status: 400 });
        }
        const { setManualEntry } = await import("./db");
        setManualEntry(db, {
          provider: body.provider as "codex" | "anthropic" | "warp",
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
console.log(`  routes: GET /usage  GET /resets  GET /status  GET /estimate  GET /recommend  POST /manual`);
console.log(`  dashboard: http://${server.hostname}:${server.port}/`);
if (host === "127.0.0.1" || host === "localhost") {
  console.log(`  bound to localhost only; pass --host <tailnet-ip> to expose on the tailnet`);
}
