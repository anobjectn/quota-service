#!/usr/bin/env bun
// stdio MCP server exposing the quota service to any MCP-speaking harness
// (Claude Code, Codex, and — because T3 Code runs those same binaries
// against the normal home directories — T3 Code threads on both).
//
// get_usage / get_resets read the local SQLite store and trigger a
// collect-on-query refresh (respecting each provider's poll floor) so an
// agent always gets current-ish data without the server needing to be
// running continuously. estimate_cost / recommend_model are Phase 4 stubs.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb } from "./db";
import { collectAll } from "./collect";
import { buildResetsReport, buildUsageReport } from "./present";

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
      "Returns current usage for Codex, Anthropic (Claude Code), and Warp: 5h/weekly window percentages, Warp's monthly pool, data source, and data age. Every provider reports an explicit ok/stale/unavailable status.",
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

const NOT_IMPLEMENTED = (tool: string) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify(
        {
          tool,
          implemented: false,
          message: `${tool} is not implemented until Plan B Phase 4 (token/cost estimation). This is a stub so callers can wire up the interface now.`,
        },
        null,
        2,
      ),
    },
  ],
});

server.registerTool(
  "estimate_cost",
  {
    title: "Estimate token/cost for a task (stub)",
    description: "Phase 4 stub. Not implemented yet — returns a clear not-implemented payload.",
    inputSchema: { taskDescription: z.string().optional() },
  },
  async () => NOT_IMPLEMENTED("estimate_cost"),
);

server.registerTool(
  "recommend_model",
  {
    title: "Recommend a model/provider given headroom (stub)",
    description: "Phase 4 stub. Not implemented yet — returns a clear not-implemented payload.",
    inputSchema: { taskProfile: z.string().optional() },
  },
  async () => NOT_IMPLEMENTED("recommend_model"),
);

const transport = new StdioServerTransport();
await server.connect(transport);
