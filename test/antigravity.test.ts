import { describe, expect, test } from "bun:test";
import {
  ANTIGRAVITY_POLL_FLOOR_MS,
  collectAntigravity,
  normalizeAntigravityPlanType,
  normalizeQuotaSummary,
  parseAntigravityOauthCredentials,
  parseAntigravityProcesses,
  parseListeningPorts,
  remainingFractionToUsedPercent,
  type AntigravityCommandOutput,
} from "../src/collectors/antigravity";

const NOW = Date.parse("2026-11-21T16:00:00Z");
const IN_3H = new Date(NOW + 3 * 3600 * 1000).toISOString();
const IN_5D = new Date(NOW + 5 * 24 * 3600 * 1000).toISOString();
const IN_18H = new Date(NOW + 18 * 3600 * 1000).toISOString();

describe("Antigravity process and port detection", () => {
  test("detects Antigravity language_server and agy while ignoring unrelated processes", () => {
    const psOutput = [
      "  101 /Applications/Windsurf.app/Contents/Resources/language_server_macos_arm --csrf_token windsurf-tok",
      "  202 /usr/bin/grep antigravity",
      "  303 /Users/luis/bin/strategy --serve",
      "  404 /Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm --csrf_token tok-space --extension_server_port 51234 --extension_server_csrf_token=ext-tok",
      "  505 /opt/homebrew/bin/agy serve --port 52000",
      "  606 /Users/luis/.antigravity/bin/language_server --csrf_token=tok-eq",
    ].join("\n");

    const procs = parseAntigravityProcesses(psOutput);
    expect(procs.map((p) => p.pid)).toEqual([404, 606, 505]);
    expect(procs[0]).toMatchObject({
      pid: 404,
      kind: "language_server",
      csrfToken: "tok-space",
      extensionServerPort: 51234,
      extensionServerCsrfToken: "ext-tok",
    });
    expect(procs[1]).toMatchObject({
      pid: 606,
      kind: "language_server",
      csrfToken: "tok-eq",
      extensionServerPort: null,
    });
    expect(procs[2]).toMatchObject({
      pid: 505,
      kind: "agy",
      csrfToken: null,
    });
  });

  test("parses deduplicated loopback listening ports from lsof output", () => {
    const lsofOutput = [
      "COMMAND     PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "language_  404 luis   12u  IPv4 0x1234      0t0  TCP 127.0.0.1:54321 (LISTEN)",
      "language_  404 luis   13u  IPv6 0x1235      0t0  TCP [::1]:54321 (LISTEN)",
      "language_  404 luis   14u  IPv4 0x1236      0t0  TCP 192.168.1.50:9999 (LISTEN)",
      "language_  404 luis   15u  IPv4 0x1237      0t0  TCP 127.0.0.1:54322 (ESTABLISHED)",
      "language_  404 luis   16u  IPv4 0x1238      0t0  TCP *:54323 (LISTEN)",
    ].join("\n");

    expect(parseListeningPorts(lsofOutput)).toEqual([54321, 54323]);
  });
});

describe("Antigravity normalization helpers", () => {
  test("converts remainingFraction to clamped finite usedPercent rounded to 1 decimal", () => {
    expect(remainingFractionToUsedPercent(1)).toBe(0);
    expect(remainingFractionToUsedPercent(0)).toBe(100);
    expect(remainingFractionToUsedPercent(0.6666)).toBe(33.3);
    expect(remainingFractionToUsedPercent(1.5)).toBe(0);
    expect(remainingFractionToUsedPercent(-0.25)).toBe(100);
    expect(remainingFractionToUsedPercent(Number.NaN)).toBeNull();
    expect(remainingFractionToUsedPercent(Number.POSITIVE_INFINITY)).toBeNull();
    expect(remainingFractionToUsedPercent(undefined)).toBeNull();
  });

  test("normalizes recognized plan types and preserves unrecognized names trimmed", () => {
    expect(normalizeAntigravityPlanType("Google AI Ultra")).toBe("ultra");
    expect(normalizeAntigravityPlanType("g1-pro-tier")).toBe("pro");
    expect(normalizeAntigravityPlanType("standard-tier")).toBe("standard");
    expect(normalizeAntigravityPlanType("free-tier")).toBe("free");
    expect(normalizeAntigravityPlanType("  Custom Research Tier  ")).toBe("Custom Research Tier");
    expect(normalizeAntigravityPlanType("   ")).toBeNull();
  });

  test("normalizes structured QuotaSummary groups, omits disabled/non-finite buckets, and preserves other groups", () => {
    const snap = normalizeQuotaSummary(
      {
        response: {
          groups: [
            {
              displayName: "Gemini 4 Argon",
              buckets: [
                {
                  bucketId: "argon_weekly",
                  displayName: "Weekly",
                  remaining: { case: "remainingFraction", value: 0.72 },
                  resetTime: IN_5D,
                },
              ],
            },
            {
              displayName: "Gemini",
              buckets: [
                {
                  bucketId: "gemini_5h",
                  displayName: "5-hour session",
                  remainingFraction: 0.65,
                  resetTime: IN_3H,
                },
                {
                  bucketId: "gemini_weekly",
                  displayName: "Weekly",
                  remaining: { remainingFraction: 0.8 },
                  resetTime: IN_5D,
                },
                {
                  bucketId: "disabled_bucket",
                  displayName: "Disabled",
                  disabled: true,
                  remainingFraction: 0.1,
                  resetTime: IN_3H,
                },
                {
                  bucketId: "bad_bucket",
                  displayName: "NaN Bucket",
                  remainingFraction: Number.NaN,
                  resetTime: IN_3H,
                },
              ],
            },
            {
              displayName: "Claude / GPT",
              buckets: [
                {
                  bucketId: "partner_5h",
                  window: "FIVE_HOUR",
                  remainingFraction: 0.4,
                  resetTime: IN_3H,
                },
                {
                  bucketId: "partner_weekly",
                  window: "WEEKLY",
                  remainingFraction: 0.85,
                  resetTime: IN_5D,
                },
              ],
            },
          ],
        },
      },
      NOW,
      { planType: "ultra", rawPlanName: "Google AI Ultra", tierId: "g1-ultra-tier", planSource: "get_user_status" },
    );

    expect(snap).not.toBeNull();
    expect(snap!.fiveHour).toEqual({ usedPercent: 35, resetsAt: Date.parse(IN_3H) });
    expect(snap!.weekly).toEqual({ usedPercent: 20, resetsAt: Date.parse(IN_5D) });
    expect(snap!.modelWindows).toEqual({
      "Gemini 4 Argon (weekly)": { usedPercent: 28, resetsAt: Date.parse(IN_5D) },
      "Claude / GPT (5h)": { usedPercent: 60, resetsAt: Date.parse(IN_3H) },
      "Claude / GPT (weekly)": { usedPercent: 15, resetsAt: Date.parse(IN_5D) },
    });
    expect(snap!.extra?.planType).toBe("ultra");
  });
});

describe("Antigravity Tactic A (antigravity_local)", () => {
  test("queries local RetrieveUserQuotaSummary over loopback HTTPS with self-signed TLS and enriches plan via GetUserStatus", async () => {
    expect(ANTIGRAVITY_POLL_FLOOR_MS).toBe(60_000);
    const seenRequests: Array<{ url: string; headers: Record<string, string>; tls: unknown }> = [];

    const runCommand = async (argv: string[]): Promise<AntigravityCommandOutput> => {
      if (argv[0] === "ps") {
        return {
          exitCode: 0,
          stdout: "  900 /Applications/Antigravity.app/Contents/Resources/language_server_macos_arm --csrf_token secret-csrf --extension_server_port 51001\n",
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: "language_ 900 luis 10u IPv4 0x1 0t0 TCP 127.0.0.1:51000 (LISTEN)\n",
        stderr: "",
      };
    };

    const request = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const url = String(input);
      seenRequests.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        tls: (init as { tls?: unknown } | undefined)?.tls,
      });
      if (url.endsWith("/RetrieveUserQuotaSummary")) {
        return Response.json({
          groups: [
            {
              displayName: "Gemini",
              buckets: [
                { displayName: "5h", remainingFraction: 0.75, resetTime: IN_3H },
                { displayName: "Weekly", remainingFraction: 0.9, resetTime: IN_5D },
              ],
            },
          ],
        });
      }
      if (url.endsWith("/GetUserStatus")) {
        return Response.json({
          userStatus: {
            email: "user@example.com",
            userTier: { id: "g1-ultra-tier", name: "Google AI Ultra" },
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await collectAntigravity({ request, runCommand, now: () => NOW });

    expect(result.status).toBe("ok");
    expect(result.source).toBe("antigravity_local");
    expect(result.dataAsOf).toBe(NOW);
    expect(result.snapshot?.kind).toBe("window");
    if (result.snapshot?.kind === "window") {
      expect(result.snapshot.fiveHour).toEqual({ usedPercent: 25, resetsAt: Date.parse(IN_3H) });
      expect(result.snapshot.weekly).toEqual({ usedPercent: 10, resetsAt: Date.parse(IN_5D) });
      expect(result.snapshot.extra?.planType).toBe("ultra");
    }

    expect(seenRequests.map((r) => r.url)).toEqual([
      "https://127.0.0.1:51000/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
      "https://127.0.0.1:51000/exa.language_server_pb.LanguageServerService/GetUserStatus",
    ]);
    expect(seenRequests[0]!.headers["Connect-Protocol-Version"]).toBe("1");
    expect(seenRequests[0]!.headers["X-Codeium-Csrf-Token"]).toBe("secret-csrf");
    expect(seenRequests[0]!.tls).toEqual({ rejectUnauthorized: false });
  });

  test("supports tokenless agy HTTP fallback and per-model GetCommandModelConfigs without guessing unknown cadence", async () => {
    const seenRequests: Array<{ url: string; headers: Record<string, string>; tls: unknown }> = [];

    const runCommand = async (argv: string[]): Promise<AntigravityCommandOutput> => {
      if (argv[0] === "ps") {
        return { exitCode: 0, stdout: "  777 /opt/homebrew/bin/agy serve\n", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: "agy 777 luis 5u IPv4 0x2 0t0 TCP 127.0.0.1:52000 (LISTEN)\n",
        stderr: "",
      };
    };

    const request = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const url = String(input);
      seenRequests.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        tls: (init as { tls?: unknown } | undefined)?.tls,
      });
      if (url.startsWith("https://")) {
        throw new Error("TLS handshake failed");
      }
      if (url.endsWith("/RetrieveUserQuotaSummary")) {
        return new Response("unimplemented", { status: 404 });
      }
      if (url.endsWith("/GetUserStatus")) {
        return Response.json({
          userStatus: {
            planStatus: { planInfo: { planDisplayName: "Google AI Pro" } },
          },
        });
      }
      if (url.endsWith("/GetCommandModelConfigs")) {
        return Response.json({
          clientModelConfigs: [
            {
              label: "Gemini 3 Pro",
              modelOrAlias: { model: "gemini-3-pro" },
              quotaInfo: { remainingFraction: 0.7, resetTime: IN_18H },
            },
            {
              label: "Claude Sonnet 4.5",
              modelOrAlias: { model: "claude-sonnet-4-5" },
              quotaInfo: { remainingFraction: 0.5, resetTime: IN_3H },
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await collectAntigravity({ request, runCommand, now: () => NOW });

    expect(result.status).toBe("ok");
    expect(result.source).toBe("antigravity_local");
    // Tokenless agy should not send X-Codeium-Csrf-Token; HTTP fallback should not set tls.
    const httpCalls = seenRequests.filter((r) => r.url.startsWith("http://"));
    expect(httpCalls.length).toBe(3);
    expect(httpCalls[0]!.headers["X-Codeium-Csrf-Token"]).toBeUndefined();
    expect(httpCalls[0]!.tls).toBeUndefined();

    expect(result.snapshot?.kind).toBe("window");
    if (result.snapshot?.kind === "window") {
      // 18h horizon is ambiguous (between 6h and 3d), so fiveHour/weekly must NOT be guessed.
      expect(result.snapshot.fiveHour).toBeNull();
      expect(result.snapshot.weekly).toBeNull();
      expect(result.snapshot.modelWindows).toEqual({
        "Gemini 3 Pro": { usedPercent: 30, resetsAt: Date.parse(IN_18H) },
        "Claude Sonnet 4.5": { usedPercent: 50, resetsAt: Date.parse(IN_3H) },
      });
      expect(result.snapshot.extra?.planType).toBe("pro");
    }
  });
});

describe("Antigravity Tactic B (antigravity_api)", () => {
  const noLocalServer = async (): Promise<AntigravityCommandOutput> => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });

  test("reads OAuth credentials in priority order and parses antigravity-cli nested token shape", () => {
    const parsed = parseAntigravityOauthCredentials(
      JSON.stringify({
        token: { access_token: "nested-tok", expiry: "2026-11-21T20:00:00Z" },
        email: "dev@example.com",
        project_id: "proj-123",
      }),
      "~/.gemini/antigravity-cli/antigravity-oauth-token",
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.credential.accessToken).toBe("nested-tok");
      expect(parsed.credential.expiresAt).toBe(Date.parse("2026-11-21T20:00:00Z"));
      expect(parsed.credential.projectId).toBe("proj-123");
    }
  });

  test("returns stale without network calls when OAuth token is expired", async () => {
    let fetchCalls = 0;
    const request = (async (_input: Parameters<typeof globalThis.fetch>[0]) => {
      fetchCalls++;
      return Response.json({});
    }) as typeof globalThis.fetch;

    const result = await collectAntigravity({
      request,
      runCommand: noLocalServer,
      now: () => NOW,
      env: {
        ANTIGRAVITY_OAUTH_CREDENTIALS_JSON: JSON.stringify({
          access_token: "expired-token",
          expiry_date: NOW - 60_000,
        }),
      },
    });

    expect(result.status).toBe("stale");
    expect(result.source).toBe("antigravity_api");
    expect(result.snapshot).toBeNull();
    expect(result.error).toContain("expired");
    expect(fetchCalls).toBe(0);
  });

  test("returns stale on Cloud Code HTTP 401 without attempting refresh", async () => {
    const urls: string[] = [];
    const request = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      urls.push(String(input));
      return new Response("unauthorized", { status: 401 });
    }) as typeof globalThis.fetch;

    const result = await collectAntigravity({
      request,
      runCommand: noLocalServer,
      now: () => NOW,
      env: { QUOTA_ANTIGRAVITY_AUTH_PATH: "/fake/oauth_creds.json" },
      readFileText: async (path) =>
        path === "/fake/oauth_creds.json"
          ? JSON.stringify({ access_token: "stale-tok", expiry_date: NOW + 3600_000 })
          : null,
    });

    expect(result.status).toBe("stale");
    expect(result.source).toBe("antigravity_api");
    expect(result.error).toContain("401");
    expect(urls).toEqual(["https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"]);
  });

  test("falls back to Cloud Code loadCodeAssist -> retrieveUserQuotaSummary without ever calling onboardUser or disabling TLS", async () => {
    const calls: Array<{ url: string; body: unknown; tls: unknown; userAgent: string }> = [];
    const request = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        tls: (init as { tls?: unknown } | undefined)?.tls,
        userAgent: headers["User-Agent"] ?? "",
      });
      if (url.endsWith(":loadCodeAssist")) {
        return Response.json({
          cloudaicompanionProject: { id: "my-cloud-project" },
          paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
        });
      }
      if (url.endsWith(":retrieveUserQuotaSummary")) {
        return Response.json({
          summary: {
            groups: [
              {
                displayName: "Gemini",
                buckets: [
                  { displayName: "Session", remainingFraction: 0.82, resetTime: IN_3H },
                  { displayName: "Weekly", remainingFraction: 0.6, resetTime: IN_5D },
                ],
              },
            ],
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await collectAntigravity({
      request,
      runCommand: noLocalServer,
      now: () => NOW,
      env: {},
      homedir: () => "/fake-home",
      arch: "arm64",
      readFileText: async (path) =>
        path === "/fake-home/.gemini/oauth_creds.json"
          ? JSON.stringify({ access_token: "live-tok", expiry_date: NOW + 3600_000 })
          : null,
    });

    expect(result.status).toBe("ok");
    expect(result.source).toBe("antigravity_api");
    expect(calls.map((c) => c.url)).toEqual([
      "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    ]);
    expect(calls.every((c) => c.tls === undefined)).toBe(true);
    expect(calls.some((c) => c.url.includes("onboardUser"))).toBe(false);
    expect(calls[0]!.userAgent).toBe("antigravity/hub/2.9.1 darwin/arm64");
    expect(calls[1]!.body).toEqual({ project: "my-cloud-project" });

    expect(result.snapshot?.kind).toBe("window");
    if (result.snapshot?.kind === "window") {
      expect(result.snapshot.fiveHour).toEqual({ usedPercent: 18, resetsAt: Date.parse(IN_3H) });
      expect(result.snapshot.weekly).toEqual({ usedPercent: 40, resetsAt: Date.parse(IN_5D) });
      expect(result.snapshot.extra?.planType).toBe("pro");
    }
  });

  test("falls back from retrieveUserQuotaSummary to fetchAvailableModels", async () => {
    const urls: string[] = [];
    const request = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith(":loadCodeAssist")) {
        return Response.json({
          cloudaicompanionProject: "proj-models",
          planInfo: { planType: "g1-ultra-tier" },
        });
      }
      if (url.endsWith(":retrieveUserQuotaSummary")) {
        return new Response("not found", { status: 404 });
      }
      if (url.endsWith(":fetchAvailableModels")) {
        return Response.json({
          models: {
            "gemini-3-pro": {
              displayName: "Gemini 3 Pro",
              quotaInfo: { remainingFraction: 0.6, resetTime: IN_3H },
            },
            "gemini-3-flash": {
              displayName: "Gemini 3 Flash",
              quotaInfo: { remainingFraction: 0.9, resetTime: IN_3H },
            },
            "claude-sonnet": {
              displayName: "Claude Sonnet",
              quotaInfo: { remainingFraction: 0.25, resetTime: IN_5D },
            },
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await collectAntigravity({
      request,
      runCommand: noLocalServer,
      now: () => NOW,
      env: {
        ANTIGRAVITY_OAUTH_CREDENTIALS_JSON: JSON.stringify({
          access_token: "tok-models",
          expiry_date: NOW + 3600_000,
        }),
      },
    });

    expect(result.status).toBe("ok");
    expect(result.source).toBe("antigravity_api");
    expect(urls).toEqual([
      "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    ]);
    expect(result.snapshot?.kind).toBe("window");
    if (result.snapshot?.kind === "window") {
      expect(result.snapshot.fiveHour).toEqual({ usedPercent: 40, resetsAt: Date.parse(IN_3H) });
      expect(result.snapshot.weekly).toBeNull();
      expect(result.snapshot.modelWindows).toEqual({
        "Gemini 3 Flash": { usedPercent: 10, resetsAt: Date.parse(IN_3H) },
        "Claude Sonnet": { usedPercent: 75, resetsAt: Date.parse(IN_5D) },
      });
      expect(result.snapshot.extra?.planType).toBe("ultra");
    }
  });

  test("falls back from retrieveUserQuotaSummary to fetchAvailableModels and then retrieveUserQuota", async () => {
    const urls: string[] = [];
    const request = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith(":loadCodeAssist")) {
        return Response.json({
          cloudaicompanionProject: "proj-str",
          currentTier: { id: "standard-tier", name: "Standard" },
        });
      }
      if (url.endsWith(":retrieveUserQuotaSummary") || url.endsWith(":fetchAvailableModels")) {
        return new Response("unavailable", { status: 404 });
      }
      if (url.endsWith(":retrieveUserQuota")) {
        return Response.json({
          buckets: [
            { modelId: "gemini-3-pro", remainingFraction: 0.75, resetTime: IN_3H },
            { modelId: "gemini-3-pro", remainingFraction: 0.5, resetTime: IN_5D },
            { modelId: "gemini-4-argon", remainingFraction: 0.2, resetTime: IN_5D },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await collectAntigravity({
      request,
      runCommand: noLocalServer,
      now: () => NOW,
      env: {},
      homedir: () => "/fake-home",
      readFileText: async (path) =>
        path === "/fake-home/.codexbar/antigravity/oauth_creds.json"
          ? JSON.stringify({ accessToken: "cb-tok", expiresAt: NOW + 3600_000 })
          : null,
    });

    expect(result.status).toBe("ok");
    expect(result.source).toBe("antigravity_api");
    expect(urls).toEqual([
      "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    ]);
    expect(result.snapshot?.kind).toBe("window");
    if (result.snapshot?.kind === "window") {
      expect(result.snapshot.fiveHour).toEqual({ usedPercent: 25, resetsAt: Date.parse(IN_3H) });
      expect(result.snapshot.weekly).toEqual({ usedPercent: 50, resetsAt: Date.parse(IN_5D) });
      expect(result.snapshot.modelWindows).toEqual({
        "Gemini 4 Argon": { usedPercent: 80, resetsAt: Date.parse(IN_5D) },
      });
      expect(result.snapshot.extra?.planType).toBe("standard");
    }
  });

  test("returns unavailable cleanly when neither local server nor OAuth credentials exist", async () => {
    const result = await collectAntigravity({
      runCommand: noLocalServer,
      now: () => NOW,
      env: {},
      readFileText: async () => null,
    });

    expect(result.status).toBe("unavailable");
    expect(result.snapshot).toBeNull();
    expect(result.error).toContain("no running Antigravity");
    expect(result.error).toContain("no Antigravity OAuth credentials");
  });
});
