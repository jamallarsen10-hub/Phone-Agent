import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The commit guard. This repo is public; deal and customer data are not.
 *
 * Layer 1: data/ and out/ are gitignored, so private files are never picked up.
 * Layer 2: the pre-commit hook (.githooks/pre-commit) refuses any commit that
 *          force-adds data/ or out/, or whose staged text contains a private
 *          term: a seller, agent or customer name, phone, email, the street, an
 *          MLS number, or anything listed in data/private-terms.txt.
 *
 * The terms are read from your own data/ folder at commit time, so the list of
 * what to block is itself never committed.
 */

const STREET_WORDS = new Set(
  "n s e w ne nw se sw north south east west st street ln lane ave avenue rd road dr drive ct court cir circle blvd boulevard ter terrace way pl place pkwy hwy trl trail apt unit".split(" ")
);

const digits = (s) => String(s || "").replace(/\D/g, "");

/** Last 10 digits of a US phone, or "" if it isn't one. */
export function phoneKey(raw) {
  const d = digits(raw);
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d.length === 10 ? d : "";
}

function addPerson(terms, p, label, { nameParts = true } = {}) {
  if (!p) return;
  const name = String(p.name || "").trim();
  if (name.length >= 4) {
    terms.names.add(name.toLowerCase());
    // Surnames and uncommon first names alone are enough to identify family.
    if (nameParts) for (const part of name.split(/\s+/)) if (part.length >= 5) terms.names.add(part.toLowerCase());
  }
  const ph = phoneKey(p.phone || p.contact);
  if (ph) terms.phones.set(ph, label);
  for (const e of [p.email, p.contact]) if (e && String(e).includes("@")) terms.emails.add(String(e).trim().toLowerCase());
}

/** Street name words from "100 SW Birch Ln" -> ["birch"], plus "100 sw birch". */
export function streetTerms(address) {
  const words = String(address || "").toLowerCase().replace(/[.,#]/g, " ").split(/\s+/).filter(Boolean);
  const out = [];
  const named = words.filter((w) => !/^\d+$/.test(w) && !STREET_WORDS.has(w) && w.length >= 4);
  out.push(...named);
  const num = words.find((w) => /^\d+$/.test(w));
  if (num && named[0]) out.push(`${num} ${words.slice(words.indexOf(num) + 1, words.indexOf(named[0]) + 1).join(" ")}`);
  return out;
}

export function collectPrivateTerms(dataDir) {
  const terms = { names: new Set(), phones: new Map(), emails: new Set(), other: new Set() };

  const ldir = join(dataDir, "listings");
  if (existsSync(ldir)) {
    for (const f of readdirSync(ldir).filter((x) => x.endsWith(".json"))) {
      let l;
      try {
        l = JSON.parse(readFileSync(join(ldir, f), "utf8"));
      } catch {
        continue;
      }
      for (const s of l.sellers || []) addPerson(terms, s, "seller");
      addPerson(terms, l.listingAgent, "listing agent", { nameParts: false });
      addPerson(terms, l.coAgent, "co-agent");
      for (const o of l.offers || []) addPerson(terms, { name: o.contactName, phone: o.phone, email: o.email }, "buyer contact");
      for (const t of streetTerms(l.address)) terms.other.add(t);
      if (l.mlsNumber && String(l.mlsNumber).length >= 5) terms.other.add(String(l.mlsNumber).toLowerCase());
    }
  }

  // Customer leads from the texting engine: full names and phones only.
  const storeFile = join(dataDir, "store.json");
  if (existsSync(storeFile)) {
    try {
      const store = JSON.parse(readFileSync(storeFile, "utf8"));
      for (const lead of Object.values(store.leads || {})) addPerson(terms, lead, "customer", { nameParts: false });
    } catch {
      /* unreadable store: listings and the manual list still apply */
    }
  }

  // Anything else, one per line. Lines starting with # are comments.
  const manual = join(dataDir, "private-terms.txt");
  if (existsSync(manual)) {
    for (const line of readFileSync(manual, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      if (phoneKey(t)) terms.phones.set(phoneKey(t), "private-terms.txt");
      else if (t.length >= 3) terms.other.add(t.toLowerCase());
    }
  }
  return terms;
}

export function termCount(t) {
  return t.names.size + t.phones.size + t.emails.size + t.other.size;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Mask a hit so the warning itself doesn't repeat the private value in full. */
export const mask = (s) => (s.length <= 3 ? "***" : s[0] + "*".repeat(Math.min(s.length - 2, 8)) + s[s.length - 1]);

/** Returns [{line, kind, hint}] for every private term found in text. */
export function scanText(text, terms) {
  const hits = [];
  const lines = String(text).split(/\r?\n/);
  const wordRes = [
    ...[...terms.names].map((t) => ["name", t]),
    ...[...terms.emails].map((t) => ["email", t]),
    ...[...terms.other].map((t) => ["private term", t]),
  ].map(([kind, t]) => [kind, t, new RegExp(`(^|[^a-z0-9])${esc(t)}($|[^a-z0-9])`, "i")]);

  lines.forEach((line, i) => {
    for (const [kind, t, re] of wordRes) if (re.test(line)) hits.push({ line: i + 1, kind, hint: mask(t) });
    const d = digits(line);
    if (d.length >= 10) for (const [ph, label] of terms.phones) if (d.includes(ph)) hits.push({ line: i + 1, kind: `${label} phone`, hint: mask(ph) });
  });
  return hits;
}

/** Paths that must never be committed, even with git add -f. */
export function isForbiddenPath(p) {
  const f = p.replace(/\\/g, "/");
  return /^(data|out)\//.test(f) || /(^|\/)\.env(\.|$)/.test(f) || /(^|\/)store(\.backup)?\.json$/.test(f);
}
