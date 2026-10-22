import { randomUUID } from "node:crypto";
import { toE164, prettyPhone } from "./phone.js";
import { handleInbound } from "./inbound.js";
import { isOptOut } from "./keywords.js";
import { leadsByPhone } from "./store.js";
import { canSend, lastReplyWithin, withinSendWindow } from "./guardrails.js";
import { render } from "./templates.js";
import { sendDraft } from "./send.js";
import { queueChange } from "./notion.js";
import { localDate, daysBetween } from "./dates.js";

/**
 * The receptionist (Jamal's option A, Oct 21 2026). Jamal is the closer; this
 * only handles the front desk:
 *   - "YES" to a booked visit        -> "Perfect, see you then"
 *   - wants another time / to come in -> booking link
 *   - "where are you?"               -> dealership address
 *   - price, payment, trade, credit, deal, availability, "call me"
 *                                    -> "I'll call you shortly" + HOT alert to Jamal
 *   - STOP / HELP                    -> the carrier-required answers (as before)
 *   - anything else                  -> no answer, alert to Jamal
 *
 * Hard limits:
 *   - Only numbers of OPEN leads. Family, friends, anyone not a lead: ignored
 *     and never stored. A closed lead (Sold/Lost) is ignored too, except STOP.
 *   - Jamal's own number (alertPhone) is never treated as a customer.
 *   - Only inside send hours; at most one automatic answer per number per
 *     replyCooldownMinutes; every answer still goes through canSend + price block.
 *   - Every reply also opens a handoff (as before), so scheduled follow-ups
 *     wait until Jamal marks it handled.
 */

export const RESCHEDULE =
  /\b(?:re-?schedule|different\s+(?:time|day)|another\s+(?:time|day)|other\s+time|change\s+(?:the|my|our)?\s*(?:time|appointment|day)|can'?t\s+make\s+it|cannot\s+make\s+it|won'?t\s+(?:make|be\s+able)|push\s+(?:it|back)|move\s+(?:it|my|the)|later\s+time|earlier\s+time|running\s+late)\b/i;
export const ADDRESS = /\b(?:address|where\s+(?:are|r)\s+(?:you|u|y'all)|where\s+is\s+(?:the|your)\s+(?:dealership|store|lot)|location|directions|how\s+do\s+i\s+get\s+there)\b/i;

const NOT_BOOKING_HOT = new Set(["wants to come in"]);

/**
 * Decide what to do with one logged reply. Pure apart from reading the store.
 * @returns {{ template: string|null, alert: "hot"|"normal"|null, action: string }}
 */
export function planReply(store, result, text, { now, config }) {
  const c = result.classification;
  const today = localDate(now, config.timeZone);
  const open = (result.leads || []).filter((l) => !l.closed);
  const hasUpcoming = open.some((l) => l.appointmentDate && daysBetween(l.appointmentDate, today) <= 0);

  if (c.type === "OPT_OUT") return { template: "opt-out-confirm", alert: "normal", action: "opted out (STOP)" };
  if (c.type === "HELP") return { template: "help", alert: null, action: "sent HELP answer" };
  if (result.confirmed) return guard(store, result.phone, "reply-confirm", null, "confirmed the visit", { now, config });
  if (c.type === "WRONG_NUMBER" || c.type === "OPT_IN_REQUEST" || c.possibleOptOut)
    return { template: null, alert: "normal", action: c.reasons[0] || "read this one" };

  const hot = (c.reasons || []).filter((r) => c.priority === "hot" && !NOT_BOOKING_HOT.has(r));
  if (hot.length) return guard(store, result.phone, "reply-hot", "hot", `buying signal: ${hot.join(", ")}`, { now, config });
  if (RESCHEDULE.test(text) || (!hasUpcoming && (c.reasons || []).includes("wants to come in")))
    return guard(store, result.phone, "reply-book", "normal", "wants a (new) time", { now, config });
  if (ADDRESS.test(text) && config.dealerAddress)
    return guard(store, result.phone, "reply-address", "normal", "asked where we are", { now, config });
  return { template: null, alert: "normal", action: "replied; needs you" };
}

// Downgrade an answer to "alert only" when it can't go out now.
function guard(store, phone, template, alert, action, { now, config }) {
  if (!withinSendWindow(now, config)) return { template: null, alert: alert || "normal", action: `${action} (after hours, no auto-answer)` };
  if (lastReplyWithin(store, phone, now, config, { pending: true }))
    return { template: null, alert: alert || "normal", action: `${action} (already answered recently)` };
  return { template, alert, action };
}

/** A receptionist draft, same shape as every other outbound text. */
export function makeReplyDraft(store, { phone, lead, template, why }, { now, config }) {
  const check = canSend(store, { lead, phone, template }, { now, config, checkHours: true });
  if (!check.ok) return { skipped: check.reason, detail: check.detail };
  const body = render(template, {
    senderName: config.senderName,
    dealership: config.dealership,
    bookingUrl: config.bookingUrl,
    dealerAddress: config.dealerAddress,
  });
  const msg = {
    id: randomUUID().slice(0, 6),
    key: `${phone}:${template}:${now.toISOString()}`,
    leadId: lead ? lead.id : null,
    phone,
    template,
    why,
    body,
    status: "draft",
    createdAt: now.toISOString(),
  };
  store.outbound.push(msg);
  return msg;
}

export function alertText({ leads, phone, text, plan, sentBody }) {
  const l = leads[0] || {};
  const who = [l.name || "A lead", l.vehicle ? `(${l.vehicle})` : ""].filter(Boolean).join(" ");
  const icon = plan.alert === "hot" ? "HOT" : "Reply";
  const quoted = text.length > 140 ? text.slice(0, 137) + "..." : text;
  const lines = [`${icon}: ${who} texted: "${quoted}"`, `-> ${plan.action}`];
  if (sentBody) lines.push(`Auto-answered: "${sentBody}"`);
  lines.push(`Call/text: ${prettyPhone(phone)}`);
  return lines.join("\n");
}

/**
 * One pass over new Messages. `read(cursor)` and `readMax()` come from
 * src/messagesDb.js (injectable for tests). `provider` sends texts and alerts;
 * a dry-run provider prints them. `persist` saves the store.
 */
export async function checkReplies(store, { now, config, provider, persist = () => {}, read, readMax, log = () => {} }) {
  const report = { initialized: false, seen: 0, handled: [], sent: [], alerts: [], held: [], failed: [], stop: false };
  if (!Number.isInteger(store.replyCursor)) {
    // First run: start from now. Old conversations are never answered.
    store.replyCursor = await readMax();
    report.initialized = true;
    persist();
    return report;
  }
  const rows = await read(store.replyCursor);
  const alertTo = config.alertPhone ? toE164(config.alertPhone) : null;

  for (const msg of rows) {
    report.seen++;
    store.replyCursor = Math.max(store.replyCursor, msg.rowid);
    const phone = toE164(msg.handle);
    if (!phone || phone === alertTo || !msg.text) continue;
    const leads = leadsByPhone(store, phone);
    if (!leads.length) continue; // not a lead: ignore, store nothing
    const open = leads.filter((l) => !l.closed);
    if (!open.length && !isOptOut(msg.text)) continue; // closed lead: only STOP counts

    const r = handleInbound(store, { messageId: "imsg-" + msg.guid, from: phone, body: msg.text, receivedAt: msg.receivedAt }, { now, config });
    if (r.duplicate) continue;
    const plan = planReply(store, r, msg.text, { now, config });
    const entry = { phone, leadIds: leads.map((l) => l.id), text: msg.text, action: plan.action };
    report.handled.push(entry);

    // The answer: STOP/HELP drafts were made by handleInbound; the rest here.
    let draft = null;
    if (plan.template === "opt-out-confirm" || plan.template === "help") draft = r.replyDraft && r.replyDraft.id ? r.replyDraft : null;
    else if (plan.template) {
      const d = makeReplyDraft(store, { phone, lead: open[0], template: plan.template, why: `auto: ${plan.action}` }, { now, config });
      if (d.skipped) report.held.push({ phone, template: plan.template, reason: d.skipped });
      else draft = d;
    }
    let sentBody = null;
    if (draft && provider) {
      const guarded = { ...provider, send: async (m) => (persist(), provider.send(m)) };
      const s = await sendDraft(store, draft.id, { now, config, provider: guarded });
      if (s.ok && !s.dryRun) {
        sentBody = draft.body;
        report.sent.push({ id: draft.id, template: draft.template, to: phone, service: s.message.service });
      } else if (s.ok && s.dryRun) {
        sentBody = draft.body;
        report.sent.push({ id: draft.id, template: draft.template, to: phone, dryRun: true });
      } else if (s.reason === "PROVIDER_ERROR") {
        report.failed.push({ id: draft.id, to: phone, detail: s.detail });
        report.stop = true;
      } else report.held.push({ phone, template: draft.template, reason: s.reason, detail: s.detail });
    }
    entry.answered = sentBody;

    // Log it on the lead in Notion (STOP already writes its own note).
    if (plan.template !== "opt-out-confirm") {
      const day = localDate(now, config.timeZone);
      const snippet = msg.text.length > 60 ? msg.text.slice(0, 57) + "..." : msg.text;
      for (const l of open) queueChange(store, l, { appendNote: `Texts: replied "${snippet.replace(/[\r\n]+/g, " ")}" ${day}. ${plan.action}${sentBody ? " (auto-answered)" : ""}.` }, { now });
    }

    // Tell Jamal.
    if (plan.alert && alertTo && provider) {
      const body = alertText({ leads: open.length ? open : leads, phone, text: msg.text, plan, sentBody });
      const a = { id: randomUUID().slice(0, 8), to: alertTo, about: phone, kind: plan.alert, at: now.toISOString(), status: "sending" };
      store.alerts.push(a);
      persist();
      try {
        await provider.send({ to: alertTo, body, idempotencyKey: "alert-" + a.id });
        a.status = provider.dryRun ? "dry-run" : "sent";
        report.alerts.push({ to: alertTo, kind: plan.alert, body });
      } catch (e) {
        a.status = "failed";
        a.error = String(e && e.message).slice(0, 200);
        report.failed.push({ alert: a.id, detail: a.error });
        report.stop = true;
      }
    }
    persist();
    if (report.stop) break;
  }
  persist();
  return report;
}
