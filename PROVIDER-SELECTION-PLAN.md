# Provider selection plan

## Goal

Make Warp supported but opt-in. Publish a sample environment that defaults to Codex and Anthropic, while preserving local configurations that explicitly enable Warp.

## Scope

Repository: `/Users/luis/htdocs/quota-service`

Do not remove the Warp collector or change existing provider response shapes.

Provider selection applies to quota collection and quota-derived responses. `/runs` remains independent because it reports actual local activity rather than enabled quota collectors.

## Changes

1. Add centralized `QUOTA_PROVIDERS` configuration.

   - Accepted values: `codex`, `anthropic`, `warp`.
   - Default when unset: `codex,anthropic`.
   - Parse the comma-separated value once at process startup, trim surrounding whitespace, and reject empty lists, empty entries, duplicate providers, and unknown providers with a clear error.
   - Preserve configured ordering after validation.
   - Use the same validated provider list in the HTTP server, MCP server, and direct CLI fallback.
   - Invalid configuration must terminate startup with a non-zero exit before polling or serving requests; it must not be swallowed by best-effort collection error handling or reported through a healthy `/status` response.

2. Replace fixed provider collection.

   - Update `collectAll()` to invoke only enabled collectors.
   - Return only enabled providers in `/usage`.
   - Do not invoke any disabled collector, including Codex reset-credit collection.
   - Adjust the `collectAll()` return type so it does not claim that disabled providers are present.

3. Apply provider selection consistently.

   - Build `/usage`, `/resets`, CLI output, and MCP `get_usage`/`get_resets` output from the validated provider list in configured order.
   - `/resets` must omit windows and pools for disabled providers. It must return `codexBankedResetCredits: null` when Codex is disabled, even when the database contains an older Codex reset-credit row.
   - `/recommend` and MCP `recommend_model` must build and rank candidates only for enabled providers. Remove assumptions that all three provider reports exist so every valid non-empty subset, including `warp` alone, returns a valid recommendation response instead of throwing.
   - Manual-entry validation in both the HTTP API and direct CLI fallback must reject disabled providers with a clear error.
   - `/status` should expose the enabled provider list in configured order.
   - Keep `/estimate` provider-independent and keep `/runs` based on actual local Codex and Anthropic activity, regardless of quota-provider selection.

4. Add the sample and local environments.

   - Commit `.env.example` containing:

     ```dotenv
     QUOTA_PROVIDERS=codex,anthropic
     QUOTA_PORT=8787
     ```

   - Create a developer-local `.env` containing:

     ```dotenv
     QUOTA_PROVIDERS=codex,anthropic,warp
     ```

   - The local `.env` is intentionally untracked and preserves all-provider behavior on this machine after the default changes.
   - Add `.env` to `.gitignore` before creating it, and verify Git does not report it as an untracked file.

5. Test behavior.

   - Unset `QUOTA_PROVIDERS` collects and returns Codex and Anthropic only.
   - `QUOTA_PROVIDERS=codex,anthropic,warp` retains current all-provider behavior.
   - `QUOTA_PROVIDERS=warp` collects only Warp.
   - Configured ordering is preserved across `/usage`, `/resets`, CLI output, and MCP responses.
   - Empty, malformed, duplicate, and unknown-provider configurations fail clearly at startup for the HTTP server, MCP server, and direct CLI fallback.
   - Disabled collectors are not called.
   - `/resets` omits disabled providers and suppresses stored Codex reset credits when Codex is disabled.
   - `/recommend` and MCP `recommend_model` work for the default list, the full list, and each single-provider configuration without including disabled candidates or throwing.
   - HTTP and direct CLI manual-entry paths reject disabled providers.
   - Add Bun tests with mocked collector functions and isolated temporary databases so tests never call provider APIs, Keychain, or Warp's local plist reader.

6. Update documentation and static copy.

   - Update `HOW-TO-USE.md` with `QUOTA_PROVIDERS` syntax, defaults, startup-failure behavior, examples for enabling Warp, and the distinction between quota-provider selection and `/runs` activity history.
   - Update sample CLI/API output and collector/manual-entry guidance so it no longer implies Warp is enabled by default.
   - Update any dashboard copy that states all three providers are always active; Warp may still be described as supported and opt-in.
   - Document that changing `.env` requires restarting the server or MCP process because configuration is validated once at startup.

## Follow-up in AI Usage Observatory

After quota-service returns only enabled providers, update the Observatory to render quota cards dynamically from `/usage` provider records. Keep ccusage activity charts dynamic: show Warp only if actual Warp usage exists, so totals remain accurate.
