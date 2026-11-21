import { describe, expect, test } from "bun:test";
import {
  ANTIGRAVITY_POLL_FLOOR_MS,
  collectAntigravity,
  normalizeAntigravityPlanType,
  normalizeAvailableModels,
  normalizeQuotaSummary,
  parseAntigravityOauthCredentials,
  parseAntigravityProcesses,
  parseListeningEndpoints,
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

  test("detects unquoted agy and language_server paths with spaces without matching unrelated commands", () => {
    const psOutput = [
      "  101 /usr/bin/grep language_server antigravity",
      "  102 /usr/bin/grep /Applications/My Apps/agy",
      "  103 /usr/bin/vim notes/agy",
      "  104 /opt/homebrew/bin/rg -n /Users/luis/My Tools/agy",
      "  108 /opt/homebrew/bin/nvim notes/agy",
      "  109 /usr/local/bin/python3 scripts/agy",
      "  110 /Users/luis/.bun/bin/bun run tools/agy",
      "  111 /Applications/Windsurf.app/Contents/Resources/language_server_macos_arm --workspace_id file_Users_luis_Work_antigravity --csrf_token ws-tok",
      "  105 /Applications/My Apps/Antigravity/bin/agy serve --port 52100",
      "  106 /Users/luis/Library/Application Support/Google Antigravity/language_server_macos_arm --csrf_token --extension_server_port 52200",
      '  107 "/Users/luis/My Tools/agy" --serve',
    ].join("\n");

    const procs = parseAntigravityProcesses(psOutput);
    expect(procs.map((p) => p.pid)).toEqual([106, 105, 107]);
    expect(procs[0]).toMatchObject({
      pid: 106,
      kind: "language_server",
      csrfToken: null,
      extensionServerPort: 52200,
    });
    expect(procs[1]).toMatchObject({ pid: 105, kind: "agy", csrfToken: null });
    expect(procs[2]).toMatchObject({ pid: 107, kind: "agy", csrfToken: null });
  });

  test("parses deduplicated loopback listening endpoints preserving IPv4 vs IPv6", () => {
    const lsofOutput = [
      "COMMAND     PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "language_  404 luis   12u  IPv4 0x1234      0t0  TCP 127.0.0.1:54321 (LISTEN)",
      "language_  404 luis   13u  IPv6 0x1235      0t0  TCP [::1]:54321 (LISTEN)",
      "language_  404 luis   14u  IPv4 0x1236      0t0  TCP 192.168.1.50:9999 (LISTEN)",
      "language_  404 luis   15u  IPv4 0x1237      0t0  TCP 127.0.0.1:54322 (ESTABLISHED)",
      "language_  404 luis   16u  IPv4 0x1238      0t0  TCP *:54323 (LISTEN)",
      "language_  404 luis   17u  IPv6 0x1239      0t0  TCP [::1]:54324 (LISTEN)",
      "language_  404 luis   18u  IPv6 0x1240      0t0  TCP *:54325 (LISTEN)",
    ].join("\n");

    expect(parseListeningEndpoints(lsofOutput)).toEqual([
      { host: "127.0.0.1", port: 54321 },
      { host: "127.0.0.1", port: 54323 },
      { host: "[::1]", port: 54324 },
      { host: "[::1]", port: 54325 },
    ]);
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
    expect(normalizeAntigravityPlanType("Google AI Plus")).toBe("plus");
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

  test("classifies underscore-separated identifiers and protobuf duration strings without guessing fiveHour from short horizon", () => {
    const snap = normalizeQuotaSummary(
      {
        groups: [
          {
            displayName: "Gemini",
            buckets: [
              // Underscore-only identifier and protobuf duration string ("18000s" = 5h)
              {
                bucketId: "gemini_5h",
                window: { duration: "18000s" },
                remainingFraction: 0.7,
                resetTime: IN_3H,
              },
              {
                bucketId: "gemini_weekly",
                window: "QUOTA_WINDOW_WEEKLY",
                remainingFraction: 0.8,
                resetTime: IN_3H, // Even with 3h left, explicit weekly metadata wins
              },
              // Unlabeled bucket with <= 6h remaining must NOT be guessed as fiveHour
              {
                bucketId: "mystery_bucket",
                remainingFraction: 0.5,
                resetTime: IN_3H,
              },
            ],
          },
          {
            displayName: "Gemini 4 Argon",
            buckets: [
              // Unset protobuf timestamp { seconds: 0 } yields resetsAt: null
              {
                bucketId: "argon_pool",
                remainingFraction: 0.6,
                resetTime: { seconds: 0, nanos: 0 },
              },
            ],
          },
        ],
      },
      NOW,
    );

    expect(snap).not.toBeNull();
    expect(snap!.fiveHour).toEqual({ usedPercent: 30, resetsAt: Date.parse(IN_3H) });
    expect(snap!.weekly).toEqual({ usedPercent: 20, resetsAt: Date.parse(IN_3H) });
    expect(snap!.modelWindows).toEqual({
      mystery_bucket: { usedPercent: 50, resetsAt: Date.parse(IN_3H) },
      "Gemini 4 Argon": { usedPercent: 40, resetsAt: null },
    });
  });

  test("never guesses fiveHour from <= 6h remaining time on an unlabeled QuotaSummary bucket", () => {
    const snap = normalizeQuotaSummary(
      {
        groups: [
          {
            displayName: "Gemini",
            buckets: [
              {
                bucketId: "primary_pool",
                displayName: "Gemini Pro",
                remainingFraction: 0.4,
                resetTime: IN_3H,
              },
            ],
          },
        ],
      },
      NOW,
    );

    expect(snap).not.toBeNull();
    expect(snap!.fiveHour).toBeNull();
    expect(snap!.weekly).toBeNull();
    expect(snap!.modelWindows).toEqual({
      "Gemini Pro": { usedPercent: 60, resetsAt: Date.parse(IN_3H) },
    });
  });

  test("keeps non-5h/non-weekly explicit durations (60s, 3600s, 20d) in modelWindows and prefers structured labels over descriptions", () => {
    const snap = normalizeQuotaSummary(
      {
        groups: [
          {
            displayName: "Gemini",
            buckets: [
              { bucketId: "rpm", window: "60s", remainingFraction: 0.1, resetTime: IN_3H },
              { window: "3600s", remainingFraction: 0.5, resetTime: IN_3H },
              { bucketId: "gemini_5h", window: "18000s", remainingFraction: 0.8, resetTime: IN_3H },
              {
                bucketId: "gemini_weekly",
                displayName: "Weekly",
                description: "Independent of 5h session limit",
                remainingFraction: 0.65,
                resetTime: IN_5D,
              },
              { bucketId: "monthly_cap", window: "1728000s", remainingFraction: 0.9, resetTime: IN_5D },
            ],
          },
        ],
      },
      NOW,
    );

    expect(snap).not.toBeNull();
    expect(snap!.fiveHour).toEqual({ usedPercent: 20, resetsAt: Date.parse(IN_3H) });
    expect(snap!.weekly).toEqual({ usedPercent: 35, resetsAt: Date.parse(IN_5D) });
    expect(snap!.modelWindows).toEqual({
      rpm: { usedPercent: 90, resetsAt: Date.parse(IN_3H) },
      "1h": { usedPercent: 50, resetsAt: Date.parse(IN_3H) },
      monthly_cap: { usedPercent: 10, resetsAt: Date.parse(IN_5D) },
    });

    // Standalone 1h bucket stays in modelWindows without populating fiveHour.
    const oneHourOnly = normalizeQuotaSummary(
      { groups: [{ displayName: "Gemini", buckets: [{ window: "3600s", remainingFraction: 0.5 }] }] },
      NOW,
    );
    expect(oneHourOnly).not.toBeNull();
    expect(oneHourOnly!.fiveHour).toBeNull();
    expect(oneHourOnly!.modelWindows).toEqual({ "1h": { usedPercent: 50, resetsAt: null } });

    // Malformed non-array buckets returns null cleanly instead of throwing.
    expect(normalizeQuotaSummary({ groups: [{ buckets: {} as unknown as [] }] }, NOW)).toBeNull();
  });

  test("keeps per-model fallback horizons (2d, 4d, 20d) stably in modelWindows without jumping across cycles", () => {
    for (const days of [2, 4, 20]) {
      const reset = new Date(NOW + days * 24 * 3600 * 1000).toISOString();
      const snap = normalizeAvailableModels(
        {
          models: {
            "gemini-3-pro": {
              displayName: "Gemini 3 Pro",
              quotaInfo: { remainingFraction: 0.4, resetTime: reset },
            },
          },
        },
        NOW,
      );
      expect(snap).not.toBeNull();
      expect(snap!.fiveHour).toBeNull();
      expect(snap!.weekly).toBeNull();
      expect(snap!.modelWindows).toEqual({
        "Gemini 3 Pro": { usedPercent: 60, resetsAt: Date.parse(reset) },
      });
    }
  });
});

describe("Antigravity Tactic A (antigravity_local)", () => {
  test("queries local RetrieveUserQuotaSummary over loopback HTTPS with self-signed TLS and enriches plan via GetUserStatus", async () => {
    expect(ANTIGRAVITY_POLL_FLOOR_MS).toBe(60_000);
    const seenRequests: Array<{ url: string; headers: Record<string, string>; tls: unknown; redirect: unknown }> = [];

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
        redirect: init?.redirect,
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
    expect(seenRequests[0]!.redirect).toBe("error");
  });

  test("falls back from HTTP 400 to HTTPS on extensionServerPort when the server requires TLS", async () => {
    const calls: string[] = [];
    const runCommand = async (argv: string[]): Promise<AntigravityCommandOutput> =>
      argv[0] === "ps"
        ? {
            exitCode: 0,
            stdout: "  900 /Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token tok --extension_server_port 51001\n",
            stderr: "",
          }
        : {
            exitCode: 0,
            stdout: "language_ 900 luis 10u IPv4 0x1 0t0 TCP 127.0.0.1:51001 (LISTEN)\n",
            stderr: "",
          };

    const request = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("http://127.0.0.1:51001/")) {
        return new Response("Client sent an HTTP request to an HTTPS server.\n", { status: 400 });
      }
      if (url.endsWith("/RetrieveUserQuotaSummary")) {
        return Response.json({
          groups: [{ displayName: "Gemini", buckets: [{ bucketId: "gemini_5h", window: "18000s", remainingFraction: 0.7, resetTime: IN_3H }] }],
        });
      }
      return Response.json({});
    }) as typeof globalThis.fetch;

    const result = await collectAntigravity({ request, runCommand, now: () => NOW, env: {}, readFileText: async () => null });
    expect(result.status).toBe("ok");
    expect(result.source).toBe("antigravity_local");
    expect(calls[0]).toStartWith("http://127.0.0.1:51001/");
    expect(calls[1]).toStartWith("https://127.0.0.1:51001/");
    if (result.snapshot?.kind === "window") {
      expect(result.snapshot.fiveHour).toEqual({ usedPercent: 30, resetsAt: Date.parse(IN_3H) });
    }
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
  test("prefers userTier over a generic planInfo name when reporting planType", async () => {
    const runCommand = async (argv: string[]): Promise<AntigravityCommandOutput> =>
      argv[0] === "ps"
        ? { exitCode: 0, stdout: "  900 /Applications/Antigravity.app/Contents/Resources/language_server_macos_arm --csrf_token t\n", stderr: "" }
        : { exitCode: 0, stdout: "language_ 900 luis 10u IPv4 0x1 0t0 TCP 127.0.0.1:51000 (LISTEN)\n", stderr: "" };
    const collectWithUserTier = (userTier: Record<string, string>) => {
      const request = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
        const url = String(input);
        if (url.endsWith("/RetrieveUserQuotaSummary")) {
          return Response.json({
            groups: [{ displayName: "Gemini", buckets: [{ displayName: "5h", remainingFraction: 0.5, resetTime: IN_3H }] }],
          });
        }
        if (url.endsWith("/GetUserStatus")) {
          return Response.json({
            userStatus: { userTier, planStatus: { planInfo: { planDisplayName: "Pro" } } },
          });
        }
        return new Response("not found", { status: 404 });
      }) as typeof globalThis.fetch;
      return collectAntigravity({ request, runCommand, now: () => NOW });
    };

    const named = await collectWithUserTier({ id: "g1-ultra-tier", name: "Google AI Ultra" });
    expect(named.snapshot?.extra).toMatchObject({ planType: "ultra", rawPlanName: "Google AI Ultra" });

    const idOnly = await collectWithUserTier({ id: "g1-ultra-tier" });
    expect(idOnly.snapshot?.extra).toMatchObject({ planType: "ultra", tierId: "g1-ultra-tier" });

    const canonicalIdOnly = await collectWithUserTier({ id: "ultra" });
    expect(canonicalIdOnly.snapshot?.extra).toMatchObject({ planType: "ultra", tierId: "ultra" });
  });

  test("connects to IPv6-only loopback ([::1]) listeners with loopback-scoped self-signed TLS", async () => {
    const seenRequests: Array<{ url: string; tls: unknown }> = [];
    const runCommand = async (argv: string[]): Promise<AntigravityCommandOutput> =>
      argv[0] === "ps"
        ? { exitCode: 0, stdout: "  910 /Applications/Antigravity.app/Contents/Resources/language_server_macos_arm --csrf_token v6-tok\n", stderr: "" }
        : { exitCode: 0, stdout: "language_ 910 luis 10u IPv6 0x9 0t0 TCP [::1]:51099 (LISTEN)\n", stderr: "" };

    const request = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const url = String(input);
      seenRequests.push({ url, tls: (init as { tls?: unknown } | undefined)?.tls });
      if (url.startsWith("https://[::1]:51099/") && url.endsWith("/RetrieveUserQuotaSummary")) {
        return Response.json({
          groups: [{ displayName: "Gemini", buckets: [{ displayName: "5h", remainingFraction: 0.8, resetTime: IN_3H }] }],
        });
      }
      if (url.startsWith("https://[::1]:51099/") && url.endsWith("/GetUserStatus")) {
        return Response.json({ userStatus: { userTier: { id: "g1-pro-tier", name: "Google AI Pro" } } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await collectAntigravity({ request, runCommand, now: () => NOW });
    expect(result.status).toBe("ok");
    expect(result.source).toBe("antigravity_local");
    expect(seenRequests.map((r) => r.url)).toEqual([
      "https://[::1]:51099/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
      "https://[::1]:51099/exa.language_server_pb.LanguageServerService/GetUserStatus",
    ]);
    expect(seenRequests[0]!.tls).toEqual({ rejectUnauthorized: false });
    expect(result.snapshot?.extra).toMatchObject({ planType: "pro", loopbackHost: "[::1]" });
  });

  test("bounds a hung local port by the probe budget and still reaches the OAuth fallback", async () => {
    const runCommand = async (argv: string[]): Promise<AntigravityCommandOutput> =>
      argv[0] === "ps"
        ? { exitCode: 0, stdout: "  900 /Applications/Antigravity.app/Contents/Resources/language_server_macos_arm --csrf_token t\n", stderr: "" }
        : { exitCode: 0, stdout: "language_ 900 luis 10u IPv4 0x1 0t0 TCP 127.0.0.1:51000 (LISTEN)\n", stderr: "" };
    const request = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.includes("127.0.0.1")) {
        // Simulates a socket that accepts but never answers (e.g. a raw LSP port).
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      if (url.endsWith(":retrieveUserQuotaSummary")) {
        return Response.json({
          groups: [{ displayName: "Gemini", buckets: [{ displayName: "5h", remainingFraction: 0.5, resetTime: IN_3H }] }],
        });
      }
      return Response.json({});
    }) as typeof globalThis.fetch;

    const started = Date.now();
    const result = await collectAntigravity({
      request,
      runCommand,
      now: () => NOW,
      localProbeBudgetMs: 200,
      env: {
        ANTIGRAVITY_OAUTH_CREDENTIALS_JSON: JSON.stringify({ access_token: "tok", expiry_date: NOW + 3600_000 }),
      },
    });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.status).toBe("ok");
    expect(result.source).toBe("antigravity_api");
  });
});

describe("Antigravity Tactic B (antigravity_api)", () => {
  const noLocalServer = async (): Promise<AntigravityCommandOutput> => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });

  test("reads OAuth credentials in priority order, rejects arrays, and parses antigravity-cli nested token shape", () => {
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

    const arrayCreds = parseAntigravityOauthCredentials("[]", "inline");
    expect(arrayCreds.ok).toBe(false);
    if (!arrayCreds.ok) {
      expect(arrayCreds.error).toContain("must be a JSON object");
    }

    // Epoch 0 / empty seconds must not be mistaken for an expired timestamp.
    const zeroExpiry = parseAntigravityOauthCredentials(
      JSON.stringify({ access_token: "tok", expiry: { seconds: "" } }),
      "inline",
    );
    expect(zeroExpiry.ok).toBe(true);
    if (zeroExpiry.ok) {
      expect(zeroExpiry.credential.expiresAt).toBeNull();
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

  test("falls back from retrieveUserQuotaSummary to fetchAvailableModels without guessing fiveHour from <= 6h horizon", async () => {
    const urls: string[] = [];
    const request = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith(":loadCodeAssist")) {
        return Response.json({
          cloudaicompanionProject: "proj-models",
          paidTier: { id: "g1-ultra-tier" },
          planInfo: { planDisplayName: "Pro" },
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
      // Never guess fiveHour from remaining time <= 6h on horizon-only endpoints.
      expect(result.snapshot.fiveHour).toBeNull();
      expect(result.snapshot.weekly).toBeNull();
      expect(result.snapshot.modelWindows).toEqual({
        "Gemini 3 Pro": { usedPercent: 40, resetsAt: Date.parse(IN_3H) },
        "Gemini 3 Flash": { usedPercent: 10, resetsAt: Date.parse(IN_3H) },
        "Claude Sonnet": { usedPercent: 75, resetsAt: Date.parse(IN_5D) },
      });
      // Recognized paidTier.id beats generic planInfo.planDisplayName.
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
      expect(result.snapshot.fiveHour).toBeNull();
      expect(result.snapshot.weekly).toBeNull();
      expect(result.snapshot.modelWindows).toEqual({
        "Gemini 3 Pro": { usedPercent: 50, resetsAt: Date.parse(IN_5D) },
        "Gemini 4 Argon": { usedPercent: 80, resetsAt: Date.parse(IN_5D) },
      });
      expect(result.snapshot.extra?.planType).toBe("standard");
    }
  });

  test("continues to fallback endpoint when retrieveUserQuotaSummary returns malformed non-array buckets", async () => {
    const urls: string[] = [];
    const request = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith(":loadCodeAssist")) return Response.json({});
      if (url.endsWith(":retrieveUserQuotaSummary")) {
        return Response.json({ groups: [{ name: "Gemini", buckets: {} }] });
      }
      if (url.endsWith(":fetchAvailableModels")) {
        return Response.json({
          models: {
            "gemini-4-neon": { displayName: "Gemini 4 Neon", quotaInfo: { remainingFraction: 0.75, resetTime: IN_3H } },
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
        ANTIGRAVITY_OAUTH_CREDENTIALS_JSON: JSON.stringify({ access_token: "tok", expiry_date: NOW + 3600_000 }),
      },
    });

    expect(result.status).toBe("ok");
    expect(result.source).toBe("antigravity_api");
    expect(urls).toEqual([
      "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    ]);
    if (result.snapshot?.kind === "window") {
      expect(result.snapshot.modelWindows).toEqual({
        "Gemini 4 Neon": { usedPercent: 25, resetsAt: Date.parse(IN_3H) },
      });
    }
  });

  test("honors OAuth credential priority order, explicit path errors, and skips expired/malformed home files", async () => {
    const usedTokens: string[] = [];
    const request = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const url = String(input);
      const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? "";
      if (url.endsWith(":loadCodeAssist")) {
        usedTokens.push(auth);
        return Response.json({});
      }
      if (url.endsWith(":retrieveUserQuotaSummary")) {
        return Response.json({
          groups: [{ displayName: "Gemini", buckets: [{ displayName: "5h", remainingFraction: 0.9, resetTime: IN_3H }] }],
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    // 1) ANTIGRAVITY_OAUTH_CREDENTIALS_JSON overrides QUOTA_ANTIGRAVITY_AUTH_PATH.
    const fromEnv = await collectAntigravity({
      request,
      runCommand: noLocalServer,
      now: () => NOW,
      env: {
        ANTIGRAVITY_OAUTH_CREDENTIALS_JSON: JSON.stringify({ access_token: "inline-tok", expiry_date: NOW + 3600_000 }),
        QUOTA_ANTIGRAVITY_AUTH_PATH: "/explicit/oauth.json",
      },
      readFileText: async () => JSON.stringify({ access_token: "file-tok", expiry_date: NOW + 3600_000 }),
    });
    expect(fromEnv.status).toBe("ok");
    expect(usedTokens.at(-1)).toBe("Bearer inline-tok");

    // 2) Missing QUOTA_ANTIGRAVITY_AUTH_PATH fails cleanly without falling through to home files.
    const missingExplicit = await collectAntigravity({
      request,
      runCommand: noLocalServer,
      now: () => NOW,
      env: { QUOTA_ANTIGRAVITY_AUTH_PATH: "/missing/oauth.json" },
      homedir: () => "/fake-home",
      readFileText: async (path) =>
        path === "/fake-home/.gemini/oauth_creds.json"
          ? JSON.stringify({ access_token: "home-tok", expiry_date: NOW + 3600_000 })
          : null,
    });
    expect(missingExplicit.status).toBe("unavailable");
    expect(missingExplicit.error).toContain("QUOTA_ANTIGRAVITY_AUTH_PATH");

    // 3) Malformed first home file and expired second home file fall through to valid third home file.
    const fallbackHome = await collectAntigravity({
      request,
      runCommand: noLocalServer,
      now: () => NOW,
      env: {},
      homedir: () => "/fake-home",
      readFileText: async (path) => {
        if (path === "/fake-home/.gemini/antigravity-cli/antigravity-oauth-token") return "{not-json";
        if (path === "/fake-home/.gemini/oauth_creds.json") {
          return JSON.stringify({ access_token: "expired-home-tok", expiry_date: NOW - 10_000 });
        }
        if (path === "/fake-home/.codexbar/antigravity/oauth_creds.json") {
          return JSON.stringify({ access_token: "valid-third-tok", expiry_date: NOW + 3600_000 });
        }
        return null;
      },
    });
    expect(fallbackHome.status).toBe("ok");
    expect(usedTokens.at(-1)).toBe("Bearer valid-third-tok");
  });

  test("bounds sequential Cloud Code OAuth calls within the shared API budget", async () => {
    // Case 1: loadCodeAssist stalls, per-call cap aborts it and leaves room for retrieveUserQuotaSummary.
    const partialRequest = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(":loadCodeAssist")) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      if (url.endsWith(":retrieveUserQuotaSummary")) {
        return Response.json({
          groups: [{ displayName: "Gemini", buckets: [{ displayName: "5h", remainingFraction: 0.7, resetTime: IN_3H }] }],
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const partialStart = Date.now();
    const partialResult = await collectAntigravity({
      request: partialRequest,
      runCommand: noLocalServer,
      now: () => NOW,
      cloudApiBudgetMs: 250,
      env: {
        ANTIGRAVITY_OAUTH_CREDENTIALS_JSON: JSON.stringify({ access_token: "tok", expiry_date: NOW + 3600_000 }),
      },
    });
    expect(Date.now() - partialStart).toBeLessThan(1_500);
    expect(partialResult.status).toBe("ok");
    expect(partialResult.source).toBe("antigravity_api");

    // Case 2: all Cloud Code calls stall; total time stays bounded and returns unavailable cleanly.
    const hungCalls: string[] = [];
    const hungRequest = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      hungCalls.push(String(input));
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as typeof globalThis.fetch;

    const hungStart = Date.now();
    const hungResult = await collectAntigravity({
      request: hungRequest,
      runCommand: noLocalServer,
      now: () => NOW,
      cloudApiBudgetMs: 200,
      env: {
        ANTIGRAVITY_OAUTH_CREDENTIALS_JSON: JSON.stringify({ access_token: "tok", expiry_date: NOW + 3600_000 }),
      },
    });
    expect(Date.now() - hungStart).toBeLessThan(1_500);
    expect(hungResult.status).toBe("unavailable");
    expect(hungResult.source).toBe("antigravity_api");
    expect(hungResult.error).toContain("budget");
    expect(hungCalls.length).toBeLessThanOrEqual(2);
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
