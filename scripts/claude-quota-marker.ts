#!/usr/bin/env bun

type HookInput = {
  session_id?: string;
  hook_event_name?: string;
  source?: string;
};

const eventMap: Record<string, "session_start" | "turn_stop" | "session_end"> = {
  SessionStart: "session_start",
  Stop: "turn_stop",
  SessionEnd: "session_end",
};

try {
  const input = JSON.parse(await Bun.stdin.text()) as HookInput;
  const sessionId = input.session_id?.trim();
  let event = input.hook_event_name ? eventMap[input.hook_event_name] : undefined;
  if (event === "session_start" && input.source === "resume") event = "session_resume";
  if (sessionId && event) {
    await fetch(process.env.QUOTA_SERVICE_URL ?? "http://127.0.0.1:8787/markers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "anthropic",
        sessionId,
        event,
        occurredAt: Date.now(),
        source: "claude_hook",
      }),
      signal: AbortSignal.timeout(750),
    });
  }
} catch {
  // Hooks are fail-open. Quota context must never block Claude.
}
