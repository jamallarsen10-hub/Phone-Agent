import { markSent, skipDraft } from "./send.js";
import { clearHandoffs } from "./inbound.js";
import { leadsByPhone } from "./store.js";
import { toE164, prettyPhone } from "./phone.js";

/**
 * Every one-tap action in the Command Center, shared by the CLI and the
 * local server so both behave the same. Each returns { ok, label } where
 * label is the short line shown after the tap, or { ok:false, reason }.
 *
 * Lead outcomes (sold, lost, showed, no-show) are kept in fields the CDK
 * import never touches, so a stale export can't undo a tap.
 */
export const ACTIONS = {
  sent: ({ id }, store, { now }) => {
    const r = markSent(store, id, { now });
    return r.ok ? { ok: true, label: `Logged text to ${who(store, r.message)}` } : r;
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

  optout: ({ phone, why = "" }, store, { now }) => {
    const p = mustPhone(phone);
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

  consent: ({ phone, source }, store, { now }) => {
    const p = mustPhone(phone);
    const src = String(source || "").trim();
    if (!src) return { ok: false, reason: "NEED_SOURCE", detail: "say how they agreed" };
    if (store.optOuts[p]) return { ok: false, reason: "OPTED_OUT", detail: "they sent STOP; only they can opt back in" };
    const leads = leadsByPhone(store, p);
    if (!leads.length) return { ok: false, reason: "NO_LEAD" };
    for (const l of leads) {
      l.consent = true;
      l.consentSource = src;
      l.consentAt = now.toISOString();
    }
    return { ok: true, label: `OK to text ${names(leads)}` };
  },

  sold: (args, store, ctx) => outcome(args, store, ctx, "Sold"),
  lost: (args, store, ctx) => outcome(args, store, ctx, "Lost"),

  reopen: ({ leadId }, store) => {
    const l = store.leads[leadId];
    if (!l) return { ok: false, reason: "NO_LEAD" };
    delete l.closed;
    return { ok: true, label: `${l.name || "Lead"} is back in follow-ups` };
  },

  showed: ({ leadId }, store, { now }) => {
    const l = store.leads[leadId];
    if (!l) return { ok: false, reason: "NO_LEAD" };
    l.showed = true;
    l.showedMarkedAt = now.toISOString();
    return { ok: true, label: `${l.name || "Lead"} showed` };
  },

  // A no-show queues the "sorry we missed you, pick a new time" text.
  noshow: ({ leadId }, store, { now }) => {
    const l = store.leads[leadId];
    if (!l) return { ok: false, reason: "NO_LEAD" };
    if (!l.appointmentDate) return { ok: false, reason: "NO_APPOINTMENT" };
    l.showed = false;
    l.showedMarkedAt = now.toISOString();
    return { ok: true, label: `${l.name || "Lead"} no-show; reschedule text queued` };
  },
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
  l.closed = { stage, at: now.toISOString() };
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
