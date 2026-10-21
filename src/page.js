import { prettyPhone } from "./phone.js";
import { TEMPLATES } from "./templates.js";
import { openHandoffs } from "./store.js";

/**
 * Today's tap-to-text page. One self-contained HTML file in out/ (gitignored,
 * it holds customer names and numbers). Open it on the phone, tap a card to
 * open Messages with the text filled in, tick it off, then paste the one
 * `sent` command the page builds so the log stays true.
 */
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// "?&body=" opens Messages pre-filled on both iPhone and Android.
const smsHref = (phone, body) => `sms:${phone}${body ? "?&body=" + encodeURIComponent(body) : ""}`;
const telHref = (phone) => `tel:${phone}`;

const PRIORITY_RANK = { urgent: 0, hot: 1, normal: 2 };

const HELD = {
  AWAITING_JAMAL: "waiting on your answer to their reply",
  BAD_PHONE: "no valid phone number",
  ONE_PER_NUMBER: "shares a number; one text per number per day",
  DAILY_LIMIT: "already texted today",
  TOO_SOON: "texted too recently",
  PRICE_BLOCK: "price words in the CRM data; write this one yourself",
  RENDER_FAILED: "message could not be built",
  KILL_SWITCH: "kill switch is on",
};

function nameFor(store, lead, phone) {
  if (lead && lead.name) return lead.name;
  const others = Object.values(store.leads).filter((l) => l.phone === phone && l.name);
  return others.length ? others.map((l) => l.name).join(" / ") : prettyPhone(phone);
}

export function renderPage(store, result, { now, config }) {
  const { today, drafts, callList, skipped } = result;
  const handoffs = openHandoffs(store).sort(
    (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.at < b.at ? 1 : -1)
  );
  const dayLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timeZone, weekday: "long", month: "short", day: "numeric",
  }).format(now);
  const fmt12 = (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    return `${((h + 11) % 12) + 1}${m ? ":" + String(m).padStart(2, "0") : ""} ${h < 12 ? "AM" : "PM"}`;
  };
  const windowText = `${fmt12(config.sendStart)} to ${fmt12(config.sendEnd)}`;

  const handoffCards = handoffs.map((h) => {
    const lead = h.leadIds.length ? store.leads[h.leadIds[0]] : null;
    return `
    <article class="card ${esc(h.priority)}">
      <div class="row"><strong>${esc(nameFor(store, lead, h.phone))}</strong><span class="tag ${esc(h.priority)}">${esc(h.priority === "hot" ? "buying signal" : h.priority)}</span></div>
      ${lead && lead.vehicle ? `<div class="muted">${esc(lead.vehicle)}</div>` : ""}
      <blockquote>${esc(h.body)}</blockquote>
      <div class="muted small">${esc(h.reasons.join(" · "))}</div>
      ${h.possibleOptOut ? `<div class="warn">Might be asking to stop. If so, log it with <code>optout ${esc(h.phone)}</code>.</div>` : ""}
      <div class="actions">
        <a class="btn" href="${esc(telHref(h.phone))}">Call</a>
        <a class="btn ghost" href="${esc(smsHref(h.phone))}">Reply</a>
      </div>
      <div class="muted small">When handled: <code>handled ${esc(h.phone)}</code></div>
    </article>`;
  }).join("");

  const draftCards = drafts.map((d) => {
    const t = TEMPLATES[d.template];
    return `
    <article class="card" data-id="${esc(d.id)}">
      <div class="row"><strong>${esc(nameFor(store, d.lead, d.phone))}</strong><span class="tag">${esc(t.label)}</span></div>
      <div class="muted">${esc(d.why || "")}${d.lead && d.lead.vehicle ? " · " + esc(d.lead.vehicle) : ""}</div>
      <p class="msg">${esc(d.body)}</p>
      <div class="muted small">${esc(prettyPhone(d.phone))} · ${d.segments} text${d.segments === 1 ? "" : "s"} · id ${esc(d.id)}</div>
      <div class="actions">
        <a class="btn" href="${esc(smsHref(d.phone, d.body))}">Open in Messages</a>
        <button class="btn ghost" type="button" data-copy="${esc(d.body)}">Copy</button>
        <label class="check"><input type="checkbox" data-sent="${esc(d.id)}"> Sent</label>
      </div>
    </article>`;
  }).join("");

  const callRows = callList.map((c) => `
    <li><a href="${esc(telHref(c.lead.phone))}">${esc(c.lead.name || prettyPhone(c.lead.phone))}</a>
      <span class="muted"> · ${esc(c.why)} · ${esc(c.note)}</span></li>`).join("");

  const skippedRows = skipped.map((s) => `
    <li>${esc(s.lead.name || prettyPhone(s.lead.phone))} <span class="muted">· ${esc(s.why)} · ${esc(HELD[s.reason] || s.reason)}</span></li>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Texts for ${esc(today)}</title>
<style>
  :root { --bg:#f6f4ef; --card:#fff; --ink:#14181f; --muted:#5d6470; --line:#e3ded3; --accent:#0e1a3c; --accent-ink:#fff; --hot:#b4530b; --urgent:#b42318; --warn-bg:#fff4e5; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1218; --card:#181c24; --ink:#eef0f4; --muted:#9aa3b2; --line:#2a303b; --accent:#e7c873; --accent-ink:#14181f; --hot:#f0a35e; --urgent:#ff7a6e; --warn-bg:#2b2112; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.45 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; }
  main { max-width:640px; margin:0 auto; padding:20px 16px 120px; }
  h1 { font-size:22px; margin:0 0 4px; }
  h2 { font-size:15px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:28px 0 10px; }
  .muted { color:var(--muted); } .small { font-size:13px; }
  .banner { background:var(--urgent); color:#fff; padding:10px 12px; border-radius:10px; margin:12px 0; font-weight:600; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; margin:0 0 12px; }
  .card.urgent { border-left:4px solid var(--urgent); } .card.hot { border-left:4px solid var(--hot); }
  .row { display:flex; justify-content:space-between; gap:8px; align-items:baseline; }
  .tag { font-size:12px; border:1px solid var(--line); border-radius:999px; padding:2px 8px; white-space:nowrap; color:var(--muted); }
  .tag.hot { color:var(--hot); border-color:var(--hot); } .tag.urgent { color:var(--urgent); border-color:var(--urgent); }
  .msg { margin:10px 0 6px; white-space:pre-wrap; }
  blockquote { margin:10px 0 6px; padding-left:10px; border-left:3px solid var(--line); }
  .warn { background:var(--warn-bg); padding:8px 10px; border-radius:8px; margin:8px 0; font-size:14px; }
  .actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:10px 0 6px; }
  .btn { display:inline-block; background:var(--accent); color:var(--accent-ink); border:0; border-radius:10px; padding:10px 14px; font:inherit; font-weight:600; text-decoration:none; cursor:pointer; }
  .btn.ghost { background:transparent; color:var(--ink); border:1px solid var(--line); }
  .check { display:flex; gap:6px; align-items:center; margin-left:auto; }
  .check input { width:22px; height:22px; }
  ul { padding-left:18px; } li { margin:6px 0; } a { color:inherit; }
  code { font:13px ui-monospace, Menlo, monospace; background:var(--line); padding:1px 5px; border-radius:5px; overflow-wrap:anywhere; }
  .dock { position:fixed; left:0; right:0; bottom:0; background:var(--card); border-top:1px solid var(--line); padding:10px 16px calc(10px + env(safe-area-inset-bottom)); }
  .dock .inner { max-width:640px; margin:0 auto; display:flex; gap:8px; align-items:center; }
  .dock code { flex:1; min-width:0; }
  .empty { padding:14px; border:1px dashed var(--line); border-radius:14px; color:var(--muted); }
</style>
</head>
<body>
<main>
  <h1>${esc(dayLabel)}</h1>
  <div class="muted">${drafts.length} to text · ${handoffs.length} repl${handoffs.length === 1 ? "y" : "ies"} waiting · ${callList.length} to call · send ${esc(windowText)}</div>
  ${config.killSwitch ? `<div class="banner">Kill switch is on. Nothing should be sent.</div>` : ""}

  <h2>Replies waiting on you</h2>
  ${handoffCards || `<div class="empty">No replies waiting.</div>`}

  <h2>Text these</h2>
  ${draftCards || `<div class="empty">Nobody is due for a text today.</div>`}

  <h2>Call instead</h2>
  ${callRows ? `<ul>${callRows}</ul><p class="muted small">Due today but no permission to text on file. Ask on the call, then log it: <code>consent PHONE --source "asked on call"</code></p>` : `<div class="empty">Nobody.</div>`}

  ${skippedRows ? `<h2>Held back</h2><ul>${skippedRows}</ul>` : ""}
</main>
<div class="dock"><div class="inner">
  <code id="cmd">Tick what you sent</code>
  <button class="btn" type="button" id="copyCmd">Copy</button>
</div></div>
<script>
(function () {
  function copy(text, btn) {
    function done() { if (btn) { var t = btn.textContent; btn.textContent = "Copied"; setTimeout(function () { btn.textContent = t; }, 1200); } }
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(done, fallback); } else { fallback(); }
    function fallback() {
      var ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", "");
      ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) {} document.body.removeChild(ta);
    }
  }
  var cmd = document.getElementById("cmd");
  function update() {
    var ids = [].slice.call(document.querySelectorAll("[data-sent]:checked")).map(function (b) { return b.getAttribute("data-sent"); });
    cmd.textContent = ids.length ? "node src/cli.js sent " + ids.join(" ") : "Tick what you sent";
  }
  document.addEventListener("change", function (e) { if (e.target.matches("[data-sent]")) update(); });
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-copy]"); if (b) copy(b.getAttribute("data-copy"), b);
  });
  document.getElementById("copyCmd").addEventListener("click", function (e) {
    if (cmd.textContent.indexOf("node ") === 0) copy(cmd.textContent, e.currentTarget);
  });
})();
</script>
</body>
</html>
`;
}
