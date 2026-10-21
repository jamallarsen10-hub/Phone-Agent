import { randomUUID } from "node:crypto";
import { loadStore, saveStore } from "./store.js";
import { toE164 } from "./phone.js";
import { localDate, localParts, addDays } from "./dates.js";

/**
 * Two-way link with the Notion Lead Pipeline.
 *
 * Pull: every page becomes a lead (id "n_<page id>"). Notion stays the source
 * of truth for name, phone, stage, appointment, Follow-Up, Last Contact and
 * Touches Sent. Local-only facts (a consent tap, a "YES" confirmation, when a
 * sale was first seen) survive each pull.
 *
 * Push: taps queue small, idempotent updates (add a touch, set Last Contact,
 * set Stage, move Follow-Up, append one line to Notes). A queued change waits
 * GRACE_MS before it is sent, longer than the Undo window, so an undone tap
 * never reaches Notion. Network calls happen before the store is re-read and
 * saved, so a slow request can never overwrite a tap made in the meantime.
 *
 * Needs its own Notion integration with Read + Update content, shared with
 * the Lead Pipeline database (the booking page's key only has Insert).
 */
const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";
export const GRACE_MS = 75 * 1000;

export function notionClient({ token, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!token) throw new Error("No Notion token. Add notionToken to data/config.json or set NOTION_TOKEN.");
  async function call(method, path, body) {
    for (let attempt = 0; attempt < 4; attempt++) {
      let res;
      try {
        res = await fetchImpl(API + path, {
          method,
          headers: { authorization: `Bearer ${token}`, "notion-version": VERSION, "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        if (attempt === 3) throw new Error(`Can't reach Notion (${e.message})`);
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        const wait = Number(res.headers?.get?.("retry-after")) * 1000 || 500 * 2 ** attempt;
        if (attempt === 3) throw Object.assign(new Error(`Notion is busy (${res.status})`), { status: res.status });
        await sleep(Math.min(wait, 8000));
        continue;
      }
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        const hint =
          res.status === 401 ? "the Notion token is wrong"
          : res.status === 404 ? "the database isn't shared with your Phone Agent integration"
          : res.status === 403 ? "the integration needs Read and Update content"
          : out.message || out.code || "request rejected";
        throw Object.assign(new Error(`Notion ${res.status}: ${hint}`), { status: res.status, code: out.code });
      }
      return out;
    }
  }
  return {
    async queryAll(databaseId) {
      const pages = [];
      let cursor;
      do {
        const out = await call("POST", `/databases/${databaseId}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
        pages.push(...(out.results || []));
        cursor = out.has_more ? out.next_cursor : null;
      } while (cursor);
      return pages;
    },
    getPage: (id) => call("GET", `/pages/${id}`),
    updatePage: (id, properties) => call("PATCH", `/pages/${id}`, { properties }),
  };
}

// ---------- reading pages ----------

const textOf = (p) => {
  if (!p) return "";
  if (p.type === "title") return p.title.map((t) => t.plain_text).join("");
  if (p.type === "rich_text") return p.rich_text.map((t) => t.plain_text).join("");
  return "";
};
const selectOf = (p) => (p && p.select ? p.select.name : "");
const multiOf = (p) => (p && p.multi_select ? p.multi_select.map((o) => o.name) : []);
const dateStartOf = (p) => (p && p.date ? p.date.start : null);

const VISIT_LINE = /Booked on website: OK to text about this visit/;
const FOLLOWUP_LINE = /OK to text follow-ups/;
const DO_NOT_TEXT = /\bdo not text\b/i;
const VAGUE_VEHICLE = new Set(["Not sure yet", "Other / not a Toyota"]);

function dayOf(start, timeZone) {
  if (!start) return null;
  return start.includes("T") ? localDate(new Date(start), timeZone) : start.slice(0, 10);
}

/** A Notion page as the fields Phone Agent uses. Pure. */
export function mapPage(page, timeZone) {
  const p = page.properties || {};
  const notes = textOf(p.Notes);
  const requested = dateStartOf(p.Requested);
  const timed = Boolean(requested && requested.includes("T"));
  const at = timed ? new Date(requested) : null;
  const vehicle = selectOf(p.Vehicle);
  const source = selectOf(p.Source);
  return {
    notionId: page.id,
    notionUrl: page.url,
    name: textOf(p.Name).trim(),
    phone: toE164(p.Phone && p.Phone.phone_number),
    rawPhone: (p.Phone && p.Phone.phone_number) || "",
    email: (p.Email && p.Email.email) || "",
    vehicle: VAGUE_VEHICLE.has(vehicle) ? "" : vehicle,
    stage: selectOf(p.Stage),
    source,
    appointmentAt: at ? at.toISOString() : null,
    appointmentDate: requested ? dayOf(requested, timeZone) : null,
    appointmentTime: at ? localParts(at, timeZone).time : null,
    followUpDate: dayOf(dateStartOf(p["Follow-Up"]), timeZone),
    lastContact: dayOf(dateStartOf(p["Last Contact"]), timeZone),
    touches: multiOf(p["Touches Sent"]),
    receivedAt: page.created_time || null,
    // Permission recorded in Notes by the booking page or by a tap here.
    visitConsent: VISIT_LINE.test(notes) || (source === "Instagram" && Boolean(requested)),
    notesConsent: FOLLOWUP_LINE.test(notes),
    notesOptOut: DO_NOT_TEXT.test(notes),
    notes,
  };
}

/** Apply queued, not-yet-sent changes so the screen shows taps right away. */
function overlay(lead, queue) {
  for (const q of queue) {
    if (q.pageId !== lead.notionId || q.failed) continue;
    const s = q.set || {};
    if (s.stage) lead.stage = s.stage;
    if (s.lastContact) lead.lastContact = s.lastContact;
    if (s.followUp) lead.followUpDate = s.followUp;
    if (s.addTouches) lead.touches = [...new Set([...(lead.touches || []), ...s.addTouches])];
    if (q.appendNote && FOLLOWUP_LINE.test(q.appendNote)) lead.notesConsent = true;
  }
}

function derive(lead) {
  const st = lead.stage || "";
  lead.consent = Boolean(lead.notesConsent || lead.consentTap);
  lead.consentSource = lead.consentTap ? lead.consentTap.source : lead.notesConsent ? "Notion notes" : lead.visitConsent ? "booking page (visit texts only)" : null;
  lead.showed = st === "Showed" ? true : st === "No Show" ? false : null;
  lead.closed = ["Lost", "Declined"].includes(st) ? { stage: st } : st === "Sold" ? { stage: "Sold" } : undefined;
}

/** Merge pulled pages into the store. Pure apart from the store. */
export function mergePages(store, pages, { now, config }) {
  const seen = new Set();
  const stamp = now.toISOString();
  for (const page of pages) {
    if (page.archived || page.in_trash) continue;
    const id = "n_" + page.id.replace(/-/g, "");
    seen.add(id);
    const fields = mapPage(page, config.timeZone);
    const prev = store.leads[id];
    const prevStage = prev ? prev.stage : null;
    const lead = prev ? Object.assign(prev, fields) : { id, ...fields, createdAt: stamp };
    // Only a sale we watch happen gets a date; old sales aren't guessed at.
    if (prev && prevStage !== "Sold" && fields.stage === "Sold" && !lead.soldAt) lead.soldAt = stamp;
    lead.updatedAt = stamp;
    delete lead.notionGone;
    store.leads[id] = lead;
    overlay(lead, store.notionQueue || []);
    derive(lead);
    if (fields.notesOptOut && lead.phone && !store.optOuts[lead.phone])
      store.optOuts[lead.phone] = { at: stamp, via: "notion", text: "Notes say do not text" };
  }
  for (const l of Object.values(store.leads)) {
    if (l.notionId && !seen.has(l.id)) l.notionGone = true;
  }
  const counts = {};
  for (const l of Object.values(store.leads)) if (l.phone && !l.notionGone) counts[l.phone] = (counts[l.phone] || 0) + 1;
  for (const l of Object.values(store.leads)) l.sharedPhone = Boolean(l.phone && counts[l.phone] > 1);
  return { count: seen.size };
}

// ---------- queueing changes ----------

/**
 * Queue a change for a Notion lead and show it locally at once.
 * change: { stage, lastContact, followUp, addTouches: [], appendNote }
 */
export function queueChange(store, lead, change, { now }) {
  if (!lead || !lead.notionId) return null;
  store.notionQueue = store.notionQueue || [];
  const { appendNote, ...set } = change;
  const item = { id: randomUUID().slice(0, 8), pageId: lead.notionId, set, appendNote: appendNote || null, createdAt: now.toISOString(), attempts: 0 };
  store.notionQueue.push(item);
  overlay(lead, [item]);
  derive(lead);
  return item;
}

/** What a sent text changes in Notion. */
export function changesForSent(lead, template, touch, { today, config }) {
  const change = { lastContact: today };
  if (touch) change.addTouches = [touch];
  if (template === "booking-confirm" && lead.stage === "New Request") change.stage = "Accepted";
  if (template === "lead-followup") change.followUp = addDays(today, config.followupGapDays);
  return change;
}

function noteSegments(prop) {
  return ((prop && prop.rich_text) || []).map((t) =>
    t.type === "text"
      ? { type: "text", text: { content: t.text.content, link: t.text.link || null }, annotations: t.annotations }
      : { type: "text", text: { content: t.plain_text || "" } }
  );
}

/** Notion property payload for one queued item, merged with the live page. */
export function buildUpdate(item, page) {
  const props = {};
  const s = item.set || {};
  const live = (page && page.properties) || {};
  if (s.stage) props.Stage = { select: { name: s.stage } };
  if (s.lastContact) props["Last Contact"] = { date: { start: s.lastContact } };
  if (s.followUp) props["Follow-Up"] = { date: { start: s.followUp } };
  if (s.addTouches && s.addTouches.length) {
    const names = [...new Set([...multiOf(live["Touches Sent"]), ...s.addTouches])];
    props["Touches Sent"] = { multi_select: names.map((name) => ({ name })) };
  }
  if (item.appendNote) {
    const current = textOf(live.Notes);
    if (!current.includes(item.appendNote)) {
      const segs = noteSegments(live.Notes);
      const room = 2000 - current.length - 1;
      if (room > 20) segs.push({ type: "text", text: { content: (current ? "\n" : "") + item.appendNote.slice(0, room) } });
      props.Notes = { rich_text: segs };
    }
  }
  return props;
}

// ---------- running a sync ----------

/** Send queued changes older than the grace period. */
export async function flushQueue(dataDir, config, client, { now, graceMs = GRACE_MS }) {
  const pending = (loadStore(dataDir).notionQueue || []).filter(
    (q) => !q.failed && now.getTime() - Date.parse(q.createdAt) >= graceMs
  );
  const results = [];
  for (const q of pending) {
    try {
      const needsPage = (q.set.addTouches && q.set.addTouches.length) || q.appendNote;
      const page = needsPage ? await client.getPage(q.pageId) : null;
      const props = buildUpdate(q, page);
      if (Object.keys(props).length) await client.updatePage(q.pageId, props);
      results.push({ id: q.id, ok: true });
    } catch (e) {
      const permanent = e.status && e.status !== 429 && e.status < 500;
      results.push({ id: q.id, ok: false, error: e.message, permanent });
      if (e.status === 401 || e.status === 403) break; // config problem: stop, keep the rest queued
    }
  }
  if (!results.length) return results;
  const store = loadStore(dataDir); // re-read: taps may have happened while we waited on Notion
  for (const r of results) {
    const i = store.notionQueue.findIndex((q) => q.id === r.id);
    if (i < 0) continue;
    if (r.ok) store.notionQueue.splice(i, 1);
    else {
      const q = store.notionQueue[i];
      q.attempts += 1;
      q.lastError = r.error;
      if (r.permanent && q.attempts >= 3) q.failed = true;
    }
  }
  saveStore(dataDir, store);
  return results;
}

/** Pull the pipeline, then push due changes. Records the outcome for the page. */
export async function syncNotion(dataDir, config, client, { now, graceMs = GRACE_MS }) {
  let pages;
  try {
    pages = await client.queryAll(config.notionDatabaseId);
  } catch (e) {
    const store = loadStore(dataDir);
    store.notionSync = { ...(store.notionSync || {}), error: e.message, failedAt: now.toISOString() };
    saveStore(dataDir, store);
    return { ok: false, error: e.message };
  }
  const store = loadStore(dataDir);
  const { count } = mergePages(store, pages, { now, config });
  store.notionSync = { at: now.toISOString(), count, error: null };
  saveStore(dataDir, store);
  const pushed = await flushQueue(dataDir, config, client, { now, graceMs });
  return { ok: true, count, pushed: pushed.filter((r) => r.ok).length, pushErrors: pushed.filter((r) => !r.ok) };
}
