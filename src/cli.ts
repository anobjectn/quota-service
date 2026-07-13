#!/usr/bin/env bun
import { openDb, setManualEntry } from "./db";
import { collectAll } from "./collect";
import {
  buildResetsReport,
  buildUsageReport,
  formatAge,
  formatCountdown,
  statusBadge,
  type ProviderReport,
  type UsageReport,
} from "./present";
import type { Provider } from "./types";
import { estimateCost, isValidTaskProfile, recommendModel, TASK_PROFILES, type TaskProfile } from "./estimation";

const HTTP_DEFAULT_PORT = Number(process.env.QUOTA_PORT ?? 8787);

async function tryServer(path: string): Promise<unknown | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${HTTP_DEFAULT_PORT}${path}`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function providerLabel(p: Provider): string {
  return { codex: "Codex", anthropic: "Anthropic", warp: "Warp" }[p];
}

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function renderProviderLine(p: ProviderReport): string[] {
  const lines: string[] = [];
  const badge = `[${statusBadge(p.status)}]`;
  const age = formatAge(p.dataAgeMs);
  const header = `${pad(providerLabel(p.provider), 10)} ${pad(badge, 13)} age: ${age}  source: ${p.source ?? "-"}`;
  lines.push(header);
  if (p.snapshot?.kind === "window") {
    if (p.snapshot.fiveHour) {
      lines.push(
        `  5h window:     ${p.snapshot.fiveHour.usedPercent.toFixed(1)}%  resets ${formatCountdown(p.snapshot.fiveHour.resetsAt)}`,
      );
    } else {
      lines.push(`  5h window:     not currently tracked`);
    }
    if (p.snapshot.weekly) {
      lines.push(
        `  weekly window: ${p.snapshot.weekly.usedPercent.toFixed(1)}%  resets ${formatCountdown(p.snapshot.weekly.resetsAt)}`,
      );
    } else {
      lines.push(`  weekly window: not currently tracked`);
    }
    const extra = p.snapshot.extra as Record<string, unknown> | undefined;
    if (extra?.planType) lines.push(`  plan: ${extra.planType}`);
    if (extra?.bankedResetCreditsAvailable != null) {
      lines.push(`  banked reset credits available: ${extra.bankedResetCreditsAvailable}`);
    }
  } else if (p.snapshot?.kind === "pool") {
    const pool = p.snapshot.pool;
    lines.push(
      `  pool: ${pool.used}/${pool.limit} (${pool.usedPercent.toFixed(1)}%)  refreshes ${formatCountdown(pool.refreshesAt)} [${pool.cadence ?? "?"}]`,
    );
  }
  if (p.manualEntries.length > 0) {
    for (const m of p.manualEntries) {
      lines.push(`  manual: ${m.field} = ${m.value}${m.note ? ` (${m.note})` : ""} — set ${formatAge(Date.now() - m.updatedAt)}`);
    }
  }
  if (p.error) {
    lines.push(`  note: ${p.error}`);
  }
  return lines;
}

function renderUsageTable(report: UsageReport): string {
  const lines: string[] = [];
  lines.push(`quota — generated ${new Date(report.generatedAt).toISOString()}`);
  lines.push("");
  for (const p of report.providers) {
    lines.push(...renderProviderLine(p));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

async function cmdUsage(json: boolean): Promise<void> {
  // Try the running server first (it may have fresher polled data and
  // avoids re-hitting network paths from a one-shot process); fall back to
  // collect-on-query directly against the DB.
  const serverReport = await tryServer("/usage");
  let report: UsageReport;
  if (serverReport) {
    report = serverReport as UsageReport;
  } else {
    const db = openDb();
    await collectAll(db);
    report = buildUsageReport(db);
  }
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderUsageTable(report));
  }
}

async function cmdResets(json: boolean): Promise<void> {
  const serverReport = await tryServer("/resets");
  let report;
  if (serverReport) {
    report = serverReport;
  } else {
    const db = openDb();
    await collectAll(db);
    report = buildResetsReport(db);
  }
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const r = report as ReturnType<typeof buildResetsReport>;
  console.log(`resets — generated ${new Date(r.generatedAt).toISOString()}`);
  console.log("");
  for (const w of r.windows) {
    console.log(
      `${pad(providerLabel(w.provider), 10)} ${pad(w.window, 10)} ${w.usedPercent.toFixed(1)}%  resets ${formatCountdown(w.resetsAt)}`,
    );
  }
  for (const p of r.pools) {
    console.log(
      `${pad(providerLabel(p.provider), 10)} pool       ${p.used}/${p.limit} (${p.usedPercent.toFixed(1)}%)  refreshes ${formatCountdown(p.refreshesAt)}`,
    );
  }
  if (r.codexBankedResetCredits) {
    const c = r.codexBankedResetCredits;
    console.log("");
    console.log(`Codex banked reset credits: available=${c.availableCount} total_earned=${c.totalEarnedCount} [${c.status}]`);
    for (const credit of c.credits) {
      console.log(`  - ${credit.title ?? credit.id} (${credit.status}) expires ${credit.expiresAt ?? "?"}`);
    }
  }
}

function cmdManualSet(args: string[]): void {
  const [provider, field, value, ...noteParts] = args;
  if (!provider || !field || value === undefined) {
    console.error("usage: quota manual set <provider> <field> <value> [note...]");
    process.exit(1);
  }
  if (!["codex", "anthropic", "warp"].includes(provider)) {
    console.error(`unknown provider "${provider}"`);
    process.exit(1);
  }
  const db = openDb();
  setManualEntry(db, {
    provider: provider as Provider,
    field,
    value,
    note: noteParts.length > 0 ? noteParts.join(" ") : null,
  });
  console.log(`set ${provider}.${field} = ${value}`);
}

function parseTaskProfile(args: string[]): TaskProfile {
  const raw = args[0];
  if (isValidTaskProfile(raw)) return raw;
  if (raw) {
    console.error(`unknown task profile "${raw}" — expected one of: ${TASK_PROFILES.join(", ")}. Defaulting to "feature".`);
  }
  return "feature";
}

function cmdEstimate(args: string[]): void {
  const json = args.includes("json");
  const profile = parseTaskProfile(args.filter((a) => a !== "json"));
  const result = estimateCost(profile);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`estimate — ${profile}: ${result.description}`);
  console.log(`  rubric tier: ${result.rubricTier}`);
  for (const tier of ["light", "mid", "frontier"] as const) {
    const r = result.tokenRangeByTier[tier];
    console.log(`  ${pad(tier, 10)} ${r.low.toLocaleString()} – ${r.high.toLocaleString()} tokens (typical ~${r.typical.toLocaleString()})`);
  }
  console.log(`  calibration: ${result.calibration.note}`);
}

async function cmdRecommend(args: string[]): Promise<void> {
  const json = args.includes("json");
  const profile = parseTaskProfile(args.filter((a) => a !== "json"));
  const serverReport = await tryServer("/usage");
  let usage: UsageReport;
  if (serverReport) {
    usage = serverReport as UsageReport;
  } else {
    const db = openDb();
    await collectAll(db);
    usage = buildUsageReport(db);
  }
  const result = recommendModel(profile, usage);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`recommend — ${profile} (rubric tier: ${result.estimate.rubricTier})`);
  if (result.recommendation) {
    console.log(`  -> ${result.recommendation.provider} / ${result.recommendation.model}`);
  } else {
    console.log(`  -> no usable recommendation`);
  }
  console.log(`  reason: ${result.reason}`);
  if (result.alternates.length > 0) {
    console.log(`  alternates:`);
    for (const alt of result.alternates) {
      console.log(`    - ${alt.provider} / ${alt.model} (headroom: ${alt.headroomPercent != null ? alt.headroomPercent.toFixed(1) + "%" : "unknown"})`);
    }
  }
  for (const w of result.warnings) {
    console.log(`  warning: ${w}`);
  }
}

function printHelp(): void {
  console.log(`quota — personal usage/quota CLI

Usage:
  quota                 human-readable usage table (all providers)
  quota json             machine-readable usage report
  quota resets           human-readable natural resets + banked reset credits
  quota resets json      machine-readable resets report
  quota manual set <provider> <field> <value> [note...]
                          record a manual entry (e.g. Warp add-on credits)
  quota estimate [profile] [json]
                          token-range estimate for a task profile
                          (small_fix | feature | large_refactor | research)
  quota recommend [profile] [json]
                          ranked model/provider suggestion given live headroom
  quota help              this message

Notes:
  - Tries the running server (bun run serve) first for fresher polled data,
    falls back to a direct one-shot collection against the local SQLite DB.
  - Anthropic collector respects a 180s poll floor; rapid repeat calls serve
    the last cached result instead of re-hitting the network.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [cmd, ...rest] = args;

  if (!cmd || cmd === "table") {
    await cmdUsage(false);
  } else if (cmd === "json") {
    await cmdUsage(true);
  } else if (cmd === "resets") {
    await cmdResets(rest[0] === "json");
  } else if (cmd === "manual" && rest[0] === "set") {
    cmdManualSet(rest.slice(1));
  } else if (cmd === "estimate") {
    cmdEstimate(rest);
  } else if (cmd === "recommend") {
    await cmdRecommend(rest);
  } else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
  } else {
    console.error(`unknown command "${cmd}"`);
    printHelp();
    process.exit(1);
  }
}

await main();
