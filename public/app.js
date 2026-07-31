// quota-service dashboard — vanilla JS, no framework, no build step.
// Reads GET /usage, GET /runs, GET /resets, GET /recommend?taskProfile=..., and posts
// to POST /manual (Warp add-on credits). Read-only against provider systems
// everywhere else — this file never calls a consume/purchase endpoint.

const PROVIDER_LABEL = { codex: "Codex", anthropic: "Anthropic", warp: "Warp" };
const PROVIDER_SUB = {
  codex: "ChatGPT Plus — 5h / weekly windows",
  anthropic: "Claude Code Pro — 5h / weekly windows",
  warp: "monthly request pool",
};
// Best-effort billing/usage links — links only, never automated. Verify
// these still resolve if a provider reshuffles their settings UI.
const PURCHASE_LINKS = {
  codex: "https://chatgpt.com/#settings/Subscription",
  anthropic: "https://claude.ai/settings/billing",
  warp: "warp://settings/billing",
};
const SUPPORT_LINKS = {
  anthropicLimits: "https://support.claude.com/en/articles/11647753-understanding-usage-and-length-limits",
  anthropicCredits: "https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans",
};

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function statusColorVar(status) {
  if (status === "ok") return "var(--status-ok)";
  if (status === "stale") return "var(--status-warning)";
  return "var(--status-critical)";
}
function statusGlowVar(status) {
  if (status === "ok") return "var(--status-ok-glow)";
  if (status === "stale") return "var(--status-warning-glow)";
  return "var(--status-critical-glow)";
}

/** Usage-magnitude → status color (this is the "how full is it" reading,
 * independent of collector freshness). <60 good, 60-84 warning, >=85 critical. */
function usageColor(percent) {
  if (percent == null) return "var(--ink-muted)";
  if (percent >= 85) return "var(--status-critical)";
  if (percent >= 60) return "var(--status-warning)";
  return "var(--status-ok)";
}

function fmtAge(ms) {
  if (ms == null) return "unknown";
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function fmtCountdown(ts) {
  if (ts == null) return "unknown";
  const diff = ts - Date.now();
  if (diff <= 0) return "now";
  const sec = Math.floor(diff / 1000);
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ${min % 60}m`;
  const days = Math.floor(hr / 24);
  return `${days}d ${hr % 24}h`;
}

function fmtDate(ts) {
  if (ts == null) return "unknown";
  // Provider expiry dates are account-wide calendar dates, commonly encoded
  // as midnight UTC. Render in UTC so US time zones do not show the prior day.
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function fmtMoney(amount, currency = "USD") {
  if (amount == null) return "—";
  try {
    return new Intl.NumberFormat([], { style: "currency", currency }).format(amount);
  } catch {
    return `$${Number(amount).toFixed(2)}`;
  }
}

function fmtTokens(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return value.toLocaleString();
}

function fmtRunTime(run) {
  const start = new Date(run.startedAt);
  const durationMs = Math.max(0, run.endedAt - run.startedAt);
  const durationMin = Math.max(1, Math.round(durationMs / 60_000));
  const duration = durationMin >= 60 ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m` : `${durationMin}m`;
  const today = new Date();
  const sameDay = start.toDateString() === today.toDateString();
  const day = sameDay ? "" : `${start.toLocaleDateString([], { month: "short", day: "numeric" })}, `;
  return `${day}${start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${duration}`;
}

function renderRunHistory(provider, runs = [], snapshot = null) {
  if (provider === "warp") return "";
  const fiveHourStart = snapshot?.kind === "window" && snapshot.fiveHour?.resetsAt
    ? snapshot.fiveHour.resetsAt - 5 * 60 * 60_000
    : null;
  const windowRuns = fiveHourStart ? runs.filter((run) => run.endedAt >= fiveHourStart) : [];
  const windowTokens = windowRuns.reduce((sum, run) => sum + run.totalTokens, 0);
  const windowCost = windowRuns.reduce((sum, run) => sum + run.apiEquivalentUsd, 0);
  const windowSummary = fiveHourStart && windowRuns.length
    ? `<div class="run-window-summary"><b>${windowRuns.length}</b> run${windowRuns.length === 1 ? "" : "s"} since ${new Date(fiveHourStart).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}<span>${fmtTokens(windowTokens)} tokens · ≈ $${windowCost.toFixed(2)}</span></div>`
    : "";
  const rows = runs.length
    ? runs.map((run) => {
        const effort = run.effort ? `<span class="run-effort${run.effort === "ultra" ? " is-ultra" : ""}">${esc(run.effort)}</span>` : "";
        const cache = run.cachedInputTokens + run.cacheWriteTokens;
        return `<li class="run-row">
          <div class="run-primary">
            <div class="run-title" title="${esc(run.title)}">${run.isSubagent ? '<span class="run-agent">agent</span>' : ""}${esc(run.title)}</div>
            <span class="run-when">${esc(fmtRunTime(run))}</span>
          </div>
          <div class="run-model-line">
            <span class="run-model">${esc(run.model)}</span>${effort}
            <span class="run-cost" title="List rate: ${esc(run.rateLabel)}">≈ $${run.apiEquivalentUsd.toFixed(2)} API</span>
          </div>
          <div class="run-token-line" aria-label="${run.totalTokens.toLocaleString()} total tokens">
            <span><b>${fmtTokens(run.totalTokens)}</b> total</span>
            <span>in ${fmtTokens(run.inputTokens)}</span>
            ${cache ? `<span>cache ${fmtTokens(cache)}</span>` : ""}
            <span>out ${fmtTokens(run.outputTokens)}</span>
          </div>
        </li>`;
      }).join("")
    : `<li class="run-empty">No local run telemetry found.</li>`;
  return `<section class="run-history" aria-label="Recent ${esc(PROVIDER_LABEL[provider])} runs">
    <div class="run-history-head">
      <span>recent runs</span>
      <span>API equivalent</span>
    </div>
    ${windowSummary}
    <ol class="run-list" tabindex="0" aria-label="Scrollable recent run history">${rows}</ol>
    <p class="run-disclaimer">Local session logs · cached input is priced separately · quota % is provider-controlled</p>
  </section>`;
}

function arcGauge(percent, color, size = 92, stroke = 9) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const used = Math.max(0, Math.min(100, percent ?? 0)) / 100 * c;
  const cx = size / 2, cy = size / 2;
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${(percent ?? 0).toFixed(0)}% used">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="${stroke}" />
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}"
        stroke-width="${stroke}" stroke-linecap="round"
        stroke-dasharray="${used} ${c - used}"
        transform="rotate(-90 ${cx} ${cy})"
        style="transition: stroke-dasharray 0.6s ease;" />
    </svg>`;
}

function statusPill(status) {
  const label = { ok: "Ok", stale: "Stale", unavailable: "Unavailable", unknown: "Unknown" }[status] ?? status;
  return `<span class="status-pill" data-status="${status}"><span class="dot"></span>${label}</span>`;
}

function renderCreditLedger(p) {
  const credits = p.snapshot?.usageCredits;
  const codexCredits = p.snapshot?.codexCredits;
  const web = p.provider === "anthropic" ? p.anthropicWebCredits : null;
  if (!credits && !codexCredits && !web) return "";

  const monthlyPercent = credits?.limitAmount
    ? Math.min(100, credits.spentAmount / credits.limitAmount * 100)
    : null;
  const promo = web?.promotionalTranches?.[0];
  const campaignLabel = web?.campaign?.id === "fable_transition"
    ? "Fable transition"
    : web?.campaign?.id?.replaceAll("_", " ");
  const importedAge = web ? fmtAge(Date.now() - web.capturedAt) : null;

  const isCodex = p.provider === "codex";
  return `<section class="credit-ledger" aria-label="${isCodex ? "Codex credits" : "Anthropic usage credits"}">
    <div class="credit-ledger-head">
      <div>
        <span class="eyebrow">${isCodex ? "account credits" : "usage credits"}</span>
        <strong>Spend &amp; balance</strong>
      </div>
      ${credits
        ? `<span class="credits-badge ${credits.enabled ? "credits-badge-on" : "credits-badge-off"}">${credits.enabled ? "enabled" : "disabled"}</span>`
        : ""}
    </div>
    <div class="credit-metrics">
      ${credits ? `<div class="credit-metric">
        <span>monthly spend</span>
        <strong>${fmtMoney(credits.spentAmount, credits.currency)}</strong>
        <small>of ${fmtMoney(credits.limitAmount, credits.currency)} cap${monthlyPercent == null ? "" : ` · ${monthlyPercent.toFixed(0)}%`}</small>
      </div>` : ""}
      ${codexCredits ? `<div class="credit-metric">
        <span>balance</span>
        <strong>${codexCredits.unlimited ? "unlimited" : codexCredits.balance == null ? "—" : codexCredits.balance.toLocaleString()}</strong>
        <small>OpenAI account credits · ${codexCredits.hasCredits ? "available" : "not available"}</small>
      </div>` : ""}
      ${p.provider === "anthropic" ? `<div class="credit-metric ${web ? "" : "is-missing"}">
        <span>prepaid balance</span>
        <strong>${web ? fmtMoney(web.currentBalance, web.currency) : "not imported"}</strong>
        <small>${web ? `Claude Web · ${importedAge}` : "Web-session data; add it below"}</small>
      </div>` : ""}
      ${promo ? `<div class="credit-metric credit-metric-promo">
        <span>promotional credit</span>
        <strong>${fmtMoney(promo.remainingAmount, web.currency)}</strong>
        <small>expires ${fmtDate(promo.expiresAt)}</small>
      </div>` : ""}
    </div>
    ${web ? `<div class="credit-context">
      ${campaignLabel ? `<span class="campaign-tag">${esc(campaignLabel)}</span>` : ""}
      ${web.campaign?.amount != null ? `<span>${fmtMoney(web.campaign.amount, web.currency)} granted</span>` : ""}
      <span>auto-reload ${web.autoReloadEnabled == null ? "unknown" : web.autoReloadEnabled ? "on" : "off"}</span>
      ${web.purchases?.maxDiscountPercent != null ? `<span>bundles up to ${web.purchases.maxDiscountPercent.toFixed(0)}% off</span>` : ""}
    </div>` : ""}
  </section>`;
}

function inputValue(value) {
  return value == null ? "" : esc(value);
}

function dateInputValue(ts) {
  return ts == null ? "" : new Date(ts).toISOString().slice(0, 10);
}

function renderAnthropicImportForm(web) {
  const promo = web?.promotionalTranches?.[0];
  return `<form class="claude-import-form manual-form" data-claude-import-form>
    <div class="import-form-intro">
      <strong>Update Claude Web snapshot</strong>
      <span>Copy these figures from Claude Settings → Usage. No cookies or credentials are stored.</span>
    </div>
    <div class="import-grid">
      <label class="manual-field"><span>Current balance</span><input type="number" min="0" step="0.01" name="currentBalance" value="${inputValue(web?.currentBalance)}" placeholder="84.97" /></label>
      <label class="manual-field"><span>Promo remaining</span><input type="number" min="0" step="0.01" name="promoRemaining" value="${inputValue(promo?.remainingAmount)}" placeholder="84.96" /></label>
      <label class="manual-field"><span>Original grant</span><input type="number" min="0" step="0.01" name="promoGranted" value="${inputValue(promo?.grantedAmount)}" placeholder="100.00" /></label>
      <label class="manual-field"><span>Promo expires</span><input type="date" name="promoExpiresAt" value="${dateInputValue(promo?.expiresAt)}" /></label>
    </div>
    <details class="import-advanced">
      <summary>Purchase and campaign details</summary>
      <div class="import-grid">
        <label class="manual-field"><span>Campaign</span><input name="campaignId" value="${inputValue(web?.campaign?.id)}" placeholder="fable_transition" /></label>
        <label class="manual-field"><span>Purchased this month</span><input type="number" min="0" step="0.01" name="purchasedThisMonthAmount" value="${inputValue(web?.purchases?.purchasedThisMonthAmount)}" /></label>
        <label class="manual-field"><span>Monthly purchase cap</span><input type="number" min="0" step="0.01" name="monthlyCapAmount" value="${inputValue(web?.purchases?.monthlyCapAmount)}" /></label>
        <label class="manual-field"><span>Purchase reset</span><input type="date" name="purchasesResetAt" value="${dateInputValue(web?.purchases?.resetsAt)}" /></label>
        <label class="manual-field"><span>Maximum discount %</span><input type="number" min="0" max="100" step="1" name="maxDiscountPercent" value="${inputValue(web?.purchases?.maxDiscountPercent)}" /></label>
        <label class="manual-field manual-check"><input type="checkbox" name="autoReloadEnabled" ${web?.autoReloadEnabled ? "checked" : ""} /><span>Auto-reload enabled</span></label>
      </div>
    </details>
    <div class="import-actions">
      <button type="submit">Save snapshot</button>
      <a href="https://claude.ai/new#settings/usage" target="_blank" rel="noopener">Open Claude Usage ↗</a>
      <span class="manual-status" data-manual-status aria-live="polite"></span>
    </div>
  </form>`;
}

function renderProvenance(p) {
  const extra = p.snapshot?.extra ?? {};
  const captured = p.capturedAt == null ? "unknown" : fmtAge(Date.now() - p.capturedAt);
  const isAnthropic = p.provider === "anthropic";
  const isWarp = p.provider === "warp";
  const rawLimits = isAnthropic && Array.isArray(extra.rawLimits) ? extra.rawLimits : null;
  const liveDescription = isAnthropic
    ? "Server-authoritative five-hour, weekly, scoped-limit, and monthly-spend data. The Claude Code OAuth token can read this endpoint."
    : isWarp
      ? "Local Warp preference data. It reports the plan pool and allowances but not purchased add-on balances."
      : "Server-authoritative usage windows and banked-reset metadata, with local session data used only as a fallback.";
  const liveEndpoint = isAnthropic
    ? "api.anthropic.com/api/oauth/usage"
    : isWarp ? "Warp AIRequestLimitInfo plist" : "chatgpt.com/backend-api/wham/usage";
  const sourceCount = isAnthropic ? 3 : 2;

  return `<details class="provenance">
    <summary>
      <span>Sources / Provenance</span>
      <span class="provenance-count">${sourceCount} feeds</span>
    </summary>
    <div class="provenance-body">
      <div class="source-row">
        <span class="source-index">01</span>
        <div>
          <div class="source-title"><strong>Provider quota API</strong><span class="source-badge is-live">live</span></div>
          <p>${liveDescription}</p>
          <code>${liveEndpoint}</code>
          <div class="source-links"><a href="/usage" target="_blank">service snapshot ↗</a><span>captured ${captured}</span></div>
        </div>
      </div>
      ${isAnthropic ? `<div class="source-row">
        <span class="source-index">02</span>
        <div>
          <div class="source-title"><strong>Claude Web credits</strong><span class="source-badge is-manual">imported</span></div>
          <p>Prepaid balance, promotional tranches, campaign, expiry, auto-reload, and purchase terms. Claude Code OAuth was tested against these endpoints and rejected with <code>403 account_session_invalid</code>, so this snapshot stays explicitly separate from live quota data.</p>
          <code>claude.ai/api/organizations/…/prepaid/credits</code>
          <code>…/overage_credit_grant?campaign=fable_transition</code>
          <div class="source-links">
            <a href="https://claude.ai/new#settings/usage" target="_blank" rel="noopener">Claude Usage ↗</a>
            <a href="${SUPPORT_LINKS.anthropicCredits}" target="_blank" rel="noopener">credit policy ↗</a>
            ${p.anthropicWebCredits ? `<span>observed ${fmtAge(Date.now() - p.anthropicWebCredits.capturedAt)}</span>` : `<span>not yet imported</span>`}
          </div>
          ${renderAnthropicImportForm(p.anthropicWebCredits)}
        </div>
      </div>` : ""}
      <div class="source-row">
        <span class="source-index">${isAnthropic ? "03" : "02"}</span>
        <div>
          <div class="source-title"><strong>${isWarp ? "Manual add-on record" : "Local run telemetry"}</strong><span class="source-badge is-local">${isWarp ? "manual" : "local"}</span></div>
          ${isWarp
            ? `<p>User-maintained add-on balance, because Warp does not expose it in the local plan record.</p>`
            : `<p>Recent token counts, models, effort, timing, and API-list-price equivalents. These logs explain activity, but provider-controlled quota percentages remain authoritative.</p>
               <code>${isAnthropic ? "~/.claude/projects/**/*.jsonl" : "~/.codex/sessions/**/*.jsonl"}</code>
               <div class="source-links"><a href="/runs?refresh=1" target="_blank">raw run report ↗</a></div>`}
        </div>
      </div>
      ${rawLimits ? `<details class="raw-evidence">
        <summary>Raw scoped-limit evidence</summary>
        <pre>${esc(JSON.stringify(rawLimits, null, 2))}</pre>
      </details>` : ""}
      ${isAnthropic ? `<p class="provenance-note">Interpretation: the Fable promotional credit is monetary fallback capacity, not a separate model quota unless Anthropic also returns a scoped Fable entry in <code>limits[]</code>. <a href="${SUPPORT_LINKS.anthropicLimits}" target="_blank" rel="noopener">Usage-limit documentation ↗</a></p>` : ""}
    </div>
  </details>`;
}

function renderWindowCard(p) {
  const snap = p.snapshot;
  const fh = snap?.fiveHour;
  const wk = snap?.weekly;
  const extra = snap?.extra ?? {};
  let gauges = "";
  gauges += `<div class="gauge">
    ${fh
      ? `${arcGauge(fh.usedPercent, usageColor(fh.usedPercent))}
         <div class="gauge-value">${fh.usedPercent.toFixed(0)}%</div>
         <div class="gauge-label">5h window</div>
         <div class="gauge-reset">resets ${fmtCountdown(fh.resetsAt)}</div>`
      : `${arcGauge(null, "var(--ink-muted)")}
         <div class="gauge-value muted">—</div>
         <div class="gauge-label">5h window</div>
         <div class="gauge-reset muted">not currently tracked</div>`}
  </div>`;
  gauges += `<div class="gauge">
    ${wk
      ? `${arcGauge(wk.usedPercent, usageColor(wk.usedPercent))}
         <div class="gauge-value">${wk.usedPercent.toFixed(0)}%</div>
         <div class="gauge-label">weekly window</div>
         <div class="gauge-reset">resets ${fmtCountdown(wk.resetsAt)}</div>`
      : `${arcGauge(null, "var(--ink-muted)")}
         <div class="gauge-value muted">—</div>
         <div class="gauge-label">weekly window</div>
         <div class="gauge-reset muted">not currently tracked</div>`}
  </div>`;

  let chips = "";
  if (extra.planType) chips += `<span class="info-chip">plan: ${extra.planType}</span>`;
  if (extra.bankedResetCreditsAvailable != null) {
    chips += `<span class="info-chip">banked reset credits: ${extra.bankedResetCreditsAvailable}</span>`;
  }

  // Per-model windows (e.g. Anthropic's temporary Fable bucket) — renders as
  // a meter row per bucket dynamically; zero UI change when there are none.
  const modelWindows = snap?.modelWindows ?? {};
  const modelWindowNames = Object.keys(modelWindows);
  let modelWindowsHtml = "";
  if (modelWindowNames.length > 0) {
    const rows = modelWindowNames
      .map((name) => {
        const w = modelWindows[name];
        const color = usageColor(w.usedPercent);
        return `<div class="model-window-row">
          <div class="model-window-meta">
            <span class="model-window-name">${name}</span>
            <span class="model-window-value">${w.usedPercent.toFixed(0)}%</span>
          </div>
          <div class="model-window-track"><div class="model-window-fill" style="width:${Math.min(100, w.usedPercent)}%; background:${color};"></div></div>
          <div class="model-window-reset">resets ${fmtCountdown(w.resetsAt)}</div>
        </div>`;
      })
      .join("");
    modelWindowsHtml = `<div class="model-window-list">${rows}</div>`;
  }

  const creditsHtml = renderCreditLedger(p);

  return { gauges, chips, modelWindowsHtml, creditsHtml };
}

function renderManualForm() {
  return `<div class="warp-manual">
    <div class="warp-manual-head">
      <span class="warp-manual-title">Add-on credits</span>
      <span class="muted">not exposed by Warp's API — record it from <code>warp://settings/billing</code></span>
    </div>
    <form class="manual-form" data-manual-form>
      <label class="manual-field">
        <span>Balance</span>
        <input type="text" name="value" placeholder="e.g. 1010" required />
      </label>
      <label class="manual-field">
        <span>Note</span>
        <input type="text" name="note" placeholder="optional" />
      </label>
      <button type="submit">Save</button>
    </form>
    <p class="manual-status" data-manual-status aria-live="polite"></p>
  </div>`;
}

function renderPoolCard(p) {
  const pool = p.snapshot?.pool;
  if (!pool) return { gauges: `<p class="muted">no pool data</p>`, chips: "" };
  const color = usageColor(pool.usedPercent);
  const extra = p.snapshot?.extra ?? {};
  const remaining = Math.max(0, pool.limit - pool.used);
  const renewal = pool.refreshesAt == null
    ? "unknown"
    : new Date(pool.refreshesAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  const voiceLimit = Number(extra.voiceRequestLimit);
  const voiceUsed = Number(extra.voiceRequestsUsed);
  const voiceValue = extra.isUnlimitedVoice
    ? "unlimited"
    : Number.isFinite(voiceLimit) && Number.isFinite(voiceUsed)
      ? `${voiceUsed.toLocaleString()} / ${voiceLimit.toLocaleString()}`
      : "not reported";
  const indexValue = extra.isUnlimitedCodebaseIndices
    ? "unlimited"
    : Number.isFinite(Number(extra.maxCodebaseIndices))
      ? Number(extra.maxCodebaseIndices).toLocaleString()
      : "not reported";
  const fileValue = Number.isFinite(Number(extra.maxFilesPerRepo))
    ? Number(extra.maxFilesPerRepo).toLocaleString()
    : "not reported";
  return {
    gauges: `<div class="pool-block">
      <div class="pool-numbers">
        <span class="value">${pool.used.toLocaleString()} <span class="muted">/ ${pool.limit.toLocaleString()}</span></span>
        <span class="cadence">${pool.cadence ?? ""}</span>
      </div>
      <div class="pool-track"><div class="pool-fill" style="width:${Math.min(100, pool.usedPercent)}%; background:${color};"></div></div>
      <div class="pool-reset">refreshes ${fmtCountdown(pool.refreshesAt)}</div>
    </div>
    <div class="warp-detail-grid" aria-label="Warp plan details">
      <div><span>remaining</span><strong>${remaining.toLocaleString()}</strong></div>
      <div><span>utilization</span><strong>${pool.usedPercent.toFixed(1)}%</strong></div>
      <div><span>renews</span><strong>${renewal}</strong></div>
      <div><span>voice requests</span><strong>${voiceValue}</strong></div>
      <div><span>codebase indexes</span><strong>${indexValue}</strong></div>
      <div><span>files / repo</span><strong>${fileValue}</strong></div>
    </div>
    ${renderManualForm()}`,
    chips: "",
  };
}

function renderCard(p, runs) {
  const isWindow = p.snapshot?.kind === "window";
  const { gauges, chips, modelWindowsHtml = "", creditsHtml = "" } = p.snapshot
    ? (isWindow ? renderWindowCard(p) : renderPoolCard(p))
    : { gauges: `<p class="muted">no data collected yet</p>`, chips: "" };

  const manualChips = (p.manualEntries ?? [])
    .filter((m) => m.field !== "claude_web_credit_snapshot")
    .map((m) => `<span class="info-chip">manual: ${m.field} = ${m.value}${m.note ? ` (${m.note})` : ""}</span>`)
    .join("");

  const accentColor = statusColorVar(p.status);
  const accentGlow = statusGlowVar(p.status);
  const note = p.error ? `<p class="card-note">${p.error}</p>` : "";
  const link = PURCHASE_LINKS[p.provider];

  return `
    <article class="card" data-provider="${esc(p.provider)}" style="--card-accent: ${accentColor}; --card-accent-glow: ${accentGlow};">
      <div class="card-head">
        <div class="card-title-group">
          <span class="card-title">${PROVIDER_LABEL[p.provider]}</span>
          <span class="card-meta">${PROVIDER_SUB[p.provider]}</span>
        </div>
        ${statusPill(p.status)}
      </div>
      <div class="${isWindow ? "gauge-row" : ""}">${gauges}</div>
      ${modelWindowsHtml}
      <div class="chip-row">${chips}${manualChips}</div>
      ${creditsHtml}
      ${note}
      ${renderProvenance(p)}
      ${renderRunHistory(p.provider, runs, p.snapshot)}
      <div class="card-footer">
        <a class="purchase-link" href="${link}" target="_blank" rel="noopener">manage / purchase ↗</a>
        <span class="card-age">source: ${p.source ?? "-"} · age: ${fmtAge(p.dataAgeMs)}</span>
      </div>
    </article>`;
}

function overallState(providers) {
  if (providers.some((p) => p.status === "unavailable" || p.status === "unknown")) return "critical";
  if (providers.some((p) => p.status === "stale")) return "warning";
  const worstUsage = Math.max(
    0,
    ...providers.flatMap((p) => {
      if (!p.snapshot) return [];
      if (p.snapshot.kind === "window") {
        return [p.snapshot.fiveHour?.usedPercent, p.snapshot.weekly?.usedPercent].filter((v) => v != null);
      }
      return [p.snapshot.pool.usedPercent];
    }),
  );
  if (worstUsage >= 85) return "critical";
  if (worstUsage >= 60) return "warning";
  return "ok";
}

async function loadUsage() {
  try {
    const [usageRes, runsRes] = await Promise.all([fetch("/usage"), fetch("/runs")]);
    const [report, history] = await Promise.all([usageRes.json(), runsRes.json()]);
    // Skip the refresh while the user is mid-edit in the Warp manual-entry
    // form — it lives inside the auto-refreshing card markup, so replacing
    // innerHTML here would wipe whatever they've typed.
    const editingManualForm = document.activeElement?.closest(".manual-form");
    if (!editingManualForm) {
      document.getElementById("cards").innerHTML = report.providers.map((provider) => renderCard(provider, history.providers?.[provider.provider] ?? [])).join("");
    }
    document.getElementById("generated-at").textContent = new Date(report.generatedAt).toLocaleString();

    const state = overallState(report.providers);
    const badge = document.getElementById("overall-badge");
    badge.dataset.state = state;
    badge.querySelector(".overall-text").textContent =
      state === "ok" ? "All systems nominal" : state === "warning" ? "Headroom tightening" : "Needs attention";
  } catch (err) {
    document.getElementById("cards").innerHTML = `<p class="card-note">Could not reach the quota-service server. Is <code>bun run serve</code> running? (${err})</p>`;
  }
}

function tickClock() {
  const el = document.getElementById("clock");
  const now = new Date();
  el.textContent = now.toLocaleTimeString([], { hour12: false }) + " local";
}

// ---------- estimate / recommend panel ----------

let activeProfile = null;

async function selectProfile(profile) {
  activeProfile = profile;
  document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c.dataset.profile === profile));
  const box = document.getElementById("recommend-result");
  box.innerHTML = `<p class="muted">loading…</p>`;
  try {
    const res = await fetch(`/recommend?taskProfile=${encodeURIComponent(profile)}`);
    const r = await res.json();
    const est = r.estimate.tokenRangeByTier[r.estimate.rubricTier];
    const rec = r.recommendation;
    box.innerHTML = `
      ${rec ? `<div class="recommend-pick">${PROVIDER_LABEL[rec.provider] ?? rec.provider} — ${rec.model}</div>` : `<div class="recommend-pick">no usable pick</div>`}
      <div class="recommend-reason">${r.reason}</div>
      <div class="recommend-alt">est. ${est.low.toLocaleString()}–${est.high.toLocaleString()} tokens (typical ~${est.typical.toLocaleString()}) at rubric tier "${r.estimate.rubricTier}"</div>
      ${r.alternates.length ? `<div class="recommend-alt">alternates: ${r.alternates.map((a) => `${a.provider}/${a.model} (${a.headroomPercent != null ? a.headroomPercent.toFixed(0) + "%" : "?"})`).join(", ")}</div>` : ""}
      ${r.warnings.length ? `<div class="recommend-warning">${r.warnings.join("<br>")}</div>` : ""}
    `;
  } catch (err) {
    box.innerHTML = `<p class="card-note">recommend failed: ${err}</p>`;
  }
}

document.getElementById("profile-row").addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (btn) selectProfile(btn.dataset.profile);
});

// ---------- quick data reference ----------

function initializeCommandReference() {
  const origin = window.location.origin;
  document.querySelectorAll("[data-command-template]").forEach((el) => {
    const command = el.dataset.commandTemplate.replaceAll("{origin}", origin);
    el.dataset.command = command;
    el.textContent = command;
  });
}

function initializeOverallPopover() {
  const badge = document.getElementById("overall-badge");
  const tooltip = document.getElementById("overall-badge-tooltip");
  if (!badge || !tooltip) return;

  if (typeof tooltip.showPopover === "function") {
    tooltip.hidden = false;
    tooltip.addEventListener("toggle", (event) => {
      badge.setAttribute("aria-expanded", event.newState === "open" ? "true" : "false");
    });
    return;
  }

  // Older engines still get a usable fallback if they do not implement Popover.
  tooltip.hidden = true;
  const showFallback = () => {
    tooltip.hidden = false;
    badge.setAttribute("data-tooltip-visible", "true");
  };
  const hideFallback = () => {
    tooltip.hidden = true;
    badge.removeAttribute("data-tooltip-visible");
  };
  badge.addEventListener("mouseenter", showFallback);
  badge.addEventListener("mouseleave", hideFallback);
  badge.addEventListener("focus", showFallback);
  badge.addEventListener("blur", hideFallback);
}

async function copyCommand(button) {
  const code = button.parentElement.querySelector("[data-command]");
  const command = code?.dataset.command;
  if (!command) return;

  try {
    await navigator.clipboard.writeText(command);
    button.textContent = "Copied";
    button.dataset.copied = "true";
  } catch {
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const copied = document.execCommand("copy");
    button.textContent = copied ? "Copied" : "Selected";
    if (copied) {
      button.dataset.copied = "true";
      selection.removeAllRanges();
    }
  }

  window.setTimeout(() => {
    button.textContent = "Copy";
    button.removeAttribute("data-copied");
  }, 1600);
}

document.getElementById("command-list").addEventListener("click", (e) => {
  const button = e.target.closest(".copy-command");
  if (button) copyCommand(button);
});

// ---------- user-maintained provider data ----------

function optionalFormNumber(form, name) {
  const raw = form.elements[name]?.value?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

document.getElementById("cards").addEventListener("submit", async (e) => {
  const form = e.target.closest(".manual-form");
  if (!form) return;
  e.preventDefault();
  const statusEl = form.querySelector("[data-manual-status]") ?? form.parentElement.querySelector("[data-manual-status]");
  statusEl.textContent = "Saving…";
  statusEl.removeAttribute("data-ok");

  if (form.matches("[data-claude-import-form]")) {
    const payload = {
      capturedAt: Date.now(),
      currentBalance: optionalFormNumber(form, "currentBalance"),
      promoRemaining: optionalFormNumber(form, "promoRemaining"),
      promoGranted: optionalFormNumber(form, "promoGranted"),
      promoExpiresAt: form.elements.promoExpiresAt.value || null,
      campaignId: form.elements.campaignId.value.trim() || null,
      campaignGranted: form.elements.campaignId.value.trim() ? true : null,
      campaignAmount: optionalFormNumber(form, "promoGranted"),
      campaignExpiresAt: form.elements.promoExpiresAt.value || null,
      autoReloadEnabled: form.elements.autoReloadEnabled.checked,
      purchasedThisMonthAmount: optionalFormNumber(form, "purchasedThisMonthAmount"),
      monthlyCapAmount: optionalFormNumber(form, "monthlyCapAmount"),
      purchasesResetAt: form.elements.purchasesResetAt.value || null,
      maxDiscountPercent: optionalFormNumber(form, "maxDiscountPercent"),
    };
    try {
      const res = await fetch("/anthropic-web-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? "unknown error");
      statusEl.textContent = "Snapshot saved";
      statusEl.dataset.ok = "true";
      await loadUsage();
    } catch (err) {
      statusEl.textContent = `Failed: ${err.message ?? err}`;
      statusEl.dataset.ok = "false";
    }
    return;
  }

  const value = form.querySelector('input[name="value"]').value.trim();
  const note = form.querySelector('input[name="note"]').value.trim();
  try {
    const res = await fetch("/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "warp", field: "addon_credits", value, note: note || null }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error ?? "unknown error");
    statusEl.textContent = `Saved — addon credits = ${value}`;
    statusEl.dataset.ok = "true";
    loadUsage();
  } catch (err) {
    statusEl.textContent = `Failed: ${err.message ?? err}`;
    statusEl.dataset.ok = "false";
  }
});

// ---------- boot ----------

tickClock();
setInterval(tickClock, 1000);
initializeCommandReference();
initializeOverallPopover();
loadUsage();
setInterval(loadUsage, 30_000);
