import { test } from "node:test";
import assert from "node:assert/strict";
import { config, store, lead, add, sent, WED_10AM } from "./helpers.js";
import { canSend, withinSendWindow } from "../src/guardrails.js";
import { buildDrafts, dueFor } from "../src/drafts.js";
import { handleInbound, clearHandoffs } from "../src/inbound.js";
import { markSent, sendDraft, dryRunProvider, skipDraft } from "../src/send.js";

const cfg = config();
const ctx = { now: WED_10AM, config: cfg };

// ---------- the gate ----------

test("gate: consented lead in hours passes", () => {
  const s = store();
  const l = add(s, lead());
  assert.deepEqual(canSend(s, { lead: l, template: "lead-followup" }, ctx), { ok: true });
});

test("gate: each block fires with its reason", () => {
  const s = store();
  const l = add(s, lead());
  const r = (over, c = ctx, t = "lead-followup") => canSend(s, { lead: { ...l, ...over }, template: t }, c).reason;
  assert.equal(r({}, { ...ctx, config: config({ killSwitch: true }) }), "KILL_SWITCH");
  assert.equal(r({ phone: "555-1234" }), "BAD_PHONE");
  assert.equal(r({ consent: false }), "NO_CONSENT");
  assert.equal(r({ consent: undefined }), "NO_CONSENT");
  assert.equal(r({}, { ...ctx, now: new Date("2026-10-21T11:00:00Z") }), "OUTSIDE_HOURS"); // 7 AM
  assert.equal(r({}, { ...ctx, now: new Date("2026-10-25T15:00:00Z") }), "OUTSIDE_HOURS"); // Sunday
  assert.equal(r({}, { ...ctx, now: new Date("2026-10-22T00:30:00Z") }), "OUTSIDE_HOURS"); // 8:30 PM
  assert.equal(r({}, { ...ctx, checkHours: false, now: new Date("2026-10-21T11:00:00Z") }), undefined);
  s.optOuts[l.phone] = { at: "2026-10-01T00:00:00Z" };
  assert.equal(r({}), "OPTED_OUT");
});

test("gate: STOP from one person blocks every lead on that number", () => {
  const s = store();
  const a = add(s, lead({ name: "Ashley Brooks", phone: "+15085550103" }));
  const b = add(s, lead({ name: "Linda Brooks", phone: "+15085550103" }));
  handleInbound(s, { from: a.phone, body: "STOP" }, ctx);
  assert.equal(canSend(s, { lead: b, template: "after-test-drive" }, ctx).reason, "OPTED_OUT");
});

test("gate: one text per number per local day, follow-ups need a gap", () => {
  const s = store();
  const l = add(s, lead());
  sent(s, { phone: l.phone, leadId: l.id, at: "2026-10-21T13:00:00Z", template: "after-test-drive" });
  assert.equal(canSend(s, { lead: l, template: "missed-appointment" }, ctx).reason, "DAILY_LIMIT");
  // 11 PM Tuesday local is 3 AM Wednesday UTC: it counts as yesterday, not today.
  const s2 = store();
  const l2 = add(s2, lead());
  sent(s2, { phone: l2.phone, leadId: l2.id, at: "2026-10-21T03:00:00Z" });
  assert.equal(canSend(s2, { lead: l2, template: "after-test-drive" }, ctx).ok, true);
  // ...but a routine follow-up still waits out the two-day gap.
  assert.equal(canSend(s2, { lead: l2, template: "lead-followup" }, ctx).reason, "TOO_SOON");
  const s3 = store();
  const l3 = add(s3, lead());
  sent(s3, { phone: l3.phone, leadId: l3.id, at: "2026-10-19T16:00:00Z" });
  assert.equal(canSend(s3, { lead: l3, template: "lead-followup" }, ctx).ok, true);
});

test("gate: an open reply holds automated texts until Jamal clears it", () => {
  const s = store();
  const l = add(s, lead());
  handleInbound(s, { from: l.phone, body: "what's the best price?" }, ctx);
  assert.equal(canSend(s, { lead: l, template: "lead-followup" }, ctx).reason, "AWAITING_JAMAL");
  assert.equal(clearHandoffs(s, l.phone, ctx), 1);
  assert.equal(canSend(s, { lead: l, template: "lead-followup" }, ctx).ok, true);
});

test("send window edges", () => {
  assert.equal(withinSendWindow(new Date("2026-10-21T13:00:00Z"), cfg), true); // 9:00 AM
  assert.equal(withinSendWindow(new Date("2026-10-21T12:59:00Z"), cfg), false); // 8:59 AM
  assert.equal(withinSendWindow(new Date("2026-10-21T23:59:00Z"), cfg), true); // 7:59 PM
  assert.equal(withinSendWindow(new Date("2026-10-22T00:00:00Z"), cfg), false); // 8:00 PM
});

// ---------- what is due ----------

test("due: missed appointment beats everything, booked leads are left alone", () => {
  const s = store();
  const today = "2026-10-21";
  assert.equal(dueFor(s, lead({ appointmentDate: "2026-10-20", showed: false, followUpDate: "2026-10-19" }), today).template, "missed-appointment");
  assert.equal(dueFor(s, lead({ appointmentDate: "2026-10-20", stage: "No Show" }), today).template, "missed-appointment");
  assert.equal(dueFor(s, lead({ appointmentDate: "2026-10-23", followUpDate: "2026-10-20" }), today), null);
  assert.equal(dueFor(s, lead({ appointmentDate: "2026-10-21", followUpDate: "2026-10-20" }), today), null);
  assert.equal(dueFor(s, lead({ stage: "Sold", followUpDate: "2026-10-20" }), today), null);
  assert.equal(dueFor(s, lead({ followUpDate: "2026-10-22" }), today), null);
  assert.equal(dueFor(s, lead({ testDriveDate: "2026-10-20" }), today).template, "after-test-drive");
  assert.equal(dueFor(s, lead({ testDriveDate: "2026-10-18" }), today), null);
  assert.equal(dueFor(s, lead({ receivedDate: "2026-10-21" }), today).template, "new-lead");
  const f = dueFor(s, lead({ followUpDate: "2026-10-18" }), today);
  assert.equal(f.template, "lead-followup");
  assert.equal(f.overdue, 3);
});

test("due: a follow-up already sent for that date is not due again", () => {
  const s = store();
  const l = add(s, lead({ followUpDate: "2026-10-20" }));
  sent(s, { phone: l.phone, leadId: l.id, template: "lead-followup", dueKey: "2026-10-20", at: "2026-10-20T15:00:00Z" });
  assert.equal(dueFor(s, l, "2026-10-21"), null);
  l.followUpDate = "2026-10-28"; // CRM set a new date
  assert.equal(dueFor(s, l, "2026-10-28").template, "lead-followup");
});

// ---------- drafts ----------

test("drafts: idempotent, one per number, call list for no consent", () => {
  const s = store();
  add(s, lead({ id: "a", name: "Ashley Brooks", phone: "+15085550103", appointmentDate: "2026-10-20", showed: false }));
  add(s, lead({ id: "b", name: "Linda Brooks", phone: "+15085550103", followUpDate: "2026-10-19" }));
  add(s, lead({ id: "c", name: "Tom Rivera", phone: "+16175550105", followUpDate: "2026-10-18", consent: false }));
  add(s, lead({ id: "d", name: "Maria Gonzalez", followUpDate: "2026-10-20" }));

  const r1 = buildDrafts(s, ctx);
  assert.deepEqual(r1.drafts.map((d) => d.lead.name), ["Ashley Brooks", "Maria Gonzalez"]);
  assert.equal(r1.drafts[0].template, "missed-appointment");
  assert.deepEqual(r1.callList.map((c) => c.lead.name), ["Tom Rivera"]);
  assert.equal(r1.skipped.find((x) => x.lead.name === "Linda Brooks").reason, "ONE_PER_NUMBER");

  const r2 = buildDrafts(s, ctx);
  assert.deepEqual(r2.drafts.map((d) => d.id), r1.drafts.map((d) => d.id));
  assert.equal(s.outbound.length, 2, "no duplicate drafts on re-run");
});

test("drafts: a draft that stops being due expires", () => {
  const s = store();
  const l = add(s, lead({ testDriveDate: "2026-10-21" }));
  const r = buildDrafts(s, ctx);
  assert.equal(r.drafts.length, 1);
  const later = { ...ctx, now: new Date("2026-10-24T14:00:00Z") };
  assert.equal(buildDrafts(s, later).drafts.length, 0);
  assert.equal(s.outbound[0].status, "expired");
  assert.ok(l);
});

test("drafts: first name falls back to 'there', vehicle-less text reads naturally", () => {
  const s = store();
  add(s, lead({ name: "j", vehicle: "", followUpDate: "2026-10-21" }));
  const [d] = buildDrafts(s, ctx).drafts;
  assert.match(d.body, /^Hi there, Jamal from Woburn Toyota checking in\. Still looking for your next car\?/);
});

test("drafts: price text in a CRM field blocks that draft", () => {
  const s = store();
  add(s, lead({ vehicle: "RAV4 $31,000 OTD", followUpDate: "2026-10-21" }));
  const r = buildDrafts(s, ctx);
  assert.equal(r.drafts.length, 0);
  assert.equal(r.skipped[0].reason, "PRICE_BLOCK");
});

// ---------- inbound ----------

test("inbound: STOP saves the opt-out, kills drafts, drafts one confirmation", () => {
  const s = store();
  const l = add(s, lead({ followUpDate: "2026-10-21" }));
  buildDrafts(s, ctx);
  const r = handleInbound(s, { messageId: "SM1", from: "(617) 555-0101", body: "Stop" }, ctx);
  assert.ok(s.optOuts[l.phone]);
  assert.equal(r.replyDraft.template, "opt-out-confirm");
  assert.equal(s.outbound.find((m) => m.template === "lead-followup").status, "expired");
  // Repeat STOP: no second confirmation.
  const r2 = handleInbound(s, { messageId: "SM2", from: l.phone, body: "STOP" }, ctx);
  assert.equal(r2.replyDraft.skipped, "ALREADY_DONE");
});

test("inbound: duplicate webhook delivery is processed once", () => {
  const s = store();
  add(s, lead());
  handleInbound(s, { messageId: "SM9", from: "+16175550101", body: "call me" }, ctx);
  const r = handleInbound(s, { messageId: "SM9", from: "+16175550101", body: "call me" }, ctx);
  assert.equal(r.duplicate, true);
  assert.equal(s.handoffs.length, 1);
});

test("inbound: START after STOP does not resume texting", () => {
  const s = store();
  const l = add(s, lead());
  handleInbound(s, { from: l.phone, body: "STOP" }, ctx);
  const r = handleInbound(s, { from: l.phone, body: "START" }, { ...ctx, now: new Date("2026-10-21T15:00:00Z") });
  assert.equal(r.classification.type, "OPT_IN_REQUEST");
  assert.ok(s.optOuts[l.phone], "still opted out");
  assert.equal(r.handoff.priority, "urgent");
});

test("inbound: HELP gets one reply a day", () => {
  const s = store();
  const l = add(s, lead());
  assert.equal(handleInbound(s, { from: l.phone, body: "help" }, ctx).replyDraft.template, "help");
  const again = handleInbound(s, { from: l.phone, body: "HELP" }, { ...ctx, now: new Date("2026-10-21T14:30:00Z") });
  assert.equal(again.replyDraft.skipped, "ALREADY_DONE");
});

// ---------- send paths ----------

test("markSent: logs once, refuses opted-out numbers", () => {
  const s = store();
  const l = add(s, lead({ followUpDate: "2026-10-21" }));
  const [d] = buildDrafts(s, ctx).drafts;
  assert.equal(markSent(s, d.id, ctx).ok, true);
  assert.equal(markSent(s, d.id, ctx).reason, "ALREADY_SENT");
  assert.equal(markSent(s, "zzzzzz", ctx).reason, "NOT_FOUND");
  const s2 = store();
  const l2 = add(s2, lead({ followUpDate: "2026-10-21" }));
  const [d2] = buildDrafts(s2, ctx).drafts;
  s2.optOuts[l2.phone] = { at: WED_10AM.toISOString() };
  assert.equal(markSent(s2, d2.id, ctx).reason, "OPTED_OUT");
  assert.ok(l);
});

test("sendDraft: dry run checks everything and changes nothing", async () => {
  const s = store();
  add(s, lead({ followUpDate: "2026-10-21" }));
  const [d] = buildDrafts(s, ctx).drafts;
  const logs = [];
  const r = await sendDraft(s, d.id, { ...ctx, provider: dryRunProvider((x) => logs.push(x)) });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(s.outbound[0].status, "draft");
  assert.equal(logs.length, 1);
  const night = await sendDraft(s, d.id, { ...ctx, now: new Date("2026-10-22T02:00:00Z"), provider: dryRunProvider(() => {}) });
  assert.equal(night.reason, "OUTSIDE_HOURS");
});

test("sendDraft: real provider needs auto mode; unknown outcome never retries", async () => {
  const s = store();
  add(s, lead({ followUpDate: "2026-10-21" }));
  const [d] = buildDrafts(s, ctx).drafts;
  const flaky = { name: "test", async send() { throw new Error("timeout"); } };
  assert.equal((await sendDraft(s, d.id, { ...ctx, provider: flaky })).reason, "DRAFTS_MODE");
  const auto = { ...ctx, config: config({ mode: "auto" }) };
  assert.equal((await sendDraft(s, d.id, { ...auto, provider: flaky })).reason, "PROVIDER_ERROR");
  assert.equal(s.outbound[0].status, "failed");
  assert.equal((await sendDraft(s, d.id, { ...auto, provider: flaky })).reason, "NOT_A_DRAFT");
  let calls = 0;
  const good = { name: "test", async send() { calls++; return { id: "SM123" }; } };
  const s2 = store();
  add(s2, lead({ followUpDate: "2026-10-21" }));
  const [d2] = buildDrafts(s2, ctx).drafts;
  assert.equal((await sendDraft(s2, d2.id, { ...auto, provider: good })).ok, true);
  assert.equal((await sendDraft(s2, d2.id, { ...auto, provider: good })).reason, "NOT_A_DRAFT");
  assert.equal(calls, 1);
  assert.equal(skipDraft(s2, d2.id, ctx).reason, "NOT_A_DRAFT");
});
