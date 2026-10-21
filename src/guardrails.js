import { isE164US } from "./phone.js";
import { localParts, localDate, daysBetween } from "./dates.js";
import { TEMPLATES } from "./templates.js";
import { isOptedOut, sentTo, openHandoffs } from "./store.js";

/**
 * The single send gate. Every text, drafted or automatic, passes through
 * canSend(). Nothing else in the codebase decides whether a number may be
 * texted. Pure apart from reading the store.
 *
 * Reasons, in the order they are checked:
 *   KILL_SWITCH      config.killSwitch or KILL_SWITCH=true
 *   BAD_PHONE        not a valid US mobile-format number
 *   OPTED_OUT        the number sent STOP (applies to every lead on that number)
 *   NO_CONSENT       this lead has no recorded permission to be texted
 *   AWAITING_JAMAL   the number replied and Jamal has not cleared it yet
 *   DAILY_LIMIT      already texted this number today
 *   TOO_SOON         routine follow-up inside the minimum gap
 *   ALREADY_DONE     the one-time reply for this event already exists
 *   OUTSIDE_HOURS    only checked at send time, not when drafting
 */
export function canSend(store, { lead, phone, template }, { now, config, checkHours = true }) {
  const t = TEMPLATES[template];
  if (!t) return no("UNKNOWN_TEMPLATE", template);
  const number = phone || (lead && lead.phone);

  if (config.killSwitch) return no("KILL_SWITCH", "kill switch is on");
  if (!isE164US(number)) return no("BAD_PHONE", String(number || "no phone"));

  const today = localDate(now, config.timeZone);
  const sent = sentTo(store, number);
  const sentToday = sent.filter((m) => localDate(new Date(m.sentAt), config.timeZone) === today);

  if (t.kind === "opt-out-confirm") {
    const out = store.optOuts[number];
    if (!out) return no("NOT_OPTED_OUT", "only sent after a STOP");
    const already = store.outbound.some(
      (m) => m.phone === number && m.template === template && m.status !== "skipped" && m.createdAt >= out.at
    );
    return already ? no("ALREADY_DONE", "confirmation already sent for this opt-out") : yes();
  }

  if (isOptedOut(store, number)) return no("OPTED_OUT", "this number replied STOP");

  if (t.kind === "response") {
    const repliedToday = store.outbound.some(
      (m) =>
        m.phone === number &&
        m.template === template &&
        m.status !== "skipped" &&
        localDate(new Date(m.createdAt), config.timeZone) === today
    );
    return repliedToday ? no("ALREADY_DONE", "already answered HELP today") : yes();
  }

  // Outreach and appointment texts from here on.
  // "visit" texts (confirm, reminders, no-show, day-after) are covered by the
  // booking page's notice; everything else needs full permission on file.
  const permitted = lead && (lead.consent === true || (t.scope === "visit" && lead.visitConsent === true));
  if (!permitted)
    return no("NO_CONSENT", lead && lead.visitConsent && t.scope !== "visit" ? "only OK'd texts about the visit" : "no permission to text on file");
  if (openHandoffs(store, number).length) return no("AWAITING_JAMAL", "they replied; Jamal answers first");
  const kindOf = (m) => TEMPLATES[m.template]?.kind || "outreach";
  const sameKindToday = sentToday.filter((m) => kindOf(m) === t.kind).length;
  const cap = t.kind === "appointment" ? config.appointmentMaxPerDay : config.maxPerPhonePerDay;
  if (sameKindToday >= cap) return no("DAILY_LIMIT", "already texted today");

  if (template === "lead-followup" && sent.length) {
    // Routine follow-ups wait out the gap after any text.
    const last = sent.map((m) => localDate(new Date(m.sentAt), config.timeZone)).sort().pop();
    if (daysBetween(last, today) < config.minDaysBetweenFollowups)
      return no("TOO_SOON", `last text ${last}`);
  }

  if (checkHours && !withinSendWindow(now, config))
    return no("OUTSIDE_HOURS", `texts go out ${config.sendStart}-${config.sendEnd} ${dayList(config.sendDays)}`);

  return yes();
}

export function withinSendWindow(now, config) {
  const { weekday, time } = localParts(now, config.timeZone);
  return config.sendDays.includes(weekday) && time >= config.sendStart && time < config.sendEnd;
}

function dayList(days) {
  const n = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return days.map((d) => n[d]).join("/");
}

const yes = () => ({ ok: true });
const no = (reason, detail) => ({ ok: false, reason, detail });
