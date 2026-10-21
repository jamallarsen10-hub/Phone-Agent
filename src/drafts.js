import { createHash } from "node:crypto";
import { canSend } from "./guardrails.js";
import { render, smsSegments, TEMPLATES } from "./templates.js";
import { localDate, daysBetween } from "./dates.js";
import { firstNameOf, isClosedStage, isNoShowStage } from "./leads.js";

/** Most urgent first. One text per number per day, so order decides who wins. */
const PRIORITY = ["missed-appointment", "after-test-drive", "new-lead", "lead-followup"];

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

/**
 * What this lead is due for today, if anything. Dates come from the export;
 * nothing here invents a follow-up the CRM did not ask for.
 */
export function dueFor(store, lead, today) {
  if (isClosedStage(lead.stage)) return null;
  const d = (a) => (a ? daysBetween(a, today) : null);

  const missed = lead.appointmentDate && (lead.showed === false || isNoShowStage(lead.stage));
  if (missed && d(lead.appointmentDate) >= 0 && d(lead.appointmentDate) <= 2 &&
      !sentForLead(store, lead.id, "missed-appointment", lead.appointmentDate)) {
    return { template: "missed-appointment", dueKey: lead.appointmentDate, why: `missed appointment ${lead.appointmentDate}` };
  }

  if (lead.testDriveDate && d(lead.testDriveDate) >= 0 && d(lead.testDriveDate) <= 1 &&
      !sentForLead(store, lead.id, "after-test-drive", lead.testDriveDate)) {
    return { template: "after-test-drive", dueKey: lead.testDriveDate, why: `test drive ${lead.testDriveDate}` };
  }

  // Already booked for today or later: leave them alone.
  if (lead.appointmentDate && !missed && d(lead.appointmentDate) <= 0) return null;

  if (lead.receivedDate && d(lead.receivedDate) >= 0 && d(lead.receivedDate) <= 1 &&
      !sentForLead(store, lead.id)) {
    return { template: "new-lead", dueKey: lead.receivedDate, why: `new lead ${lead.receivedDate}` };
  }

  if (lead.followUpDate && d(lead.followUpDate) >= 0 &&
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
    const due = dueFor(store, lead, today);
    if (!due) continue;
    const check = canSend(store, { lead, template: due.template }, { now, config, checkHours: false });
    if (!check.ok) {
      if (["NO_CONSENT", "OPTED_OUT"].includes(check.reason) && lead.phone) {
        callList.push({ lead, why: due.why, note: check.reason === "OPTED_OUT" ? "opted out of texts" : "no text consent yet" });
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
  const phonesUsed = new Set();
  const chosenKeys = new Set();
  const drafts = [];

  for (const { lead, due } of candidates) {
    if (phonesUsed.has(lead.phone)) {
      skipped.push({ lead, why: due.why, reason: "ONE_PER_NUMBER", detail: "another lead on this number is texted today" });
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
    phonesUsed.add(lead.phone);
    chosenKeys.add(key);
    drafts.push({ ...msg, lead });
  }

  // Outreach drafts from earlier days that are no longer the right message expire.
  for (const m of store.outbound) {
    if (m.status === "draft" && TEMPLATES[m.template]?.kind === "outreach" && !chosenKeys.has(m.key)) {
      m.status = "expired";
      m.expiredAt = now.toISOString();
    }
  }

  // Replies owed to customers (HELP, opt-out confirmation) go on top.
  const replies = store.outbound
    .filter((m) => m.status === "draft" && TEMPLATES[m.template]?.kind !== "outreach")
    .map((m) => ({ ...m, segments: smsSegments(m.body).segments, lead: store.leads[m.leadId] || null }));

  return { today, drafts: [...replies, ...drafts], callList, skipped };
}
