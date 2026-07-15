import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { RunUsage } from "./types";

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const CLAUDE_HOME = process.env.CLAUDE_HOME ?? join(homedir(), ".claude");
const IDLE_SPLIT_MS = 30 * 60_000;
const FILES_PER_PROVIDER = 18;
const RUNS_PER_PROVIDER = 8;
const CACHE_MS = 20_000;

type Provider = RunUsage["provider"];
type Pricing = { input: number; cached: number; cacheWrite5m: number; cacheWrite1h: number; output: number };
type Activity = Omit<RunUsage, "id" | "provider" | "totalTokens" | "apiEquivalentUsd" | "rateLabel"> & {
  cost: number;
  rateLabel: string;
};

let cached: { at: number; value: RunHistoryReport } | null = null;

export interface RunHistoryReport {
  generatedAt: number;
  note: string;
  providers: Record<Provider, RunUsage[]>;
}

async function recentFiles(roots: string[], limit: number): Promise<string[]> {
  const found: Array<{ path: string; mtimeMs: number }> = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 5) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path, depth + 1);
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return;
      try { found.push({ path, mtimeMs: (await stat(path)).mtimeMs }); } catch { /* raced with cleanup */ }
    }));
  }
  await Promise.all(roots.map((root) => walk(root, 0)));
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit).map((f) => f.path);
}

function cleanTitle(value: unknown): string | null {
  let text: string | null = null;
  if (typeof value === "string") text = value;
  else if (Array.isArray(value)) {
    const block = value.find((item) => item?.type === "text" && typeof item.text === "string");
    text = block?.text ?? null;
  }
  if (!text) return null;
  const requestMarker = text.lastIndexOf("## My request for Codex:");
  if (requestMarker >= 0) text = text.slice(requestMarker + "## My request for Codex:".length);
  text = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!text || text.startsWith("<task-notification") || text.startsWith("<local-command") || text.startsWith("Base directory for this skill:")) return null;
  if (text.startsWith("[Image:")) return "Image attachment";
  return text;
}

function openAiPricing(model: string): Pricing {
  if (/gpt-5\.6-sol|^gpt-5\.6$/i.test(model)) return { input: 5, cached: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 6.25, output: 30 };
  if (/gpt-5\.6-terra/i.test(model)) return { input: 2.5, cached: 0.25, cacheWrite5m: 3.125, cacheWrite1h: 3.125, output: 15 };
  if (/gpt-5\.6-luna/i.test(model)) return { input: 1, cached: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 1.25, output: 6 };
  if (/gpt-5\.4|gpt-5\.5/i.test(model)) return { input: 2.5, cached: 0.25, cacheWrite5m: 3.125, cacheWrite1h: 3.125, output: 15 };
  return { input: 1.25, cached: 0.125, cacheWrite5m: 1.5625, cacheWrite1h: 1.5625, output: 10 };
}

function anthropicPricing(model: string, at: number): Pricing {
  if (/fable-5|mythos-5/i.test(model)) return { input: 10, cached: 1, cacheWrite5m: 12.5, cacheWrite1h: 20, output: 50 };
  // Sonnet 5 launch pricing is $2/$10 through 2026-08-31; retain the
  // standard $3/$15 mapping automatically for runs after the promotion.
  if (/sonnet-5/i.test(model) && at < Date.parse("2026-09-01T00:00:00Z")) return { input: 2, cached: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4, output: 10 };
  if (/opus-4-[678]|opus-4\.8|opus-4\.7|opus-4\.6/i.test(model)) return { input: 5, cached: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 };
  if (/opus/i.test(model)) return { input: 15, cached: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30, output: 75 };
  if (/haiku/i.test(model)) return { input: 0.8, cached: 0.08, cacheWrite5m: 1, cacheWrite1h: 1.6, output: 4 };
  return { input: 3, cached: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6, output: 15 };
}

function priceLabel(p: Pricing): string {
  return `$${p.input}/$${p.output} per MTok`;
}

function groupActivities(provider: Provider, fileId: string, events: Activity[]): RunUsage[] {
  const sorted = events.sort((a, b) => a.endedAt - b.endedAt);
  const groups: Activity[][] = [];
  for (const event of sorted) {
    const group = groups.at(-1);
    if (!group || event.startedAt - group.at(-1)!.endedAt > IDLE_SPLIT_MS) groups.push([event]);
    else group.push(event);
  }
  return groups.map((group, index) => {
    const first = group[0]!;
    const modelTotals = new Map<string, number>();
    for (const event of group) modelTotals.set(event.model, (modelTotals.get(event.model) ?? 0) + event.inputTokens + event.cachedInputTokens + event.cacheWriteTokens + event.outputTokens);
    const model = [...modelTotals].sort((a, b) => b[1] - a[1])[0]?.[0] ?? first.model;
    const inputTokens = group.reduce((n, e) => n + e.inputTokens, 0);
    const cachedInputTokens = group.reduce((n, e) => n + e.cachedInputTokens, 0);
    const cacheWriteTokens = group.reduce((n, e) => n + e.cacheWriteTokens, 0);
    const outputTokens = group.reduce((n, e) => n + e.outputTokens, 0);
    return {
      id: `${provider}:${fileId}:${index}`,
      provider,
      title: first.title || "Untitled run",
      startedAt: Math.min(...group.map((e) => e.startedAt)),
      endedAt: Math.max(...group.map((e) => e.endedAt)),
      model,
      effort: group.find((e) => e.effort)?.effort ?? null,
      isSubagent: group.some((e) => e.isSubagent),
      inputTokens,
      cachedInputTokens,
      cacheWriteTokens,
      outputTokens,
      totalTokens: inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens,
      apiEquivalentUsd: group.reduce((n, e) => n + e.cost, 0),
      rateLabel: group.find((e) => e.model === model)?.rateLabel ?? first.rateLabel,
    };
  });
}

async function parseCodex(path: string): Promise<RunUsage[]> {
  let text: string;
  try { text = await Bun.file(path).text(); } catch { return []; }
  let title = "Untitled Codex thread";
  let promptAt: number | null = null;
  let model = "gpt-5";
  let effort: string | null = null;
  const events: Activity[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }
    const timestamp = Date.parse(row.timestamp);
    if (row.type === "turn_context") {
      model = row.payload?.model ?? model;
      effort = row.payload?.effort ?? row.payload?.collaboration_mode?.settings?.reasoning_effort ?? effort;
    }
    if (row.type === "event_msg" && row.payload?.type === "user_message") {
      const nextTitle = cleanTitle(row.payload.message);
      if (nextTitle) { title = nextTitle; promptAt = timestamp; }
    }
    if (row.type !== "event_msg" || row.payload?.type !== "token_count" || !row.payload?.info?.last_token_usage) continue;
    const u = row.payload.info.last_token_usage;
    const cached = Number(u.cached_input_tokens ?? 0);
    const input = Math.max(0, Number(u.input_tokens ?? 0) - cached);
    const output = Number(u.output_tokens ?? 0);
    const p = openAiPricing(model);
    const longContext = Number(u.input_tokens ?? 0) > 272_000;
    const cost = (input * p.input * (longContext ? 2 : 1) + cached * p.cached * (longContext ? 2 : 1) + output * p.output * (longContext ? 1.5 : 1)) / 1_000_000;
    const eventTitle = model === "codex-auto-review" ? "Internal approval review" : title;
    events.push({ title: eventTitle, startedAt: promptAt ?? timestamp, endedAt: timestamp, model, effort, isSubagent: false, inputTokens: input, cachedInputTokens: cached, cacheWriteTokens: 0, outputTokens: output, cost, rateLabel: priceLabel(p) });
    promptAt = null;
  }
  return groupActivities("codex", basename(path, ".jsonl"), events);
}

async function parseAnthropic(path: string): Promise<RunUsage[]> {
  let text: string;
  try { text = await Bun.file(path).text(); } catch { return []; }
  let title = "Untitled Claude thread";
  let promptAt: number | null = null;
  const byMessage = new Map<string, Activity>();
  const isSubagent = path.includes("/subagents/");
  for (const line of text.split("\n")) {
    if (!line) continue;
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }
    const timestamp = Date.parse(row.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    if (row.type === "user") {
      const nextTitle = cleanTitle(row.message?.content);
      if (nextTitle) { title = nextTitle; promptAt = timestamp; }
      continue;
    }
    const u = row.message?.usage;
    if (row.type !== "assistant" || !u) continue;
    const messageId = row.message?.id ?? row.uuid;
    if (!messageId) continue;
    const model = row.message?.model ?? "claude";
    const p = anthropicPricing(model, timestamp);
    const input = Number(u.input_tokens ?? 0);
    const cached = Number(u.cache_read_input_tokens ?? 0);
    const write5m = Number(u.cache_creation?.ephemeral_5m_input_tokens ?? 0);
    const write1h = Number(u.cache_creation?.ephemeral_1h_input_tokens ?? Math.max(0, Number(u.cache_creation_input_tokens ?? 0) - write5m));
    const output = Number(u.output_tokens ?? 0);
    const cost = (input * p.input + cached * p.cached + write5m * p.cacheWrite5m + write1h * p.cacheWrite1h + output * p.output) / 1_000_000;
    const explicitEffort = row.effort ?? row.message?.effort ?? null;
    const inferredEffort = explicitEffort ?? (/fable-5|mythos-5|sonnet-5/i.test(model) ? "adaptive" : null);
    byMessage.set(messageId, { title, startedAt: promptAt ?? timestamp, endedAt: timestamp, model, effort: inferredEffort, isSubagent, inputTokens: input, cachedInputTokens: cached, cacheWriteTokens: write5m + write1h, outputTokens: output, cost, rateLabel: priceLabel(p) });
    promptAt = null;
  }
  return groupActivities("anthropic", basename(path, ".jsonl"), [...byMessage.values()]);
}

export async function collectRunHistory(force = false): Promise<RunHistoryReport> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const [codexFiles, claudeFiles] = await Promise.all([
    recentFiles([join(CODEX_HOME, "sessions"), join(CODEX_HOME, "archived_sessions")], FILES_PER_PROVIDER),
    recentFiles([join(CLAUDE_HOME, "projects")], FILES_PER_PROVIDER),
  ]);
  const [codexNested, anthropicNested] = await Promise.all([
    Promise.all(codexFiles.map(parseCodex)),
    Promise.all(claudeFiles.map(parseAnthropic)),
  ]);
  const recent = (runs: RunUsage[]) => runs.filter((r) => r.totalTokens > 0).sort((a, b) => b.endedAt - a.endedAt).slice(0, RUNS_PER_PROVIDER);
  const value: RunHistoryReport = {
    generatedAt: Date.now(),
    note: "API-equivalent estimates use current public list prices; subscription quota accounting can differ.",
    providers: { codex: recent(codexNested.flat()), anthropic: recent(anthropicNested.flat()) },
  };
  cached = { at: Date.now(), value };
  return value;
}
