import { createHash } from "node:crypto";
import { canSend } from "./guardrails.js";
import { render, smsSegments, TEMPLATES, TOUCH_OF } from "./templates.js";
import { localDate, localParts, daysBetween } from "./dates.js";
import { firstNameOf, isClosedStage, isNoShowStage } from "./leads.js";
import { DEFAULTS } from "./config.js";

/**
 * Most urgent first. One outreach text per number per day, so this order
 * decides who wins when a lead is due for several things.
 */
const PRIORITY = [
  "missed-appointment", "reminder-2h", "booking-confirm", "reminder-night",
  "after-test-drive", "nosale-1d", "new-lead", "cdk-intro", "nosale-3d", "cdk-bump",
  "nosale-7d", "cdk-last", "nosale-30d", "sold-review", "sold-6mo", "lead-followup",
];

const HOUR = 3600 * 1000;

export function shortId(key, taken = new Set()) {
  const h = createHash("sha1").update(key).digest("hex");
  for (let n = 6; n <= h.length; n++) {
    const id = h.slice(0, n);
    if (!taken.has(id)) return id;
  }
  return h;
}

function sentForLead(store, leadId, template, dueKey) {
  return store.outbound.some(
    (m) =>
      m.leadId === leadId &&
      m.status === "sent" &&
      (!template || m.template === template) &&
      (!dueKey || m.dueKey === dueKey)
  );
}

/** Touches already done: Notion's "Touches Sent" plus anything logged here. */
export function touchesOf(store, lead) {
  const done = new Set(lead.touches || []);
  for (const m of store.outbound) {
    if (m.leadId === lead.id && m.status === "sent" && TOUCH_OF[m.template]) done.add(TOUCH_OF[m.template]);
  }
  return done;
}

/** Most recent day this lead was texted, from Notion's Last Contact or the local log. */
export function lastTextDay(store, lead, timeZone) {
  const days = store.outbound
    .filter((m) => m.status === "sent" && (m.leadId === lead.id || (lead.phone && m.phone === lead.phone)))
    .map((m) => localDate(new Date(m.sentAt), timeZone));
  if (lead.lastContact) days.push(lead.lastContact);
  return days.sort().pop() || null;
}

const NOSALE_STEPS = [
  // [from day, until day (exclusive), touch]
  [1, 3, "nosale-1d"],
  [3, 7, "nosale-3d"],
  [7, 30, "nosale-7d"],
  [30, 46, "nosale-30d"],
];

/**
 * What this lead is due for today, if anything. Follows Jamal's own sequence
 * from Notion: confirm -> reminder-night -> reminder-2h for an appointment,
 * noshow-3h, nosale 1/3/7/30 days after a visit, sold-review and sold-6mo,
 * cdk-intro -> cdk-bump -> cdk-last, and the Follow-Up date for everything
 * else. Each touch goes once; nothing here invents a date the CRM did not set.
 *
 * @param ctx { now, config } — needed for time-of-day touches (2-hour
 *   reminder, 3 hours after a no-show). Without it, those fall back to dates.
 */
export function dueFor(store, lead, today, ctx = {}) {
  const now = ctx.now || null;
  const cfg = ctx.config || DEFAULTS;
  const d = (a) => (a ? daysBetween(a, today) : null); // days since; negative = future
  const done = touchesOf(store, lead);
  const has = (t) => done.has(t);
  const stage = lead.stage || "";

  // ---- Sold: review request, then the 6-month check-in ----
  const sold = /\bsold\b/i.test(stage) || lead.closed?.stage === "Sold";
  if (sold) {
    const soldOn = lead.soldAt ? localDate(new Date(lead.soldAt), cfg.timeZone) : null;
    if (!soldOn) return null; // sale date unknown: don't guess
    const since = d(soldOn);
    if (since >= 180 && since < 210 && !has("sold-6mo"))
      return { template: "sold-6mo", dueKey: soldOn, why: "about 6 months since the sale" };
    if (since >= 1 && since < 14 && !has("sold-review"))
      return { template: "sold-review", dueKey: soldOn, why: `sold ${soldOn}` };
    return null;
  }
  if (lead.closed || isClosedStage(stage)) return null;

  // ---- Appointment ----
  const appt = lead.appointmentDate;
  const apptMs = lead.appointmentAt ? Date.parse(lead.appointmentAt) : null;
  const timed = Boolean(apptMs && now);
  const since = d(appt);
  const noShow = appt && (lead.showed === false || isNoShowStage(stage));
  const showed = appt && !noShow && (lead.showed === true || /\bshowed\b/i.test(stage));
  const apptLabel = appt ? `${appt}${lead.appointmentTime ? " " + lead.appointmentTime : ""}` : "";

  if (noShow) {
    const ready = timed ? now.getTime() >= apptMs + 3 * HOUR : since >= 0;
    if (ready && since <= 2 && !has("noshow-3h") && !sentForLead(store, lead.id, "missed-appointment", appt))
      return { template: "missed-appointment", dueKey: appt, why: `missed appointment ${appt}` };
  }

  if (lead.testDriveDate && d(lead.testDriveDate) >= 0 && d(lead.testDriveDate) <= 1 &&
      !sentForLead(store, lead.id, "after-test-drive", lead.testDriveDate)) {
    return { template: "after-test-drive", dueKey: lead.testDriveDate, why: `test drive ${lead.testDriveDate}` };
  }

  if (showed && since >= 1) {
    const step = NOSALE_STEPS.find(([from, until]) => since >= from && since < until);
    if (step && !has(step[2]))
      return { template: step[2], dueKey: appt, why: `visited ${appt}, no sale yet` };
  }

  if (appt && !noShow && !showed && since <= 0) {
    const upcoming = !timed || now.getTime() < apptMs;
    if (!upcoming) return null; // it's happening or just happened: mark Showed / No-show
    // A reminder right after today's confirm is noise; the confirm already said when.
    const textedToday = lastTextDay(store, lead, cfg.timeZone) === today;
    if (!has("confirm"))
      return { template: "booking-confirm", dueKey: apptLabel, why: since === 0 ? "appointment today" : `appointment ${apptLabel}` };
    if (since === -1 && !has("reminder-night") && !textedToday)
      return { template: "reminder-night", dueKey: apptLabel, why: "appointment tomorrow" };
    if (since === 0 && timed && now.getTime() >= apptMs - 3 * HOUR && !has("reminder-2h") && !textedToday)
      return { template: "reminder-2h", dueKey: apptLabel, why: "appointment in a few hours" };
    return null; // booked and covered: leave them alone
  }

  // ---- New lead from a CRM export ----
  if (lead.receivedDate && d(lead.receivedDate) >= 0 && d(lead.receivedDate) <= 1 && !sentForLead(store, lead.id)) {
    return { template: "new-lead", dueKey: lead.receivedDate, why: `new lead ${lead.receivedDate}` };
  }

  // ---- CDK sequence ----
  if (/\bcdk\b/i.test(stage)) {
    const last = lastTextDay(store, lead, cfg.timeZone);
    const gap = last ? daysBetween(last, today) : Infinity;
    if (!has("cdk-intro")) return { template: "cdk-intro", dueKey: "cdk", why: "CDK lead, no intro yet" };
    if (!has("cdk-bump")) {
      return gap >= cfg.cdkBumpAfterDays ? { template: "cdk-bump", dueKey: "cdk", why: `intro sent ${last}` } : null;
    }
    if (!has("cdk-last")) {
      return gap >= cfg.cdkLastAfterDays ? { template: "cdk-last", dueKey: "cdk", why: `bump sent ${last}` } : null;
    }
    // Sequence done: the Follow-Up date takes over below.
  }

  // ---- Follow-Up date ----
  // A Last Contact on or after the Follow-Up date means that touch happened.
  const touchedSince = lead.lastContact && lead.lastContact >= lead.followUpDate;
  if (lead.followUpDate && d(lead.followUpDate) >= 0 && !touchedSince &&
      !sentForLead(store, lead.id, "lead-followup", lead.followUpDate)) {
    const late = d(lead.followUpDate);
    return {
      template: "lead-followup",
      dueKey: lead.followUpDate,
      why: late === 0 ? "follow-up due today" : `follow-up ${late} day${late === 1 ? "" : "s"} overdue`,
      overdue: late,
    };
  }
  return null;
}

/** "Thu, Oct 23 at 3:00 PM", or just the day when no time is known. */
export function whenLabel(lead, config) {
  if (lead.appointmentAt) {
    const at = new Date(lead.appointmentAt);
    const day = new Intl.DateTimeFormat("en-US", { timeZone: config.timeZone, weekday: "short", month: "short", day: "numeric" }).format(at);
    return `${day} at ${timeLabel(lead, config)}`;
  }
  if (lead.appointmentDate) {
    const [y, m, dd] = lead.appointmentDate.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(Date.UTC(y, m - 1, dd, 12)));
  }
  return "";
}

export function timeLabel(lead, config) {
  if (!lead.appointmentAt) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: config.timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(lead.appointmentAt));
}

/**
 * Build today's list. Idempotent: running it twice gives the same drafts with
 * the same ids, and a draft that is no longer due expires instead of lingering.
 *
 * @returns {{ today, drafts, callList, skipped }}
 */
export function buildDrafts(store, { now, config }) {
  const today = localDate(now, config.timeZone);
  const candidates = [];
  const callList = [];
  const skipped = [];

  for (const lead of Object.values(store.leads)) {
    if (lead.notionGone) continue;
    const due = dueFor(store, lead, today, { now, config });
    if (!due) continue;
    const check = canSend(store, { lead, template: due.template }, { now, config, checkHours: false });
    if (!check.ok) {
      if (["NO_CONSENT", "OPTED_OUT"].includes(check.reason) && lead.phone) {
        callList.push({ lead, why: due.why, template: due.template, note: check.reason === "OPTED_OUT" ? "opted out of texts" : check.detail === "only OK'd texts about the visit" ? "only OK'd visit texts" : "no text consent yet" });
      } else {
        skipped.push({ lead, why: due.why, reason: check.reason, detail: check.detail });
      }
      continue;
    }
    candidates.push({ lead, due });
  }

  candidates.sort((a, b) => {
    const p = PRIORITY.indexOf(a.due.template) - PRIORITY.indexOf(b.due.template);
    return p || (b.due.overdue || 0) - (a.due.overdue || 0);
  });

  const taken = new Set(store.outbound.map((m) => m.id));
  const slotsUsed = new Set();
  const chosenKeys = new Set();
  const drafts = [];

  for (const { lead, due } of candidates) {
    const kind = TEMPLATES[due.template].kind;
    const slot = `${lead.phone}:${kind}`;
    if (slotsUsed.has(slot)) {
      skipped.push({ lead, why: due.why, reason: "ONE_PER_NUMBER", detail: "another lead on this number is texted today" });
      continue;
    }
    if (due.template === "sold-review" && !config.reviewUrl) {
      skipped.push({ lead, why: due.why, reason: "NO_REVIEW_LINK", detail: "add reviewUrl to data/config.json" });
      continue;
    }
    const key = `${lead.id}:${due.template}:${due.dueKey}`;
    let msg = store.outbound.find((m) => m.key === key && m.status === "draft");
    if (!msg) {
      let body;
      try {
        body = render(due.template, {
          firstName: firstNameOf(lead),
          vehicle: lead.vehicle || "",
          senderName: config.senderName,
          dealership: config.dealership,
          bookingUrl: config.bookingUrl,
          when: whenLabel(lead, config),
          time: timeLabel(lead, config),
          reviewUrl: config.reviewUrl,
        });
      } catch (e) {
        skipped.push({ lead, why: due.why, reason: e.code || "RENDER_FAILED", detail: e.message });
        continue;
      }
      const id = shortId(key, taken);
      taken.add(id);
      msg = {
        id,
        key,
        leadId: lead.id,
        phone: lead.phone,
        template: due.template,
        dueKey: due.dueKey,
        why: due.why,
        body,
        status: "draft",
        createdAt: now.toISOString(),
      };
      store.outbound.push(msg);
    }
    msg.segments = smsSegments(msg.body).segments;
    slotsUsed.add(slot);
    chosenKeys.add(key);
    drafts.push({ ...msg, kind, lead });
  }

  // Drafts from earlier that are no longer the right message expire.
  for (const m of store.outbound) {
    const kind = TEMPLATES[m.template]?.kind;
    if (m.status === "draft" && (kind === "outreach" || kind === "appointment") && !chosenKeys.has(m.key)) {
      m.status = "expired";
      m.expiredAt = now.toISOString();
    }
  }

  // Replies owed to customers (HELP, opt-out confirmation) go on top.
  const replies = store.outbound
    .filter((m) => m.status === "draft" && !["outreach", "appointment"].includes(TEMPLATES[m.template]?.kind))
    .map((m) => ({ ...m, kind: TEMPLATES[m.template]?.kind, segments: smsSegments(m.body).segments, lead: store.leads[m.leadId] || null }));

  return { today, drafts: [...replies, ...drafts], callList, skipped };
}

/**
 * Appointments from yesterday through the next week, for the "Coming in"
 * section: time, who, and where each one stands.
 */
export function upcomingAppointments(store, { now, config }, days = 7, lookBack = 14) {
  const today = localDate(now, config.timeZone);
  const marked = (l) => l.showed === true || l.showed === false || /\bshowed\b/i.test(l.stage || "") || isNoShowStage(l.stage);
  return Object.values(store.leads)
    .filter((l) => !l.notionGone && l.appointmentDate && !isClosedStage(l.stage) && !l.closed)
    .map((l) => ({ lead: l, since: daysBetween(l.appointmentDate, today) }))
    // Next week, yesterday, and any past one still waiting to be marked Showed / No-show.
    .filter(({ lead, since }) => since >= -days && (since <= 1 || (since <= lookBack && !marked(lead))))
    .sort((a, b) => (a.lead.appointmentAt || a.lead.appointmentDate).localeCompare(b.lead.appointmentAt || b.lead.appointmentDate))
    .map(({ lead, since }) => {
      const done = touchesOf(store, lead);
      const ms = lead.appointmentAt ? Date.parse(lead.appointmentAt) : null;
      const past = since > 0 || (since === 0 && ms && now.getTime() > ms);
      let status;
      if (lead.showed === true || /\bshowed\b/i.test(lead.stage || "")) status = "showed";
      else if (lead.showed === false || isNoShowStage(lead.stage)) status = "no-show";
      else if (past) status = "mark";
      else if (lead.confirmedAt) status = "confirmed";
      else if (done.has("confirm")) status = "waiting";
      else status = "unconfirmed";
      const day = since === 0 ? "Today" : since === -1 ? "Tomorrow" : since === 1 ? "Yesterday" : since > 1 ? `${since} days ago` : whenLabel(lead, config).replace(/ at .*/, "");
      const time = timeLabel(lead, config);
      return { lead, since, status, day, time, touches: [...done] };
    });
}

export { localParts };
