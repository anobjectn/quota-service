import { describe, expect, test } from "bun:test";
import { collectAnthropic, planTypeFromOauthProfile } from "../src/collectors/anthropic";

const usageResponse = {
  five_hour: { utilization: 25, resets_at: "2026-09-13T22:30:00Z" },
  seven_day: { utilization: 40, resets_at: "2026-09-16T08:00:00Z" },
  limits: [],
};

function dependencies(profile: unknown, profileStatus = 200) {
  const urls: string[] = [];
  const request = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/api/oauth/usage")) {
      return Response.json(usageResponse);
    }
    return Response.json(profile, { status: profileStatus });
  }) as typeof globalThis.fetch;
  return {
    urls,
    collector: {
      request,
      now: () => 1_000,
      readCredentials: async () => ({
        ok: true as const,
        oauth: { accessToken: "test-token", subscriptionType: "max" },
      }),
    },
  };
}

describe("Anthropic OAuth profile plans", () => {
  test("maps the two Claude Max rate-limit tiers", () => {
    expect(planTypeFromOauthProfile({
      organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_5x" },
    })).toBe("max_5x");
    expect(planTypeFromOauthProfile({
      organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" },
    })).toBe("max_20x");
  });

  test("records the specific profile plan beside the generic credential plan", async () => {
    const { collector, urls } = dependencies({
      organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" },
    });
    const result = await collectAnthropic(collector);

    expect(urls).toEqual([
      "https://api.anthropic.com/api/oauth/usage",
      "https://api.anthropic.com/api/oauth/profile",
    ]);
    expect(result.status).toBe("ok");
    expect(result.snapshot?.extra).toMatchObject({
      planType: "max_20x",
      planSource: "oauth_profile",
      rateLimitTier: "default_claude_max_20x",
      subscriptionType: "max",
    });
  });

  test("keeps usage available when the optional profile request fails", async () => {
    const { collector } = dependencies({ error: "rate limited" }, 429);
    const result = await collectAnthropic(collector);

    expect(result.status).toBe("ok");
    expect(result.snapshot?.extra).toMatchObject({
      rateLimitTier: null,
      subscriptionType: "max",
    });
    expect(result.snapshot?.extra).not.toHaveProperty("planType");
  });

  test("keeps usage available when the optional profile request throws", async () => {
    const base = dependencies({});
    const request = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      if (String(input).endsWith("/api/oauth/profile")) throw new Error("network unavailable");
      return Response.json(usageResponse);
    }) as typeof globalThis.fetch;
    const result = await collectAnthropic({ ...base.collector, request });

    expect(result.status).toBe("ok");
    expect(result.snapshot?.extra).not.toHaveProperty("planType");
  });
});
