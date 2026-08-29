#!/usr/bin/env bun
// Standalone Claude hook; the empty export marks it a module so top-level await typechecks.
export {};

type MarkerEvent = "session_start" | "session_resume" | "turn_stop" | "session_end";

type HookInput = {
  session_id?: string;
  hook_event_name?: string;
  source?: string;
};

const eventMap: Record<string, MarkerEvent> = {
  SessionStart: "session_start",
  Stop: "turn_stop",
  SessionEnd: "session_end",
};

try {
  const input = JSON.parse(await Bun.stdin.text()) as HookInput;
  const sessionId = input.session_id?.trim();
  let event: MarkerEvent | undefined = input.hook_event_name ? eventMap[input.hook_event_name] : undefined;
  if (event === "session_start" && input.source === "resume") event = "session_resume";
  if (sessionId && event) {
    // QUOTA_SERVICE_URL is a base URL everywhere else in the local toolchain; an absolute
    // path keeps a base and a full /markers URL both resolving to the endpoint.
    const endpoint = new URL("/markers", process.env.QUOTA_SERVICE_URL ?? "http://127.0.0.1:8787");
    const response = await fetch(endpoint, {
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
    // A service older than the /markers route answers 404, and the hook stays silent about
    // it forever. QUOTA_MARKER_DEBUG=1 surfaces that on stderr without breaking fail-open.
    if (!response.ok && process.env.QUOTA_MARKER_DEBUG) {
      console.error(`quota marker: ${endpoint.href} returned ${response.status}`);
    }
  }
} catch (err) {
  // Hooks are fail-open. Quota context must never block Claude.
  if (process.env.QUOTA_MARKER_DEBUG) console.error(`quota marker: ${err instanceof Error ? err.message : String(err)}`);
}
