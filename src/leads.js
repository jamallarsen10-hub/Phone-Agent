import { randomUUID } from "node:crypto";
import { parseCSVObjects } from "./csv.js";
import { toE164 } from "./phone.js";
import { parseDate } from "./dates.js";

/**
 * Header aliases for a CDK (or any DMS/CRM) lead export. Matching ignores
 * case, spaces, and punctuation, so "Cell Phone", "cell_phone", and
 * "CELLPHONE" all map to phone. First matching column wins.
 */
export const COLUMN_ALIASES = {
  name: ["name", "customer", "customer name", "full name", "contact", "contact name", "buyer"],
  firstName: ["first name", "first", "fname", "given name"],
  lastName: ["last name", "last", "lname", "surname", "family name"],
  phone: ["cell", "cell phone", "mobile", "mobile phone", "phone", "phone number", "primary phone", "home phone", "work phone", "day phone"],
  email: ["email", "e-mail", "email address"],
  vehicle: ["vehicle", "vehicle of interest", "vehicle interest", "sought vehicle", "model", "desired vehicle", "interest"],
  stage: ["stage", "status", "lead status", "deal status"],
  source: ["source", "lead source"],
  receivedDate: ["created", "created date", "date created", "lead date", "received", "received date", "date"],
  followUpDate: ["follow up", "follow-up", "follow up date", "follow-up date", "next follow up", "next contact", "next contact date", "due date", "next action date"],
  appointmentDate: ["appointment", "appt", "appointment date", "appt date"],
  testDriveDate: ["test drive", "test drive date", "demo", "demo date"],
  showed: ["showed", "show", "shown", "showed up"],
  consent: ["sms consent", "text consent", "ok to text", "okay to text", "sms opt in", "text opt in", "consent", "can text"],
};

const norm = (h) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

export function mapColumns(headers) {
  const map = {};
  const byNorm = new Map(headers.map((h) => [norm(h), h]));
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const a of aliases) {
      if (byNorm.has(norm(a))) {
        map[field] = byNorm.get(norm(a));
        break;
      }
    }
  }
  return map;
}

/** yes/no/unknown from a spreadsheet cell. Unknown stays unknown. */
export function parseYesNo(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (/^(y|yes|true|1|x|ok|opted in|opt in)$/.test(s)) return true;
  if (/^(n|no|false|0|opted out|opt out|do not text|dnt)$/.test(s)) return false;
  return null;
}

const titleCase = (s) =>
  s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, p, c) => p + c.toUpperCase());

export function firstNameOf(lead) {
  const f = (lead.firstName || (lead.name || "").split(/\s+/)[0] || "").trim();
  // A one-letter or numeric "name" reads like a bug in a text. Fall back.
  if (!/^[A-Za-z][A-Za-z'-]{1,}$/.test(f)) return "there";
  return titleCase(f);
}

/** Stages that mean the customer is done, so follow-ups stop. */
export function isClosedStage(stage) {
  return /\b(sold|delivered|purchased|bought|lost|dead|closed|duplicate|bad lead|do not contact|dnc)\b/i.test(stage || "");
}

export function isNoShowStage(stage) {
  return /\bno[-\s]?show|missed\b/i.test(stage || "");
}

function rowToLead(rec, cols) {
  const get = (f) => (cols[f] ? rec[cols[f]] || "" : "");
  const first = get("firstName");
  const last = get("lastName");
  const name = (get("name") || [first, last].filter(Boolean).join(" ")).replace(/\s+/g, " ").trim();
  const rawPhone = get("phone");
  return {
    name,
    firstName: first || "",
    phone: toE164(rawPhone),
    rawPhone,
    email: get("email"),
    vehicle: get("vehicle"),
    stage: get("stage"),
    source: get("source"),
    receivedDate: parseDate(get("receivedDate")),
    followUpDate: parseDate(get("followUpDate")),
    appointmentDate: parseDate(get("appointmentDate")),
    testDriveDate: parseDate(get("testDriveDate")),
    showed: cols.showed ? parseYesNo(get("showed")) : null,
    consentCell: cols.consent ? parseYesNo(get("consent")) : null,
  };
}

const nameKey = (n) => (n || "").toLowerCase().replace(/[^a-z]/g, "");

/**
 * Merge a CSV export into the store. Never deletes a lead.
 *
 * Matching: same phone AND same name is the same lead. Same phone with a
 * different name is a separate lead flagged sharedPhone (households share
 * numbers), and the per-number daily limit and opt-out still cover both.
 * Rows with no usable phone are kept so nothing silently disappears.
 *
 * Consent only becomes true from an explicit yes in a consent column, or from
 * the `consent` command. An explicit no turns it off. A blank cell or a
 * missing column leaves whatever was already recorded.
 */
export function importLeads(store, csvText, { now = new Date(), sourceFile = "import" } = {}) {
  const { headers, records } = parseCSVObjects(csvText);
  const cols = mapColumns(headers);
  const summary = {
    rows: records.length,
    added: 0,
    updated: 0,
    badPhone: 0,
    sharedPhone: 0,
    consentYes: 0,
    columns: cols,
    unmapped: headers.filter((h) => !Object.values(cols).includes(h)),
    warnings: [],
  };
  if (!cols.phone) summary.warnings.push("No phone column found. Nothing can be texted from this file.");
  if (!cols.name && !cols.firstName) summary.warnings.push("No name column found. Texts will open with 'Hi there'.");
  if (!cols.consent) summary.warnings.push("No consent column found. Leads need consent marked before they can be texted.");

  const stamp = now.toISOString();
  for (const rec of records) {
    const row = rowToLead(rec, cols);
    if (!row.name && !row.rawPhone && !row.email) continue;
    if (!row.phone) summary.badPhone++;

    const existing = Object.values(store.leads).find(
      (l) => l.phone && l.phone === row.phone && nameKey(l.name) === nameKey(row.name)
    ) || (!row.phone && Object.values(store.leads).find(
      (l) => !l.phone && nameKey(l.name) === nameKey(row.name) && (l.email || "") === (row.email || "")
    ));

    const { consentCell, ...fields } = row;
    if (existing) {
      // Newer export wins on facts, but a blank cell never erases what we had.
      for (const [k, v] of Object.entries(fields)) {
        if (v !== "" && v !== null && v !== undefined) existing[k] = v;
      }
      if (consentCell === true && existing.consent !== true) {
        existing.consent = true;
        existing.consentSource = `export: ${sourceFile}`;
        existing.consentAt = stamp;
      } else if (consentCell === false && existing.consent !== false) {
        existing.consent = false;
        existing.consentSource = `export said no: ${sourceFile}`;
        existing.consentAt = stamp;
      }
      existing.updatedAt = stamp;
      summary.updated++;
    } else {
      const lead = {
        id: randomUUID(),
        ...fields,
        consent: consentCell === true,
        consentSource: consentCell === true ? `export: ${sourceFile}` : null,
        consentAt: consentCell === true ? stamp : null,
        createdAt: stamp,
        updatedAt: stamp,
      };
      store.leads[lead.id] = lead;
      summary.added++;
    }
  }

  // Flag shared numbers after the merge so earlier leads are flagged too.
  const counts = {};
  for (const l of Object.values(store.leads)) if (l.phone) counts[l.phone] = (counts[l.phone] || 0) + 1;
  for (const l of Object.values(store.leads)) {
    l.sharedPhone = Boolean(l.phone && counts[l.phone] > 1);
  }
  summary.sharedPhone = Object.values(store.leads).filter((l) => l.sharedPhone).length;
  summary.consentYes = Object.values(store.leads).filter((l) => l.consent === true).length;
  return summary;
}
