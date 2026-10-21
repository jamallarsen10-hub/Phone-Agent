import { markSent, skipDraft } from "./send.js";
import { clearHandoffs } from "./inbound.js";
import { leadsByPhone } from "./store.js";
import { toE164, prettyPhone } from "./phone.js";
import { handleInbound } from "./inbound.js";
import { queueChange, changesForSent } from "./notion.js";
import { TOUCH_OF } from "./templates.js";
import { localDate } from "./dates.js";

/**
 * Every one-tap action in the Command Center, shared by the CLI and the
 * local server so both behave the same. Each returns { ok, label } where
 * label is the short line shown after the tap, or { ok:false, reason }.
 *
 * Lead outcomes (sold, lost, showed, no-show) are kept in fields the CDK
 * import never touches, so a stale export can't undo a tap.
 */
/**
 * What a sent text changes on the lead: Last Contact, the touch, and the
 * write-back queued for Notion. Shared by the Sent tap and the automatic path,
 * so a text sent automatically is recorded exactly like one you sent by hand.
 */
export function recordSentEffects(store, m, { now, config }) {
  const lead = m.leadId && store.leads[m.leadId];
  if (!lead) return;
  const today = localDate(now, config.timeZone);
  const change = changesForSent(lead, m.template, TOUCH_OF[m.template], { today, config });
  lead.lastContact = today;
  if (!queueChange(store, lead, change, { now }) && change.followUp) lead.followUpDate = change.followUp;
}

export const ACTIONS = {
  sent: ({ id }, store, { now, config }) => {
    const r = markSent(store, id, { now });
    if (!r.ok) return r;
    const m = r.message;
    recordSentEffects(store, m, { now, config });
    return { ok: true, label: `Logged text to ${who(store, m)}` };
  },

  skip: ({ id, why = "" }, store, { now }) => {
    const r = skipDraft(store, id, { now, why });
    return r.ok ? { ok: true, label: `Skipped text to ${who(store, r.message)}` } : r;
  },

  handled: ({ phone }, store, { now }) => {
    const p = mustPhone(phone);
    const n = clearHandoffs(store, p, { now });
    return n ? { ok: true, label: `Cleared reply from ${prettyPhone(p)}` } : { ok: false, reason: "NOTHING_OPEN" };
  },

  optout: ({ phone, why = "" }, store, { now, config }) => {
    const p = mustPhone(phone);
    const day = localDate(now, config.timeZone);
    for (const l of leadsByPhone(store, p)) queueChange(store, l, { appendNote: `Texts: do not text (${day}).` }, { now });
    if (!store.optOuts[p]) store.optOuts[p] = { at: now.toISOString(), via: "manual", text: why };
    for (const m of store.outbound) {
      if (m.phone === p && m.status === "draft") {
        m.status = "expired";
        m.expiredAt = now.toISOString();
      }
    }
    clearHandoffs(store, p, { now });
    return { ok: true, label: `${prettyPhone(p)} will never be texted again` };
  },

  consent: ({ phone, source }, store, { now, config }) => {
    const p = mustPhone(phone);
    const src = String(source || "").trim();
    if (!src) return { ok: false, reason: "NEED_SOURCE", detail: "say how they agreed" };
    if (store.optOuts[p]) return { ok: false, reason: "OPTED_OUT", detail: "they sent STOP; only they can opt back in" };
    const leads = leadsByPhone(store, p);
    if (!leads.length) return { ok: false, reason: "NO_LEAD" };
    const day = localDate(now, config.timeZone);
    for (const l of leads) {
      l.consent = true;
      l.consentSource = src;
      l.consentAt = now.toISOString();
      l.consentTap = { source: src, at: now.toISOString() };
      queueChange(store, l, { appendNote: `OK to text follow-ups: ${src.slice(0, 80)} (${day})` }, { now });
    }
    return { ok: true, label: `OK to text ${names(leads)}` };
  },

  sold: (args, store, ctx) => outcome(args, store, ctx, "Sold"),
  lost: (args, store, ctx) => outcome(args, store, ctx, "Lost"),

  reopen: ({ leadId }, store, { now }) => {
    const l = store.leads[leadId];
    if (!l) return { ok: false, reason: "NO_LEAD" };
    const back = l.closed && l.closed.prevStage;
    delete l.closed;
    if (back) {
      l.stage = back;
      queueChange(store, l, { stage: back }, { now });
    }
    return { ok: true, label: `${l.name || "Lead"} is back in follow-ups` };
  },

  showed: ({ leadId }, store, { now }) => {
    const l = store.leads[leadId];
    if (!l) return { ok: false, reason: "NO_LEAD" };
    l.showed = true;
    l.showedMarkedAt = now.toISOString();
    queueChange(store, l, { stage: "Showed" }, { now });
    return { ok: true, label: `${l.name || "Lead"} showed` };
  },

  // A no-show queues the "sorry we missed you, pick a new time" text.
  noshow: ({ leadId }, store, { now }) => {
    const l = store.leads[leadId];
    if (!l) return { ok: false, reason: "NO_LEAD" };
    if (!l.appointmentDate) return { ok: false, reason: "NO_APPOINTMENT" };
    l.showed = false;
    l.showedMarkedAt = now.toISOString();
    queueChange(store, l, { stage: "No Show" }, { now });
    return { ok: true, label: `${l.name || "Lead"} no-show; reschedule text queued` };
  },
};

// Log a text a customer sent (from the Command Center's reply box).
ACTIONS.reply = ({ phone, text }, store, { now, config }) => {
  const body = String(text || "").trim();
  if (!body) return { ok: false, reason: "EMPTY", detail: "type what they said" };
  const r = handleInbound(store, { from: mustPhone(phone), body }, { now, config });
  if (r.duplicate) return { ok: false, reason: "ALREADY_LOGGED" };
  const c = r.classification;
  const who = r.leads.map((l) => l.name).filter(Boolean).join(" / ") || prettyPhone(r.phone);
  if (c.type === "OPT_OUT") return { ok: true, label: `${who} opted out; send the confirmation once` };
  if (r.confirmed) return { ok: true, label: `${who} confirmed` };
  if (c.type === "HELP") return { ok: true, label: `HELP reply ready for ${who}` };
  return { ok: true, label: `${who}: ${c.priority === "hot" ? "buying signal" : c.priority === "urgent" ? "read first" : "reply"} logged` };
};

export function runAction(name, args, store, ctx) {
  const fn = ACTIONS[name];
  if (!fn) return { ok: false, reason: "UNKNOWN_ACTION" };
  try {
    return fn(args || {}, store, ctx);
  } catch (e) {
    return { ok: false, reason: "BAD_INPUT", detail: e.message };
  }
}

function outcome({ leadId }, store, { now }, stage) {
  const l = store.leads[leadId];
  if (!l) return { ok: false, reason: "NO_LEAD" };
  const prevStage = l.stage;
  if (stage === "Sold") l.soldAt = now.toISOString();
  queueChange(store, l, { stage }, { now });
  l.stage = stage;
  l.closed = { stage, at: now.toISOString(), prevStage };
  for (const m of store.outbound) {
    if (m.leadId === l.id && m.status === "draft") {
      m.status = "expired";
      m.expiredAt = now.toISOString();
    }
  }
  return { ok: true, label: `${l.name || "Lead"} marked ${stage.toLowerCase()}` };
}

function mustPhone(raw) {
  const p = toE164(raw);
  if (!p) throw new Error(`not a valid US phone: ${raw}`);
  return p;
}

const names = (leads) => leads.map((l) => l.name || "unnamed").join(" / ");

function who(store, m) {
  const l = m.leadId && store.leads[m.leadId];
  return (l && l.name) || prettyPhone(m.phone);
}
