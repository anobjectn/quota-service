// quota-service dashboard — vanilla JS, no framework, no build step.
// Reads GET /usage, GET /resets, GET /recommend?taskProfile=..., and posts
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
        style="filter: drop-shadow(0 0 5px ${color}66); transition: stroke-dasharray 0.6s ease;" />
    </svg>`;
}

function statusPill(status) {
  const label = { ok: "OK", stale: "STALE", unavailable: "UNAVAILABLE", unknown: "UNKNOWN" }[status] ?? status.toUpperCase();
  return `<span class="status-pill" data-status="${status}"><span class="dot"></span>${label}</span>`;
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
          <div class="model-window-track"><div class="model-window-fill" style="width:${Math.min(100, w.usedPercent)}%; background:${color}; box-shadow: 0 0 8px ${color}55;"></div></div>
          <div class="model-window-reset">resets ${fmtCountdown(w.resetsAt)}</div>
        </div>`;
      })
      .join("");
    modelWindowsHtml = `<div class="model-window-list">${rows}</div>`;
  }

  // Usage credits — first-class field, rendered as a compact line.
  const credits = snap?.usageCredits;
  let creditsHtml = "";
  if (credits) {
    const badgeClass = credits.enabled ? "credits-badge-on" : "credits-badge-off";
    const limitStr = credits.limitAmount != null ? credits.limitAmount.toFixed(2) : "?";
    const resetStr = credits.resetsAt != null ? ` · resets ${fmtCountdown(credits.resetsAt)}` : "";
    creditsHtml = `<div class="credits-line">
      <span class="credits-badge ${badgeClass}">${credits.enabled ? "credits enabled" : "credits disabled"}</span>
      <span class="credits-amount">$${credits.spentAmount.toFixed(2)} / $${limitStr} ${credits.currency}${resetStr}</span>
    </div>`;
  }

  return { gauges, chips, modelWindowsHtml, creditsHtml };
}

function renderPoolCard(p) {
  const pool = p.snapshot?.pool;
  if (!pool) return { gauges: `<p class="muted">no pool data</p>`, chips: "" };
  const color = usageColor(pool.usedPercent);
  return {
    gauges: `<div class="pool-block">
      <div class="pool-numbers">
        <span class="value">${pool.used.toLocaleString()} <span class="muted">/ ${pool.limit.toLocaleString()}</span></span>
        <span class="cadence">${pool.cadence ?? ""}</span>
      </div>
      <div class="pool-track"><div class="pool-fill" style="width:${Math.min(100, pool.usedPercent)}%; background:${color}; box-shadow: 0 0 10px ${color}55;"></div></div>
      <div class="pool-reset">refreshes ${fmtCountdown(pool.refreshesAt)}</div>
    </div>`,
    chips: "",
  };
}

function renderCard(p) {
  const isWindow = p.snapshot?.kind === "window";
  const { gauges, chips, modelWindowsHtml = "", creditsHtml = "" } = p.snapshot
    ? (isWindow ? renderWindowCard(p) : renderPoolCard(p))
    : { gauges: `<p class="muted">no data collected yet</p>`, chips: "" };

  const manualChips = (p.manualEntries ?? [])
    .map((m) => `<span class="info-chip">manual: ${m.field} = ${m.value}${m.note ? ` (${m.note})` : ""}</span>`)
    .join("");

  const accentColor = statusColorVar(p.status);
  const accentGlow = statusGlowVar(p.status);
  const note = p.error ? `<p class="card-note">${p.error}</p>` : "";
  const link = PURCHASE_LINKS[p.provider];

  return `
    <article class="card" style="--card-accent: ${accentColor}; --card-accent-glow: ${accentGlow};">
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
    const res = await fetch("/usage");
    const report = await res.json();
    document.getElementById("cards").innerHTML = report.providers.map(renderCard).join("");
    document.getElementById("generated-at").textContent = new Date(report.generatedAt).toLocaleString();

    const state = overallState(report.providers);
    const badge = document.getElementById("overall-badge");
    badge.dataset.state = state;
    badge.querySelector(".overall-text").textContent =
      state === "ok" ? "ALL SYSTEMS NOMINAL" : state === "warning" ? "HEADROOM TIGHTENING" : "NEEDS ATTENTION";
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

// ---------- manual entry form ----------

document.getElementById("manual-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const provider = document.getElementById("manual-provider").value;
  const field = document.getElementById("manual-field").value.trim();
  const value = document.getElementById("manual-value").value.trim();
  const note = document.getElementById("manual-note").value.trim();
  const statusEl = document.getElementById("manual-status");
  statusEl.textContent = "saving…";
  statusEl.removeAttribute("data-ok");
  try {
    const res = await fetch("/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, field, value, note: note || null }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error ?? "unknown error");
    statusEl.textContent = `saved ${provider}.${field} = ${value}`;
    statusEl.dataset.ok = "true";
    loadUsage();
  } catch (err) {
    statusEl.textContent = `failed: ${err.message ?? err}`;
    statusEl.dataset.ok = "false";
  }
});

// ---------- boot ----------

tickClock();
setInterval(tickClock, 1000);
loadUsage();
setInterval(loadUsage, 30_000);
