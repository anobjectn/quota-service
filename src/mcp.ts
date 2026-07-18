#!/usr/bin/env bun
// stdio MCP server exposing the quota service to any MCP-speaking harness
// (Claude Code, Codex, and — because T3 Code runs those same binaries
// against the normal home directories — T3 Code threads on both).
//
// get_usage / get_resets read the local SQLite store and trigger a
// collect-on-query refresh (respecting each provider's poll floor) so an
// agent always gets current-ish data without the server needing to be
// running continuously. estimate_cost / recommend_model are Phase 4 stubs.

import { ENABLED_PROVIDERS } from "./config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb } from "./db";
import { collectAll } from "./collect";
import { buildResetsReport, buildUsageReport } from "./present";
import { TASK_PROFILES, estimateCost, isValidTaskProfile, recommendModel, type TaskProfile } from "./estimation";

const db = openDb();

const server = new McpServer({
  name: "quota-service",
  version: "0.1.0",
});

server.registerTool(
  "get_usage",
  {
    title: "Get current quota usage",
    description:
      `Returns current usage for enabled providers (${ENABLED_PROVIDERS.join(", ")}): window/pool usage, data source, and data age. Every enabled provider reports an explicit ok/stale/unavailable status.`,
    inputSchema: {},
  },
  async () => {
    await collectAll(db).catch(() => undefined); // best-effort refresh; stale data is still reported below
    const report = buildUsageReport(db);
    return {
      content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
    };
  },
);

server.registerTool(
  "get_resets",
  {
    title: "Get natural resets and banked reset credits",
    description:
      "Returns each provider's natural reset times for 5h/weekly windows and Warp's monthly refresh, plus Codex's banked reset credits (available_count/total_earned_count and each credit's status/expiry). Report-only: this service never consumes a reset credit or triggers a purchase.",
    inputSchema: {},
  },
  async () => {
    await collectAll(db).catch(() => undefined);
    const report = buildResetsReport(db);
    return {
      content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
    };
  },
);

const TASK_PROFILE_ENUM = TASK_PROFILES as [TaskProfile, ...TaskProfile[]];

function resolveTaskProfile(taskProfile: string | undefined): TaskProfile {
  if (isValidTaskProfile(taskProfile)) return taskProfile;
  // Default when the caller doesn't (or can't) classify: "feature" is the
  // most common mid-complexity case, matching model-rubric.md's mid tier.
  return "feature";
}

server.registerTool(
  "estimate_cost",
  {
    title: "Estimate token/cost for a task",
    description:
      "v1.5 heuristic token-range estimate for a task profile (small_fix/feature/large_refactor/research) across light/mid/frontier model tiers. Coarse by design — precise pre-estimation is impossible; see calibration notes in the response.",
    inputSchema: {
      taskProfile: z
        .enum(TASK_PROFILE_ENUM)
        .optional()
        .describe("small_fix | feature | large_refactor | research. Defaults to 'feature' if omitted."),
    },
  },
  async ({ taskProfile }) => {
    const profile = resolveTaskProfile(taskProfile);
    const result = estimateCost(profile);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "recommend_model",
  {
    title: "Recommend a model/provider given live headroom",
    description:
      "Combines the task-profile token estimate with live get_usage headroom across enabled providers and returns a ranked provider+model suggestion with a one-line reason. Never silently drops a stale/unavailable enabled provider — it is flagged in the response instead.",
    inputSchema: {
      taskProfile: z
        .enum(TASK_PROFILE_ENUM)
        .optional()
        .describe("small_fix | feature | large_refactor | research. Defaults to 'feature' if omitted."),
    },
  },
  async ({ taskProfile }) => {
    await collectAll(db).catch(() => undefined);
    const profile = resolveTaskProfile(taskProfile);
    const usage = buildUsageReport(db);
    const result = recommendModel(profile, usage);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
