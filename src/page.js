import { prettyPhone } from "./phone.js";
import { TEMPLATES } from "./templates.js";
import { openHandoffs } from "./store.js";
import { localDate, daysBetween } from "./dates.js";

/**
 * The Command Center page, in the booking site's look: night sky, aurora
 * glow, glass cards, gold and mint, Barlow Condensed + Fraunces.
 *
 * Two modes from one template:
 *  - live (served by `serve`): every button saves instantly, with Undo.
 *  - file (written by `drafts`): tick Sent, copy the one command it builds.
 * Either way it holds customer names and numbers, so it only ever lives on
 * Jamal's device and is never published or linked from the public site.
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

/** A button that runs an action (live mode only). */
function act(label, action, args, { cls = "chip", confirm = "", prompt = "" } = {}) {
  return `<button type="button" class="${cls}" data-act="${esc(action)}" data-args="${esc(JSON.stringify(args))}"${
    confirm ? ` data-confirm="${esc(confirm)}"` : ""}${prompt ? ` data-prompt="${esc(prompt)}"` : ""}>${esc(label)}</button>`;
}

/** Sold / Lost, plus Showed / No-show when an appointment was today or yesterday. */
function leadChips(lead, today) {
  if (!lead) return "";
  const out = [];
  if (lead.appointmentDate && lead.showed == null) {
    const d = daysBetween(lead.appointmentDate, today);
    if (d >= 0 && d <= 1) {
      out.push(act("Showed", "showed", { leadId: lead.id }));
      out.push(act("No-show", "noshow", { leadId: lead.id }));
    }
  }
  out.push(act("Sold", "sold", { leadId: lead.id }, { confirm: `Mark ${lead.name || "this lead"} sold? Follow-ups stop.` }));
  out.push(act("Lost", "lost", { leadId: lead.id }, { confirm: `Mark ${lead.name || "this lead"} lost? Follow-ups stop.` }));
  return out.join("");
}

export function renderPage(store, result, { now, config, live = null }) {
  const { drafts, callList, skipped } = result;
  const today = localDate(now, config.timeZone);
  const handoffs = openHandoffs(store).sort(
    (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.at < b.at ? 1 : -1)
  );
  const fmt = (o) => new Intl.DateTimeFormat("en-US", { timeZone: config.timeZone, ...o }).format(now);
  const fmt12 = (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    return `${((h + 11) % 12) + 1}${m ? ":" + String(m).padStart(2, "0") : ""} ${h < 12 ? "AM" : "PM"}`;
  };
  const hot = handoffs.filter((h) => h.priority !== "normal").length;
  const headline =
    handoffs.length ? `${handoffs.length} ${handoffs.length === 1 ? "person is" : "people are"} waiting on you.`
    : drafts.length ? `${drafts.length} ${drafts.length === 1 ? "text" : "texts"} ready to send.`
    : "All clear.";

  const handoffCards = handoffs.map((h) => {
    const lead = h.leadIds.length ? store.leads[h.leadIds[0]] : null;
    const tag = h.priority === "hot" ? "Buying signal" : h.priority === "urgent" ? "Read first" : "Reply";
    return `
    <article class="card ${esc(h.priority)}">
      <div class="row"><h3>${esc(nameFor(store, lead, h.phone))}</h3><span class="tag ${esc(h.priority)}">${tag}</span></div>
      ${lead && lead.vehicle ? `<div class="meta">${esc(lead.vehicle)}</div>` : ""}
      <blockquote>${esc(h.body)}</blockquote>
      <div class="meta small">${esc(h.reasons.join(" · "))}</div>
      ${h.possibleOptOut ? `<div class="warn">This might be a request to stop texting. If it is, tap Opt out.</div>` : ""}
      <div class="actions">
        <a class="btn" href="${esc(telHref(h.phone))}">Call</a>
        <a class="btn ghost" href="${esc(smsHref(h.phone))}">Reply</a>
        ${live ? act("Handled ✓", "handled", { phone: h.phone }, { cls: "btn ok" }) : ""}
      </div>
      ${live ? `<div class="chips">${act("Opt out", "optout", { phone: h.phone }, { cls: "chip danger", confirm: `Never text ${prettyPhone(h.phone)} again?` })}${leadChips(lead, today)}</div>`
        : `<div class="meta small">When handled: <code>handled ${esc(h.phone)}</code></div>`}
    </article>`;
  }).join("");

  const draftCards = drafts.map((d) => {
    const t = TEMPLATES[d.template];
    return `
    <article class="card" data-id="${esc(d.id)}">
      <div class="row"><h3>${esc(nameFor(store, d.lead, d.phone))}</h3><span class="tag">${esc(t.label)}</span></div>
      <div class="meta">${esc(d.why || "")}${d.lead && d.lead.vehicle ? " · " + esc(d.lead.vehicle) : ""}</div>
      <p class="bubble">${esc(d.body)}</p>
      <div class="meta small">${esc(prettyPhone(d.phone))} · ${d.segments} text${d.segments === 1 ? "" : "s"}</div>
      <div class="actions">
        <a class="btn" href="${esc(smsHref(d.phone, d.body))}">Open in Messages</a>
        <button class="btn ghost" type="button" data-copy="${esc(d.body)}">Copy</button>
        ${live ? act("Sent ✓", "sent", { id: d.id }, { cls: "btn ok" })
          : `<label class="check"><input type="checkbox" data-sent="${esc(d.id)}"> Sent</label>`}
      </div>
      ${live ? `<div class="chips">${act("Skip", "skip", { id: d.id })}${leadChips(d.lead, today)}</div>` : ""}
    </article>`;
  }).join("");

  const callCards = callList.map((c) => `
    <article class="card slim">
      <div class="row"><h3>${esc(c.lead.name || prettyPhone(c.lead.phone))}</h3><span class="tag">${esc(c.note)}</span></div>
      <div class="meta">${esc(c.why)}${c.lead.vehicle ? " · " + esc(c.lead.vehicle) : ""}</div>
      <div class="actions">
        <a class="btn" href="${esc(telHref(c.lead.phone))}">Call ${esc(prettyPhone(c.lead.phone))}</a>
        ${live && c.note !== "opted out of texts"
          ? act("OK to text", "consent", { phone: c.lead.phone }, { cls: "btn ghost", prompt: "How did they agree? (saved with the lead)" })
          : ""}
      </div>
      ${live ? `<div class="chips">${leadChips(c.lead, today)}</div>` : ""}
    </article>`).join("");

  const skippedRows = skipped.map((s) => `
    <li>${esc(s.lead.name || prettyPhone(s.lead.phone))} <span class="meta">· ${esc(s.why)} · ${esc(HELD[s.reason] || s.reason)}</span></li>`).join("");

  const dock = live
    ? live.undoLabel
      ? `<div class="dock"><div class="inner"><span class="done">${esc(live.undoLabel)}</span><button class="btn ghost" type="button" data-act="undo" data-args="{}">Undo</button></div></div>`
      : ""
    : `<div class="dock"><div class="inner"><code id="cmd">Tick what you sent</code><button class="btn" type="button" id="copyCmd">Copy</button></div></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#03061a">
<title>Command Center</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Barlow:wght@400;500;600;700&family=Fraunces:ital,wght@1,500&display=swap" rel="stylesheet">
<style>
  :root{
    color-scheme:dark;
    --night:#03061a; --ink:#EEF2FF; --muted:#A9B4D0; --dim:#6F7B99;
    --glass:rgba(13,19,48,.74); --edge:rgba(255,255,255,.13); --edge-2:rgba(255,255,255,.24); --field:rgba(255,255,255,.06);
    --cream:#FFF4E6; --gold:#FFC04D; --midnight:#0E1A3C; --ok:#3CFFAA; --coral:#FF6F61;
    --ion-a:34 230 255; --ion-b:56 120 255; --ion-c:60 255 170;
    --display:'Barlow Condensed','Arial Narrow',system-ui,sans-serif;
    --ui:'Barlow',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    --serif:'Fraunces',Georgia,'Times New Roman',serif;
  }
  *{box-sizing:border-box}
  html{background:var(--night)}
  body{margin:0;color:var(--ink);font:16px/1.45 var(--ui);-webkit-font-smoothing:antialiased;min-height:100vh;
    background:
      radial-gradient(1px 1px at 12% 18%,#fff 50%,transparent 51%),radial-gradient(1px 1px at 68% 9%,#cfe8ff 50%,transparent 51%),
      radial-gradient(1.5px 1.5px at 84% 32%,#fff 50%,transparent 51%),radial-gradient(1px 1px at 33% 41%,#fff 50%,transparent 51%),
      radial-gradient(1px 1px at 91% 61%,#dfe9ff 50%,transparent 51%),radial-gradient(1.5px 1.5px at 7% 72%,#fff 50%,transparent 51%),
      radial-gradient(40% 22% at 25% 4%, rgb(var(--ion-c)/.30), transparent 70%),
      radial-gradient(46% 20% at 75% 0%, rgb(var(--ion-a)/.36), transparent 70%),
      radial-gradient(60% 28% at 50% 16%, rgb(var(--ion-b)/.26), transparent 70%),
      var(--night);
    background-attachment:fixed}
  main{max-width:560px;margin:0 auto;padding:28px 16px 140px}
  a{color:rgb(var(--ion-a))}
  :focus-visible{outline:3px solid rgb(var(--ion-a));outline-offset:2px}

  .eyebrow{font:800 13px/1 var(--display);letter-spacing:.24em;text-transform:uppercase;color:var(--gold)}
  h1{font:800 40px/1 var(--display);text-transform:uppercase;letter-spacing:.03em;margin:10px 0 6px;color:var(--cream)}
  .lede{font:italic 500 22px/1.25 var(--serif);color:var(--gold);margin:0 0 18px;text-shadow:0 0 22px rgba(255,192,77,.35)}
  .stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0 0 6px}
  .stat{background:var(--glass);border:1px solid var(--edge);border-radius:14px;padding:10px 12px;box-shadow:inset 0 1px 0 rgba(255,255,255,.08)}
  .stat b{display:block;font:800 30px/1 var(--display);color:var(--ink)}
  .stat span{font-size:13px;color:var(--muted)}
  .stat.hot b{color:var(--gold)}
  .window{font-size:13px;color:var(--dim);margin:8px 0 0}
  .banner{background:rgba(255,111,97,.16);border:1px solid var(--coral);color:var(--cream);padding:10px 12px;border-radius:12px;margin:14px 0;font-weight:600}

  h2{font:800 20px/1 var(--display);text-transform:uppercase;letter-spacing:.08em;margin:30px 0 12px;color:var(--ink);display:flex;align-items:center;gap:10px}
  h2 .n{font:700 14px/1 var(--display);border:1px solid var(--edge-2);color:var(--muted);border-radius:999px;padding:4px 9px;letter-spacing:.04em}

  .card{background:var(--glass);border:1px solid var(--edge);border-radius:18px;padding:16px;margin:0 0 12px;box-shadow:inset 0 1px 0 rgba(255,255,255,.08);
    -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
  .card.hot{border-color:rgba(255,192,77,.7);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 0 0 1px rgba(255,192,77,.2),0 0 26px -8px rgba(255,192,77,.55)}
  .card.urgent{border-color:rgba(255,111,97,.75);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 0 0 1px rgba(255,111,97,.2),0 0 26px -8px rgba(255,111,97,.55)}
  .card.slim{padding:14px 16px}
  .row{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
  h3{font:700 22px/1.1 var(--display);letter-spacing:.02em;margin:0}
  .tag{font:700 12px/1 var(--display);letter-spacing:.1em;text-transform:uppercase;border:1px solid var(--edge-2);border-radius:999px;padding:6px 9px;white-space:nowrap;color:var(--muted)}
  .tag.hot{color:var(--gold);border-color:var(--gold)} .tag.urgent{color:var(--coral);border-color:var(--coral)}
  .meta{color:var(--muted);font-size:14.5px;margin-top:3px} .small{font-size:13px}
  .bubble{margin:12px 0 8px;padding:12px 14px;background:var(--field);border:1px solid var(--edge);border-radius:16px 16px 16px 5px;white-space:pre-wrap;line-height:1.45}
  blockquote{margin:12px 0 8px;padding:10px 14px;background:rgba(255,244,230,.07);border-left:3px solid var(--gold);border-radius:4px 12px 12px 4px;font-size:17px}
  .warn{background:rgba(255,111,97,.12);border:1px solid rgba(255,111,97,.5);padding:8px 10px;border-radius:10px;margin:8px 0;font-size:14px}

  .actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0 0}
  .btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 16px;border-radius:999px;border:1px solid transparent;
    background:linear-gradient(180deg,#FFD27A,var(--gold));color:var(--night);font:700 15.5px var(--ui);text-decoration:none;cursor:pointer;box-shadow:0 8px 22px -12px rgba(255,192,77,.8)}
  .btn.ghost{background:transparent;color:var(--ink);border-color:var(--edge-2);box-shadow:none}
  .btn.ok{background:transparent;color:var(--ok);border-color:rgba(60,255,170,.6);box-shadow:none;margin-left:auto}
  .chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid var(--edge)}
  .chips:empty{display:none}
  .chip{min-height:36px;padding:0 13px;border-radius:999px;border:1px solid var(--edge);background:transparent;color:var(--muted);font:500 14px var(--ui);cursor:pointer}
  .chip.danger{color:var(--coral);border-color:rgba(255,111,97,.45)}
  .check{display:flex;gap:6px;align-items:center;margin-left:auto;color:var(--muted)}
  .check input{width:22px;height:22px;accent-color:var(--ok)}
  button:disabled{opacity:.5}

  ul{padding-left:18px;color:var(--ink)} li{margin:6px 0}
  code{font:13px ui-monospace,Menlo,monospace;background:var(--field);border:1px solid var(--edge);padding:1px 6px;border-radius:6px;overflow-wrap:anywhere}
  .empty{padding:16px;border:1px dashed var(--edge-2);border-radius:18px;color:var(--muted);text-align:center}
  .dock{position:fixed;left:0;right:0;bottom:0;background:rgba(3,6,26,.86);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
    border-top:1px solid var(--edge);padding:10px 16px calc(10px + env(safe-area-inset-bottom))}
  .dock .inner{max-width:560px;margin:0 auto;display:flex;gap:10px;align-items:center}
  .dock code,.dock .done{flex:1;min-width:0}
  .done{color:var(--ok);font-weight:600}
  .toast{position:fixed;left:16px;right:16px;bottom:84px;max-width:528px;margin:0 auto;background:var(--midnight);border:1px solid var(--coral);color:var(--cream);padding:10px 14px;border-radius:12px;display:none}
  @media (prefers-reduced-motion:no-preference){ .card{animation:rise .5s cubic-bezier(.16,1,.3,1) both} @keyframes rise{from{opacity:0;transform:translateY(8px)}} }
</style>
</head>
<body>
<main>
  <div class="eyebrow">Command Center</div>
  <h1>${esc(fmt({ weekday: "long" }))}, ${esc(fmt({ month: "short", day: "numeric" }))}</h1>
  <p class="lede">${esc(headline)}</p>
  <div class="stats">
    <div class="stat${hot ? " hot" : ""}"><b>${handoffs.length}</b><span>replies</span></div>
    <div class="stat"><b>${drafts.length}</b><span>to text</span></div>
    <div class="stat"><b>${callList.length}</b><span>to call</span></div>
  </div>
  <div class="window">Texts go out ${esc(fmt12(config.sendStart))} to ${esc(fmt12(config.sendEnd))}. Private to this device.</div>
  ${config.killSwitch ? `<div class="banner">Kill switch is on. Nothing should be sent.</div>` : ""}

  <h2>Waiting on you <span class="n">${handoffs.length}</span></h2>
  ${handoffCards || `<div class="empty">No replies waiting.</div>`}

  <h2>Text these <span class="n">${drafts.length}</span></h2>
  ${draftCards || `<div class="empty">Nobody is due for a text today.</div>`}

  <h2>Call instead <span class="n">${callList.length}</span></h2>
  ${callCards || `<div class="empty">Nobody.</div>`}
  ${callCards && !live ? `<p class="meta small">Due today, but no permission to text on file. Ask on the call, then: <code>consent PHONE --source "asked on call"</code></p>` : ""}

  ${skippedRows ? `<h2>Held back <span class="n">${skipped.length}</span></h2><ul>${skippedRows}</ul>` : ""}
</main>
${dock}
<div class="toast" id="toast" role="status"></div>
<script>
(function () {
  var KEY = ${live ? JSON.stringify(live.key) : "null"};
  function toast(msg) { var t = document.getElementById("toast"); t.textContent = msg; t.style.display = "block"; setTimeout(function () { t.style.display = "none"; }, 3500); }
  function copy(text, btn) {
    function done() { if (btn) { var t = btn.textContent; btn.textContent = "Copied"; setTimeout(function () { btn.textContent = t; }, 1200); } }
    function fallback() {
      var ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", "");
      ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) {} document.body.removeChild(ta);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }
  document.addEventListener("click", function (e) {
    var c = e.target.closest("[data-copy]"); if (c) return copy(c.getAttribute("data-copy"), c);
    var b = e.target.closest("[data-act]"); if (!b || !KEY) return;
    var args = JSON.parse(b.getAttribute("data-args") || "{}");
    if (b.hasAttribute("data-confirm") && !confirm(b.getAttribute("data-confirm"))) return;
    if (b.hasAttribute("data-prompt")) {
      var src = prompt(b.getAttribute("data-prompt"), "said yes on a call"); if (!src) return; args.source = src;
    }
    b.disabled = true;
    fetch("/api/action", { method: "POST", headers: { "content-type": "application/json", "x-pa-key": KEY },
      body: JSON.stringify({ action: b.getAttribute("data-act"), args: args }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { r: r, j: j }; }); })
      .then(function (x) {
        if (x.r.ok && x.j.ok) return location.reload();
        b.disabled = false; toast("Didn't save: " + (x.j.detail || x.j.reason || x.r.status));
      })
      .catch(function () { b.disabled = false; toast("Can't reach the Command Center. Is it still running?"); });
  });
  var cmd = document.getElementById("cmd");
  if (cmd) {
    document.addEventListener("change", function (e) {
      if (!e.target.matches("[data-sent]")) return;
      var ids = [].slice.call(document.querySelectorAll("[data-sent]:checked")).map(function (x) { return x.getAttribute("data-sent"); });
      cmd.textContent = ids.length ? "node src/cli.js sent " + ids.join(" ") : "Tick what you sent";
    });
    document.getElementById("copyCmd").addEventListener("click", function (e) {
      if (cmd.textContent.indexOf("node ") === 0) copy(cmd.textContent, e.currentTarget);
    });
  }
})();
</script>
</body>
</html>
`;
}
