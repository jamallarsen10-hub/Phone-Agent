import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * Listings live in data/listings/<slug>.json. data/ is gitignored, so seller
 * names, phones, the address and every offer stay on this machine. The code in
 * this folder only ever sees them at run time. See src/listing/privacy.js for
 * the commit guard that backs this up.
 */

export function listingsDir(dataDir) {
  return join(dataDir, "listings");
}

export function listingPath(dataDir, slug) {
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug)) throw new Error(`"${slug}" is not a valid listing name. Use lowercase letters, numbers and dashes.`);
  return join(listingsDir(dataDir), `${slug}.json`);
}

export function listSlugs(dataDir) {
  const dir = listingsDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}

export function loadListing(dataDir, slug) {
  const path = listingPath(dataDir, slug);
  if (!existsSync(path)) throw new Error(`No listing "${slug}". Create it with: listing new ${slug} --address "..." --price 000000`);
  let l;
  try {
    l = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${e.message}`);
  }
  return normalize(l, slug);
}

export function saveListing(dataDir, listing) {
  const path = listingPath(dataDir, listing.slug);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(listing, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

export function blankListing(slug, { address = "", price = null } = {}) {
  return normalize(
    {
      slug,
      address,
      cityStateZip: "",
      mlsNumber: "",
      agreementDate: "",
      currentPrice: price,
      facts: { beds: null, baths: null, sqft: null, yearBuilt: null, tenantOccupied: false },
      sellers: [{ name: "", phone: "", email: "" }],
      listingAgent: { name: "", brokerage: "", phone: "", email: "" },
      coAgent: { name: "", brokerage: "", phone: "", email: "" },
      comps: [],
      offers: [],
      priceHistory: price ? [{ price, at: new Date().toISOString(), reason: "starting price" }] : [],
      pendingChange: null,
    },
    slug
  );
}

function normalize(l, slug) {
  return {
    slug: l.slug || slug,
    address: l.address || "",
    cityStateZip: l.cityStateZip || "",
    mlsNumber: l.mlsNumber || "",
    agreementDate: l.agreementDate || "",
    currentPrice: l.currentPrice ?? null,
    facts: { beds: null, baths: null, sqft: null, yearBuilt: null, tenantOccupied: false, ...(l.facts || {}) },
    sellers: Array.isArray(l.sellers) ? l.sellers : [],
    listingAgent: { name: "", brokerage: "", phone: "", email: "", ...(l.listingAgent || {}) },
    coAgent: { name: "", brokerage: "", phone: "", email: "", ...(l.coAgent || {}) },
    comps: Array.isArray(l.comps) ? l.comps : [],
    offers: Array.isArray(l.offers) ? l.offers : [],
    priceHistory: Array.isArray(l.priceHistory) ? l.priceHistory : [],
    pendingChange: l.pendingChange || null,
  };
}

/** "339,900", "$339900", "339.9k" -> 339900. Returns null when it can't tell. */
export function parsePrice(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.round(raw) : null;
  const s = String(raw || "").trim().toLowerCase().replace(/[$,\s]/g, "");
  const m = s.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return null;
  const mult = m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1;
  return Math.round(Number(m[1]) * mult);
}

export const money = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));

/** What's missing before a packet can go out. Blocking problems vs. nice-to-haves. */
export function checkReady(l) {
  const blocking = [];
  const missing = [];
  if (!l.address) blocking.push("address");
  if (!l.currentPrice) blocking.push("currentPrice (the live MLS price)");
  const named = l.sellers.filter((s) => s.name && s.name.trim());
  if (!named.length) blocking.push("at least one seller name");
  for (const s of named) if (!s.phone && !s.email) missing.push(`a phone or email for ${s.name}`);
  if (!l.listingAgent.name) missing.push("listingAgent.name");
  if (!l.mlsNumber) missing.push("mlsNumber");
  if (!l.agreementDate) missing.push("agreementDate (date of the listing agreement)");
  if (!l.comps.length) missing.push("comps (recent nearby sales)");
  return { blocking, missing };
}

/**
 * Start a price change. Throws on anything that looks like a typo, so a
 * fat-fingered "33990" never reaches the sellers.
 */
export function startPriceChange(l, { to, reason = "", now = new Date(), replace = false, force = false }) {
  const price = parsePrice(to);
  if (!price) throw new Error(`"${to}" is not a price. Try 339900 or 339.9k.`);
  if (price < 25000) throw new Error(`${money(price)} looks like a typo. Prices are whole dollars, e.g. 339900.`);
  if (!l.currentPrice) throw new Error("Set currentPrice (the live MLS price) in the listing file first.");
  // A dropped or extra digit moves the price 90% or 10x. Anything past +/-50% needs --force.
  if (!force && (price < l.currentPrice * 0.5 || price > l.currentPrice * 1.5))
    throw new Error(`${money(price)} is far from the current ${money(l.currentPrice)} and looks like a typo. Add --force if it's right.`);
  if (price === l.currentPrice) throw new Error(`The list price is already ${money(price)}.`);
  if (l.pendingChange && !l.pendingChange.liveAt && !replace)
    throw new Error(
      `There's already a change to ${money(l.pendingChange.to)} waiting on signatures. Add --replace to start over (the sellers must sign the new number).`
    );
  const pct = ((price - l.currentPrice) / l.currentPrice) * 100;
  const sellers = l.sellers.filter((s) => s.name && s.name.trim()).map((s) => s.name.trim());
  if (!sellers.length) throw new Error("Add the sellers' names to the listing file first.");
  l.pendingChange = {
    id: "pc-" + now.toISOString().slice(0, 10) + "-" + price,
    from: l.currentPrice,
    to: price,
    pct: Math.round(pct * 10) / 10,
    reason,
    createdAt: now.toISOString(),
    signatures: Object.fromEntries(sellers.map((n) => [n, null])),
    coAgentNotifiedAt: null,
    liveAt: null,
  };
  const warnings = [];
  if (pct > 0) warnings.push(`This is a price INCREASE of ${pct.toFixed(1)}%.`);
  if (pct < -15) warnings.push(`This is a ${Math.abs(pct).toFixed(1)}% cut. Double-check the number before it goes to the sellers.`);
  return { change: l.pendingChange, warnings };
}

/** Find one seller by full name, first name or 1-based number. */
export function matchSeller(l, who) {
  const pc = l.pendingChange;
  if (!pc) throw new Error("No price change is waiting on signatures.");
  const names = Object.keys(pc.signatures);
  const q = String(who || "").trim().toLowerCase();
  if (/^\d+$/.test(q)) {
    const n = names[Number(q) - 1];
    if (n) return n;
  }
  const exact = names.filter((n) => n.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const partial = names.filter((n) => n.toLowerCase().split(/\s+/).includes(q) || n.toLowerCase().startsWith(q));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`"${who}" matches ${partial.join(", ")}. Use the full name or number.`);
  throw new Error(`No seller "${who}". Sellers: ${names.map((n, i) => `${i + 1}. ${n}`).join("  ")}`);
}

export function markSigned(l, who, { now = new Date(), undo = false } = {}) {
  const name = matchSeller(l, who);
  l.pendingChange.signatures[name] = undo ? null : now.toISOString();
  return { name, ...signatureStatus(l) };
}

export function signatureStatus(l) {
  const pc = l.pendingChange;
  if (!pc) return { signed: [], waiting: [], allSigned: false };
  const entries = Object.entries(pc.signatures);
  const signed = entries.filter(([, at]) => at).map(([n]) => n);
  const waiting = entries.filter(([, at]) => !at).map(([n]) => n);
  return { signed, waiting, allSigned: waiting.length === 0 };
}

/** The new price is live on MLS. Only allowed once every seller has signed. */
export function markLive(l, { now = new Date(), force = false } = {}) {
  const pc = l.pendingChange;
  if (!pc) throw new Error("No price change to mark live.");
  if (pc.liveAt) throw new Error(`Already live since ${pc.liveAt.slice(0, 10)}.`);
  const st = signatureStatus(l);
  if (!st.allSigned && !force)
    throw new Error(`Still waiting on: ${st.waiting.join(", ")}. A price change goes live only after every seller signs.`);
  pc.liveAt = now.toISOString();
  l.priceHistory.push({ price: pc.to, at: pc.liveAt, reason: pc.reason || "price change", from: pc.from });
  l.currentPrice = pc.to;
  return pc;
}
