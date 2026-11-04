import { money, signatureStatus, checkReady } from "./listing.js";

/**
 * Builds everything a price change needs, from the listing file:
 *   - a text and an email to each seller (why, and what to sign)
 *   - the one-page price-change authorization to sign
 *   - a heads-up to the co-agent
 *   - once live: a note to everyone who made an offer, and the MLS checklist
 * Nothing here sends anything. Every message opens on your phone for you to send.
 */

const h = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const first = (name) => String(name || "").trim().split(/\s+/)[0] || "there";
/** What to call a seller: "callName" from the listing file (e.g. "Mom"), else their first name. */
const greet = (s) => (s.callName && s.callName.trim()) || first(s.name);
const tidy = (text) => text.replace(/\n{3,}/g, "\n\n").trim();
const shortAddr = (l) => l.address.replace(/,.*$/, "");
const ppsf = (price, sqft) => (price && sqft ? Math.round(price / sqft) : null);
const monthYear = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
};

function e164(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return "";
}

/** Best comp to lead with: the closest in size among recent sales, else the first one. */
export function leadComp(l) {
  const sold = l.comps.filter((c) => c.price);
  if (!sold.length) return null;
  const sq = l.facts.sqft;
  if (!sq) return sold[0];
  return [...sold].sort((a, b) => Math.abs((a.sqft || 0) - sq) - Math.abs((b.sqft || 0) - sq))[0];
}

export function offerSummary(l) {
  const amounts = l.offers.map((o) => o.amount).filter(Boolean);
  if (!amounts.length) return null;
  return { count: amounts.length, low: Math.min(...amounts), high: Math.max(...amounts), cashOnly: l.offers.every((o) => /cash/i.test(o.terms || "cash")) };
}

function why(l, pc) {
  const parts = [];
  const comp = leadComp(l);
  if (comp) parts.push(`${comp.address} (${comp.beds ?? "?"} bed, ${comp.baths ?? "?"} bath${comp.sqft ? `, ${comp.sqft.toLocaleString()} sq ft` : ""}) sold for ${money(comp.price)}${comp.date ? ` in ${monthYear(comp.date)}` : ""}`);
  const o = offerSummary(l);
  if (o) parts.push(`we've had ${o.count} offer${o.count === 1 ? "" : "s"}${o.cashOnly ? ", all cash investors," : ""} between ${money(o.low)} and ${money(o.high)}`);
  if (pc.reason) parts.push(pc.reason);
  return parts;
}

export function sellerText(l, pc, seller) {
  const w = why(l, pc);
  const lines = [
    seller.family ? `Hi ${greet(seller)}, here’s where ${shortAddr(l)} stands.` : `Hi ${greet(seller)}, it's Jamal with an update on ${shortAddr(l)}.`,
    w.length ? `Quick picture: ${w.join(", and ")}.` : "",
    `I recommend we change the list price from ${money(pc.from)} to ${money(pc.to)} so regular buyers, who usually pay more than investors, start seeing it in their searches.`,
    `I'm sending a one-page form to sign. It takes a minute. Call me first if you want to talk it through.`,
  ];
  return lines.filter(Boolean).join(" ");
}

export function sellerEmail(l, pc, seller) {
  const comp = leadComp(l);
  const o = offerSummary(l);
  const compLines = l.comps
    .filter((c) => c.price)
    .map((c) => `- ${c.address}: ${c.beds ?? "?"} bed / ${c.baths ?? "?"} bath${c.sqft ? `, ${c.sqft.toLocaleString()} sq ft` : ""}, sold ${money(c.price)}${c.date ? ` (${monthYear(c.date)})` : ""}${c.note ? ` — ${c.note}` : ""}`);
  const offerLines = l.offers
    .filter((x) => x.amount)
    .map((x) => `- ${money(x.amount)}${x.terms ? ` ${x.terms}` : ""}${x.status ? ` (${x.status})` : ""}`);
  const subject = `${shortAddr(l)}: recommended price change to ${money(pc.to)}`;
  const body = [
    `Hi ${greet(seller)},`,
    "",
    `Here's where ${shortAddr(l)} stands and what I recommend.`,
    "",
    `Recommendation: change the list price from ${money(pc.from)} to ${money(pc.to)}.`,
    pc.reason ? `\nWhy: ${pc.reason}` : "",
    compLines.length ? `\nRecent sales nearby:\n${compLines.join("\n")}` : "",
    offerLines.length ? `\nOffers we've received:\n${offerLines.join("\n")}` : "",
    "",
    o && comp
      ? `The offers are from investors who price in repairs and profit, so they come in low. Regular buyers pay more, but they need a price their bank's appraisal will back up, and the sales above are what the appraiser will look at. ${money(pc.to)} keeps us in that range and still leaves room to negotiate.`
      : `${money(pc.to)} puts us where buyers searching this area will see it, and still leaves room to negotiate.`,
    "",
    `Nothing changes until every owner signs the attached one-page form. Everything else in the listing agreement stays the same.`,
    "",
    `Call or text me with any questions.`,
    "",
    `${l.listingAgent.name || "Jamal"}`,
    [l.listingAgent.brokerage, l.listingAgent.phone].filter(Boolean).join(" · "),
  ];
  return { subject, body: tidy(body.join("\n")) };
}

export function coAgentNote(l, pc) {
  const name = first(l.coAgent.name);
  return [
    `Hi ${name}, heads up on ${shortAddr(l)}: I'm getting the sellers' signatures to change the list price from ${money(pc.from)} to ${money(pc.to)}.`,
    `As soon as everyone signs I'll send you the executed form so we can update MLS.`,
    `Does Beachfront need its own amendment form in dotloop for this, or does the signed authorization work?`,
  ].join(" ");
}

export function offerFollowUp(l, pc, offer) {
  const subject = `Price update: ${shortAddr(l)} now ${money(pc.to)}`;
  const body = [
    `Hi ${first(offer.contactName || "")},`.replace("Hi there,", "Hello,"),
    "",
    `Following up on your interest in ${l.address}${l.cityStateZip ? `, ${l.cityStateZip}` : ""}. The list price is now ${money(pc.to)}.`,
    offer.amount ? `You were at ${money(offer.amount)}. If you'd like to take another look, send an updated offer with proof of funds and I'll present it right away.` : `If you'd like to take another look, send an offer with proof of funds and I'll present it right away.`,
    l.facts.tenantOccupied ? `It's still tenant-occupied, so showings need notice.` : "",
    "",
    `${l.listingAgent.name || "Jamal"}`,
    [l.listingAgent.brokerage, l.listingAgent.phone].filter(Boolean).join(" · "),
  ];
  return { subject, body: tidy(body.join("\n")) };
}

export function mlsChecklist(l, pc) {
  return [
    `Send the fully signed price-change form to ${l.coAgent.name || "your broker"} and file it in the transaction (dotloop).`,
    `Update the list price on MLS${l.mlsNumber ? ` (#${l.mlsNumber})` : ""} to ${money(pc.to)}.`,
    `Check that Zillow, Realtor.com and Redfin show ${money(pc.to)} within 24–48 hours.`,
    `Send the price update to everyone who made an offer (below).`,
    `Run: listing live ${l.slug}  (records the new price and history)`,
  ];
}

/** Plain-text bundle, for copying anywhere. */
export function packetText(l) {
  const pc = l.pendingChange;
  const out = [`PRICE CHANGE — ${l.address}`, `${money(pc.from)} -> ${money(pc.to)} (${pc.pct > 0 ? "+" : ""}${pc.pct}%)`, ""];
  for (const s of l.sellers.filter((x) => x.name)) {
    const e = sellerEmail(l, pc, s);
    out.push(`--- TEXT to ${s.name}${s.phone ? ` (${s.phone})` : ""} ---`, sellerText(l, pc, s), "");
    out.push(`--- EMAIL to ${s.name}${s.email ? ` <${s.email}>` : ""} ---`, `Subject: ${e.subject}`, "", e.body, "");
  }
  if (l.coAgent.name) out.push(`--- TEXT to ${l.coAgent.name} ---`, coAgentNote(l, pc), "");
  out.push("--- AFTER IT'S LIVE ---", ...mlsChecklist(l, pc).map((x, i) => `${i + 1}. ${x}`), "");
  for (const o of l.offers.filter((x) => x.email)) {
    const f = offerFollowUp(l, pc, o);
    out.push(`--- EMAIL to ${o.buyer || o.email} <${o.email}> ---`, `Subject: ${f.subject}`, "", f.body, "");
  }
  return out.join("\n");
}

export function addendumHtml(l, { now = new Date() } = {}) {
  const pc = l.pendingChange;
  const sellers = Object.keys(pc.signatures);
  const today = now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Price Change Authorization</title>
<style>
  :root{color-scheme:light}
  body{margin:0;background:#f4f4f2;color:#111;font:15px/1.5 Georgia,'Times New Roman',serif}
  .page{max-width:720px;margin:24px auto;background:#fff;padding:48px 56px;box-shadow:0 1px 6px rgba(0,0,0,.12)}
  h1{font:700 20px/1.2 Arial,Helvetica,sans-serif;letter-spacing:.04em;text-transform:uppercase;text-align:center;margin:0 0 4px}
  .sub{text-align:center;font:13px Arial,Helvetica,sans-serif;color:#555;margin:0 0 28px}
  table{width:100%;border-collapse:collapse;margin:0 0 22px;font-size:15px}
  td{padding:7px 0;border-bottom:1px solid #ddd;vertical-align:top} td:first-child{width:42%;color:#555}
  .price{font:700 17px Arial,Helvetica,sans-serif}
  .sig{display:grid;grid-template-columns:2fr 1fr;gap:6px 24px;margin:34px 0 0}
  .line{border-bottom:1px solid #111;height:34px} .lab{font:12px Arial,Helvetica,sans-serif;color:#555}
  .note{font:12px/1.45 Arial,Helvetica,sans-serif;color:#666;margin-top:36px;border-top:1px solid #ddd;padding-top:10px}
  .print{display:block;margin:16px auto;font:600 15px Arial,sans-serif;padding:10px 18px;border-radius:8px;border:1px solid #111;background:#fff;cursor:pointer}
  @media (max-width:600px){.page{margin:0;padding:28px 18px;box-shadow:none}}
  @media print{body{background:#fff}.page{box-shadow:none;margin:0;padding:0}.print{display:none}}
</style></head><body>
<button class="print" type="button" onclick="window.print()">Print or save as PDF</button>
<div class="page">
  <h1>Seller Authorization to Change List Price</h1>
  <p class="sub">Amendment to Exclusive Right of Sale Listing Agreement</p>
  <table>
    <tr><td>Property</td><td>${h(l.address)}${l.cityStateZip ? `, ${h(l.cityStateZip)}` : ""}</td></tr>
    <tr><td>MLS number</td><td>${h(l.mlsNumber) || "_______________"}</td></tr>
    <tr><td>Listing agreement dated</td><td>${h(l.agreementDate) || "_______________"}</td></tr>
    <tr><td>Listing brokerage</td><td>${h(l.listingAgent.brokerage) || "_______________"}</td></tr>
    <tr><td>Current list price</td><td class="price">${money(pc.from)}</td></tr>
    <tr><td>New list price</td><td class="price">${money(pc.to)}</td></tr>
  </table>
  <p>The undersigned Seller(s) authorize the Listing Brokerage to change the list price of the Property from <b>${money(pc.from)}</b> to <b>${money(pc.to)}</b>, effective when all Sellers have signed. All other terms of the Listing Agreement remain unchanged.</p>
  <div class="sig">
    ${sellers.map((n) => `<div><div class="line"></div><div class="lab">Seller signature — ${h(n)}</div></div><div><div class="line"></div><div class="lab">Date</div></div>`).join("\n    ")}
    <div><div class="line"></div><div class="lab">Listing agent — ${h(l.listingAgent.name) || "name"}${l.listingAgent.brokerage ? `, ${h(l.listingAgent.brokerage)}` : ""}</div></div><div><div class="line"></div><div class="lab">Date</div></div>
  </div>
  <p class="note">Prepared ${h(today)}. If your brokerage requires its standard amendment form (for example in dotloop), use that form with these same prices. This page is a working document, not legal advice.</p>
</div></body></html>`;
}

function copyBlock(id, label, text, links = []) {
  return `<div class="msg">
    <div class="msghead"><b>${h(label)}</b></div>
    <blockquote id="${id}">${h(text).replace(/\n/g, "<br>")}</blockquote>
    <div class="row">${links.join("")}<button class="btn ghost" type="button" data-copy="${id}">Copy</button></div>
  </div>`;
}

export function packetHtml(l, { now = new Date() } = {}) {
  const pc = l.pendingChange;
  const st = signatureStatus(l);
  const ready = checkReady(l);
  const sqft = l.facts.sqft;
  const comp = leadComp(l);
  const o = offerSummary(l);
  let n = 0;
  const id = () => "m" + ++n;

  const sellerCards = l.sellers
    .filter((s) => s.name)
    .map((s) => {
      const t = sellerText(l, pc, s);
      const e = sellerEmail(l, pc, s);
      const phone = e164(s.phone);
      const sms = phone ? `<a class="btn" href="sms:${phone}?&amp;body=${encodeURIComponent(t)}">Open in Messages</a>` : "";
      const mail = s.email ? `<a class="btn" href="mailto:${encodeURIComponent(s.email)}?subject=${encodeURIComponent(e.subject)}&amp;body=${encodeURIComponent(e.body)}">Open in Mail</a>` : "";
      const signed = pc.signatures[s.name.trim()];
      return `<article class="card">
  <div class="cardhead"><h3>${h(s.name)}</h3><span class="tag ${signed ? "ok" : "hot"}">${signed ? "Signed" : "Needs to sign"}</span></div>
  ${!phone && !s.email ? `<p class="warn">No phone or email on file. Add one to the listing file, or copy the text below.</p>` : ""}
  ${copyBlock(id(), "Text", t, [sms])}
  ${copyBlock(id(), `Email — ${e.subject}`, e.body, [mail])}
</article>`;
    })
    .join("\n");

  const coPhone = e164(l.coAgent.phone);
  const coText = l.coAgent.name ? coAgentNote(l, pc) : "";
  const offerCards = l.offers
    .filter((x) => x.email || x.phone)
    .map((x) => {
      const f = offerFollowUp(l, pc, x);
      const mail = x.email ? `<a class="btn" href="mailto:${encodeURIComponent(x.email)}?subject=${encodeURIComponent(f.subject)}&amp;body=${encodeURIComponent(f.body)}">Open in Mail</a>` : "";
      return copyBlock(id(), `${x.buyer || x.email} — offered ${money(x.amount)}`, `Subject: ${f.subject}\n\n${f.body}`, [mail]);
    })
    .join("\n");

  const compRows = l.comps
    .filter((c) => c.price)
    .map((c) => `<tr><td>${h(c.address)}</td><td>${c.beds ?? "?"}/${c.baths ?? "?"}</td><td>${c.sqft ? c.sqft.toLocaleString() : "—"}</td><td>${money(c.price)}</td><td>${ppsf(c.price, c.sqft) ? "$" + ppsf(c.price, c.sqft) : "—"}</td></tr>`)
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#03061a">
<title>Price Change Packet</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Barlow:wght@400;500;600;700&family=Fraunces:ital,wght@1,500&display=swap" rel="stylesheet">
<style>
  :root{color-scheme:dark;--night:#03061a;--ink:#EEF2FF;--muted:#A9B4D0;--dim:#6F7B99;--glass:rgba(13,19,48,.74);--edge:rgba(255,255,255,.13);--edge-2:rgba(255,255,255,.24);--field:rgba(255,255,255,.06);
    --cream:#FFF4E6;--gold:#FFC04D;--ok:#3CFFAA;--coral:#FF6F61;--ion:34 230 255;
    --display:'Barlow Condensed','Arial Narrow',system-ui,sans-serif;--ui:'Barlow',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;--serif:'Fraunces',Georgia,serif}
  *{box-sizing:border-box} html{background:var(--night)}
  body{margin:0;color:var(--ink);font:16px/1.45 var(--ui);min-height:100vh;background:radial-gradient(46% 20% at 75% 0%,rgb(var(--ion)/.30),transparent 70%),radial-gradient(40% 22% at 20% 4%,rgb(60 255 170/.22),transparent 70%),var(--night);background-attachment:fixed}
  main{max-width:600px;margin:0 auto;padding:28px 16px 80px}
  .eyebrow{font:800 13px/1 var(--display);letter-spacing:.24em;text-transform:uppercase;color:var(--gold)}
  h1{font:800 36px/1.02 var(--display);text-transform:uppercase;letter-spacing:.03em;margin:10px 0 6px;color:var(--cream)}
  .lede{font:italic 500 22px/1.25 var(--serif);color:var(--gold);margin:0 0 18px}
  h2{font:800 20px/1 var(--display);text-transform:uppercase;letter-spacing:.08em;margin:32px 0 12px}
  h2 .step{color:var(--gold);margin-right:8px}
  h3{font:700 22px/1.1 var(--display);margin:0}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
  .stat{background:var(--glass);border:1px solid var(--edge);border-radius:14px;padding:12px}
  .stat b{display:block;font:800 26px/1 var(--display)} .stat span{font-size:13px;color:var(--muted)}
  .stat.hot b{color:var(--gold)}
  .card{background:var(--glass);border:1px solid var(--edge);border-radius:18px;padding:16px;margin:0 0 14px;backdrop-filter:blur(10px)}
  .cardhead{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:6px}
  .tag{font:700 12px/1 var(--display);letter-spacing:.1em;text-transform:uppercase;border:1px solid var(--edge-2);border-radius:999px;padding:6px 9px;white-space:nowrap;color:var(--muted)}
  .tag.hot{color:var(--gold);border-color:var(--gold)} .tag.ok{color:var(--ok);border-color:var(--ok)}
  .msg{margin-top:12px} .msghead{font-size:14px;color:var(--muted)}
  blockquote{margin:8px 0;padding:10px 14px;background:rgba(255,244,230,.07);border-left:3px solid var(--gold);border-radius:4px 12px 12px 4px;font-size:16px;overflow-wrap:anywhere}
  .row{display:flex;flex-wrap:wrap;gap:8px}
  .btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 16px;border-radius:12px;border:0;background:linear-gradient(180deg,#FFD27A,var(--gold));color:var(--night);font:700 15px var(--ui);text-decoration:none;cursor:pointer}
  .btn.ghost{background:transparent;color:var(--ink);border:1px solid var(--edge-2)}
  .warn{background:rgba(255,111,97,.12);border:1px solid rgba(255,111,97,.5);padding:8px 10px;border-radius:10px;margin:8px 0;font-size:14px}
  .tablewrap{overflow-x:auto} table{width:100%;border-collapse:collapse;font-size:14px} th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--edge)} th{color:var(--muted);font-weight:600}
  ol{padding-left:20px} li{margin:6px 0}
  code{font:13px ui-monospace,Menlo,monospace;background:var(--field);border:1px solid var(--edge);padding:1px 6px;border-radius:6px;overflow-wrap:anywhere}
  :focus-visible{outline:3px solid rgb(var(--ion));outline-offset:2px}
  @media (max-width:420px){.stats{grid-template-columns:1fr 1fr}h1{font-size:30px}}
</style></head><body><main>
  <div class="eyebrow">Price change packet</div>
  <h1>${h(shortAddr(l))}</h1>
  <p class="lede">${money(pc.from)} → ${money(pc.to)}</p>
  <div class="stats">
    <div class="stat hot"><b>${pc.pct > 0 ? "+" : ""}${pc.pct}%</b><span>change</span></div>
    <div class="stat"><b>${st.signed.length}/${st.signed.length + st.waiting.length}</b><span>signed</span></div>
    <div class="stat"><b>${sqft && ppsf(pc.to, sqft) ? "$" + ppsf(pc.to, sqft) : "—"}</b><span>per sq ft${comp && ppsf(comp.price, comp.sqft) ? ` · comp $${ppsf(comp.price, comp.sqft)}` : ""}</span></div>
  </div>
  ${ready.missing.length ? `<p class="warn">Missing from the listing file: ${h(ready.missing.join("; "))}.</p>` : ""}
  ${pc.liveAt ? `<p class="warn" style="border-color:var(--ok);background:rgba(60,255,170,.1)">Live on MLS since ${h(pc.liveAt.slice(0, 10))}.</p>` : ""}

  ${compRows || o ? `<h2>The numbers</h2><div class="card">
    ${compRows ? `<div class="tablewrap"><table><tr><th>Recent sale</th><th>Bd/Ba</th><th>Sq ft</th><th>Price</th><th>$/sf</th></tr>${compRows}
      <tr><td><b>This home at ${money(pc.to)}</b></td><td>${l.facts.beds ?? "?"}/${l.facts.baths ?? "?"}</td><td>${sqft ? sqft.toLocaleString() : "—"}</td><td><b>${money(pc.to)}</b></td><td><b>${ppsf(pc.to, sqft) ? "$" + ppsf(pc.to, sqft) : "—"}</b></td></tr></table></div>` : ""}
    ${o ? `<p class="msghead" style="margin-top:12px">${o.count} offer${o.count === 1 ? "" : "s"} on file: ${money(o.low)} – ${money(o.high)}.</p>` : ""}
  </div>` : ""}

  <h2><span class="step">1</span>Send to the sellers</h2>
  <p class="msghead">Attach the price-change form (<code>addendum.html</code>, print or save as PDF), or send it through dotloop.</p>
  ${sellerCards}

  ${l.coAgent.name ? `<h2><span class="step">2</span>Heads-up to ${h(first(l.coAgent.name))}</h2>
  <div class="card">${copyBlock(id(), l.coAgent.name, coText, coPhone ? [`<a class="btn" href="sms:${coPhone}?&amp;body=${encodeURIComponent(coText)}">Open in Messages</a>`] : [])}</div>` : ""}

  <h2><span class="step">${l.coAgent.name ? 3 : 2}</span>Track signatures</h2>
  <div class="card"><p>As each seller signs, run:</p>
    ${Object.keys(pc.signatures).map((s, i) => `<p><code>node src/cli.js listing signed ${h(l.slug)} ${i + 1}</code> ${h(s)} ${pc.signatures[s] ? `<span class="tag ok">signed ${h(pc.signatures[s].slice(0, 10))}</span>` : ""}</p>`).join("")}
  </div>

  <h2><span class="step">${l.coAgent.name ? 4 : 3}</span>Once everyone signs</h2>
  <div class="card"><ol>${mlsChecklist(l, pc).map((x) => `<li>${h(x)}</li>`).join("")}</ol></div>
  ${offerCards ? `<h2>Tell the buyers who offered</h2><p class="msghead">Send these only after the new price is live on MLS.</p><div class="card">${offerCards}</div>` : ""}
</main>
<script>
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copy]"); if (!b) return;
    const t = document.getElementById(b.dataset.copy).innerText;
    try { await navigator.clipboard.writeText(t); b.textContent = "Copied"; } catch { b.textContent = "Select and copy"; }
    setTimeout(() => (b.textContent = "Copy"), 1600);
  });
</script>
</body></html>`;
}
