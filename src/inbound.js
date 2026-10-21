import { randomUUID, createHash } from "node:crypto";
import { toE164 } from "./phone.js";
import { classifyInbound } from "./keywords.js";
import { canSend } from "./guardrails.js";
import { render } from "./templates.js";
import { leadsByPhone } from "./store.js";
import { localDate, daysBetween } from "./dates.js";
import { queueChange } from "./notion.js";

/**
 * Record a text the customer sent. Order matters and follows the design:
 *   1. (provider mode) verify the webhook signature before this is called
 *   2. dedup by message id, so a retried webhook is processed once
 *   3. STOP first: the opt-out is saved before anything else can happen
 *   4. everything else becomes a handoff to Jamal; no AI writes a reply
 *
 * The only automatic replies are the two carriers require: the one-time
 * opt-out confirmation and the HELP answer. In drafts mode those are drafts too.
 *
 * @returns {{ duplicate?: true, phone, classification, handoff?, replyDraft? }}
 */
export function handleInbound(store, { messageId, from, body, receivedAt }, { now, config }) {
  const phone = toE164(from);
  if (!phone) throw new Error(`can't read that phone number: ${from}`);
  const at = (receivedAt ? new Date(receivedAt) : now).toISOString();
  // Manual entries get a stable id from their content, so logging the same
  // reply twice by accident is still one message.
  const id = messageId || "manual-" + createHash("sha1").update(`${phone}|${body}|${at.slice(0, 16)}`).digest("hex").slice(0, 16);
  if (store.inbound[id]) return { duplicate: true, phone, classification: store.inbound[id] };

  const c = classifyInbound(body);
  const leads = leadsByPhone(store, phone);
  store.inbound[id] = { phone, body: String(body), receivedAt: at, ...c };

  const result = { phone, classification: c, leads };
  const vars = { senderName: config.senderName, dealership: config.dealership };

  if (c.type === "OPT_OUT") {
    // A repeat STOP keeps the original record, so it gets no second confirmation.
    if (!store.optOuts[phone]) {
      store.optOuts[phone] = { at, via: "inbound", text: String(body).slice(0, 160), messageId: id };
    }
    // Any unsent draft to this number dies now, not at the next rebuild.
    for (const m of store.outbound) {
      if (m.phone === phone && m.status === "draft") {
        m.status = "expired";
        m.expiredAt = now.toISOString();
      }
    }
    result.replyDraft = addReply(store, phone, leads, "opt-out-confirm", vars, { now, config });
    // Record it in Notion too, where the booking page and Jamal will see it.
    const day = localDate(now, config.timeZone);
    for (const l of leads) queueChange(store, l, { appendNote: `Texts: replied STOP ${day}. Do not text.` }, { now });
    return result;
  }

  // "YES" to an upcoming appointment just confirms it. Nothing to answer.
  if (c.type === "CONFIRM") {
    const today = localDate(now, config.timeZone);
    const booked = leads.filter((l) => l.appointmentDate && daysBetween(l.appointmentDate, today) <= 0);
    if (booked.length) {
      for (const l of booked) l.confirmedAt = at;
      result.confirmed = booked;
      return result;
    }
  }

  if (c.type === "HELP") {
    result.replyDraft = addReply(store, phone, leads, "help", vars, { now, config });
    return result;
  }

  // Everything else waits for Jamal, and holds automated texts until he clears it.
  const handoff = {
    id: randomUUID().slice(0, 8),
    phone,
    leadIds: leads.map((l) => l.id),
    messageId: id,
    type: c.type,
    priority: c.priority,
    reasons: c.reasons,
    possibleOptOut: Boolean(c.possibleOptOut),
    body: String(body),
    at,
    clearedAt: null,
  };
  store.handoffs.push(handoff);
  result.handoff = handoff;
  return result;
}

function addReply(store, phone, leads, template, vars, { now, config }) {
  const check = canSend(store, { phone, template }, { now, config, checkHours: false });
  if (!check.ok) return { skipped: check.reason };
  const body = render(template, vars);
  const msg = {
    id: randomUUID().slice(0, 6),
    key: `${phone}:${template}:${now.toISOString()}`,
    leadId: leads[0]?.id || null,
    phone,
    template,
    why: template === "help" ? "they texted HELP" : "they texted STOP",
    body,
    status: "draft",
    createdAt: now.toISOString(),
  };
  store.outbound.push(msg);
  return msg;
}

/** Jamal answered them. Automated follow-ups may resume for this number. */
export function clearHandoffs(store, phone, { now }) {
  let n = 0;
  for (const h of store.handoffs) {
    if (h.phone === phone && !h.clearedAt) {
      h.clearedAt = now.toISOString();
      n++;
    }
  }
  return n;
}
