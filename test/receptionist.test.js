import { test } from "node:test";
import assert from "node:assert/strict";
import { config, store, lead, add, WED_10AM } from "./helpers.js";
import { TEMPLATES, render, smsSegments } from "../src/templates.js";
import { priceFlags } from "../src/priceBlock.js";
import { checkReplies, planReply, RESCHEDULE, ADDRESS } from "../src/receptionist.js";
import { decodeAttributedBody, newRepliesSql, rowToMessage } from "../src/messagesDb.js";
import { sendDraft } from "../src/send.js";

// Nothing here can text anyone: every provider is a fake that records calls.
const JAMAL = "+13393683396";
const cfg = (o = {}) => config({ mode: "auto", autoReplies: true, alertPhone: JAMAL, ...o });
const WED_9PM = new Date("2026-10-22T01:00:00Z"); // after hours
const fakeProvider = () => {
  const sent = [];
  return { sent, name: "fake", async send(m) { sent.push(m); return { id: "f-" + m.idempotencyKey, service: "iMessage" }; } };
};
let row = 100;
const msg = (handle, text, extra = {}) => ({ rowid: ++row, guid: "g" + row, handle, text, receivedAt: WED_10AM.toISOString(), service: "iMessage", ...extra });
async function run(s, rows, { now = WED_10AM, c = cfg(), provider = fakeProvider() } = {}) {
  if (!Number.isInteger(s.replyCursor)) s.replyCursor = 0;
  const rep = await checkReplies(s, { now, config: c, provider, read: async () => rows, readMax: async () => 0 });
  return { rep, provider };
}

// ---------- templates ----------

test("receptionist templates: name Jamal + dealership, no price talk, short, plain", () => {
  const v = { senderName: "Jamal", dealership: "Woburn Toyota", bookingUrl: "https://jamal-schedule-woburn-toyota.netlify.app", dealerAddress: "394 Washington St, Woburn, MA 01801" };
  const replies = Object.entries(TEMPLATES).filter(([, t]) => t.kind === "reply");
  assert.deepEqual(replies.map(([n]) => n).sort(), ["reply-address", "reply-book", "reply-confirm", "reply-hot"]);
  for (const [name] of replies) {
    const out = render(name, v);
    assert.ok(out.includes("Jamal") && out.includes("Woburn Toyota"), name);
    assert.deepEqual(priceFlags(out), [], name);
    assert.equal(smsSegments(out).encoding, "GSM-7", name);
    assert.ok(smsSegments(out).segments <= 1, name);
  }
});

test("intent patterns: reschedule and address", () => {
  for (const t of ["Can we reschedule?", "I can't make it Friday", "need a different time", "running late, can we push it", "can I move my appointment"])
    assert.ok(RESCHEDULE.test(t), t);
  for (const t of ["what's the address", "where are you guys? where r u", "Where are you located", "send me directions"]) assert.ok(ADDRESS.test(t), t);
  for (const t of ["sounds good", "how much is it", "I'll be there at 3"]) assert.ok(!RESCHEDULE.test(t) && !ADDRESS.test(t), t);
});

// ---------- who gets handled ----------

test("first run starts from now and answers nothing old", async () => {
  const s = store();
  add(s, lead({ id: "L1" }));
  const p = fakeProvider();
  const rep = await checkReplies(s, { now: WED_10AM, config: cfg(), provider: p, read: async () => { throw new Error("must not read"); }, readMax: async () => 4321 });
  assert.equal(rep.initialized, true);
  assert.equal(s.replyCursor, 4321);
  assert.equal(p.sent.length, 0);
});

test("family, friends, Jamal himself and closed leads are ignored and not stored", async () => {
  const s = store();
  add(s, lead({ id: "L1", phone: "+16175550101" }));
  add(s, lead({ id: "L2", phone: "+16175550102", closed: { stage: "Lost" }, stage: "Lost" }));
  add(s, lead({ id: "L3", phone: JAMAL })); // a test row that uses Jamal's own number
  const { rep, provider } = await run(s, [
    msg("+16175559999", "how much for dinner tonight?"), // not a lead
    msg("+16175550102", "call me"), // closed lead
    msg(JAMAL, "HOT: alert echo"), // Jamal's own alerts coming back
    msg("someone@icloud.com", "hi"), // email handle
  ]);
  assert.equal(rep.handled.length, 0);
  assert.equal(provider.sent.length, 0);
  assert.deepEqual(s.inbound, {});
  assert.equal(s.replyCursor, row, "cursor still moves past them");
});

test("a closed lead's STOP is still honored", async () => {
  const s = store();
  add(s, lead({ id: "L2", phone: "+16175550102", closed: { stage: "Sold" }, stage: "Sold" }));
  const { provider } = await run(s, [msg("+16175550102", "STOP")]);
  assert.ok(s.optOuts["+16175550102"]);
  assert.equal(provider.sent.filter((m) => m.to === "+16175550102").length, 1, "one opt-out confirmation");
});

// ---------- what it answers ----------

test("price question: 'I'll call you shortly' to the lead + HOT alert to Jamal, nothing about price", async () => {
  const s = store();
  add(s, lead({ id: "L1", name: "Mike Zakirov", vehicle: "Sienna", phone: "+16175550101", notionId: "page1" }));
  const { rep, provider } = await run(s, [msg("+1 (617) 555-0101", "how much out the door for the Sienna?")]);
  const toLead = provider.sent.filter((m) => m.to === "+16175550101");
  const toJamal = provider.sent.filter((m) => m.to === JAMAL);
  assert.equal(toLead.length, 1);
  assert.match(toLead[0].body, /call shortly/);
  assert.deepEqual(priceFlags(toLead[0].body), []);
  assert.equal(toJamal.length, 1);
  assert.match(toJamal[0].body, /^HOT: Mike Zakirov \(Sienna\) texted: "how much out the door/);
  assert.match(toJamal[0].body, /\(617\) 555-0101/);
  assert.equal(rep.sent[0].template, "reply-hot");
  assert.equal(s.handoffs.filter((h) => !h.clearedAt).length, 1, "still waits for Jamal");
  assert.match(s.notionQueue.at(-1).appendNote, /replied "how much out the door/, "noted on the lead in Notion");
});

test("YES to a booked visit: 'see you then', no alert", async () => {
  const s = store();
  add(s, lead({ id: "L1", phone: "+16175550101", appointmentDate: "2026-10-23" }));
  const { provider } = await run(s, [msg("+16175550101", "Yes")]);
  assert.equal(provider.sent.length, 1);
  assert.match(provider.sent[0].body, /all set/);
  assert.equal(provider.sent[0].to, "+16175550101");
});

test("can't make it: booking link to the lead, heads-up to Jamal", async () => {
  const s = store();
  add(s, lead({ id: "L1", phone: "+16175550101", appointmentDate: "2026-10-23" }));
  const { provider } = await run(s, [msg("+16175550101", "something came up, can we reschedule?")]);
  const toLead = provider.sent.find((m) => m.to === "+16175550101");
  assert.match(toLead.body, /jamal-schedule-woburn-toyota\.netlify\.app/);
  assert.ok(provider.sent.find((m) => m.to === JAMAL));
});

test("where are you: address", async () => {
  const s = store();
  add(s, lead({ id: "L1", phone: "+16175550101" }));
  const { provider } = await run(s, [msg("+16175550101", "what's the address?")]);
  assert.match(provider.sent.find((m) => m.to === "+16175550101").body, /394 Washington St, Woburn, MA 01801/);
});

test("anything else: no answer, just the alert", async () => {
  const s = store();
  add(s, lead({ id: "L1", phone: "+16175550101" }));
  const { provider } = await run(s, [msg("+16175550101", "My wife wants to see it too")]);
  assert.equal(provider.sent.filter((m) => m.to === "+16175550101").length, 0);
  assert.equal(provider.sent.filter((m) => m.to === JAMAL).length, 1);
});

test("after hours: no answer to the lead, alert still goes", async () => {
  const s = store();
  add(s, lead({ id: "L1", phone: "+16175550101" }));
  const { provider } = await run(s, [msg("+16175550101", "what's the monthly on a RAV4?")], { now: WED_9PM });
  assert.equal(provider.sent.filter((m) => m.to === "+16175550101").length, 0);
  const a = provider.sent.find((m) => m.to === JAMAL);
  assert.match(a.body, /after hours/);
});

test("cooldown: a second question in the same stretch gets no second bot answer", async () => {
  const s = store();
  add(s, lead({ id: "L1", phone: "+16175550101" }));
  const p = fakeProvider();
  await run(s, [msg("+16175550101", "how much?")], { provider: p });
  await run(s, [msg("+16175550101", "and do you take trades?")], { provider: p, now: new Date(WED_10AM.getTime() + 10 * 60000) });
  assert.equal(p.sent.filter((m) => m.to === "+16175550101").length, 1);
  assert.equal(p.sent.filter((m) => m.to === JAMAL).length, 2, "Jamal hears about both");
});

test("the same message seen twice is handled once", async () => {
  const s = store();
  add(s, lead({ id: "L1", phone: "+16175550101" }));
  const p = fakeProvider();
  const m = msg("+16175550101", "call me");
  await run(s, [m], { provider: p });
  s.replyCursor = 0;
  await run(s, [m], { provider: p });
  assert.equal(p.sent.length, 2, "one answer + one alert, not four");
});

test("autoReplies off: answers stay drafts, alert still goes", async () => {
  const s = store();
  add(s, lead({ id: "L1", phone: "+16175550101" }));
  const { provider } = await run(s, [msg("+16175550101", "how much?")], { c: cfg({ autoReplies: false }) });
  assert.equal(provider.sent.filter((m) => m.to === "+16175550101").length, 0);
  assert.equal(s.outbound.filter((m) => m.status === "draft" && m.template === "reply-hot").length, 1);
  assert.equal(provider.sent.filter((m) => m.to === JAMAL).length, 1);
});

test("kill switch and opt-out still win", async () => {
  const s = store();
  add(s, lead({ id: "L1", phone: "+16175550101" }));
  const { provider } = await run(s, [msg("+16175550101", "how much?")], { c: cfg({ killSwitch: true }) });
  assert.equal(provider.sent.filter((m) => m.to === "+16175550101").length, 0);
  const s2 = store();
  add(s2, lead({ id: "L1", phone: "+16175550101" }));
  s2.optOuts["+16175550101"] = { at: WED_10AM.toISOString(), via: "test" };
  const r2 = await run(s2, [msg("+16175550101", "where are you located")]);
  assert.equal(r2.provider.sent.filter((m) => m.to === "+16175550101").length, 0);
});

test("a reply draft is not auto-sendable unless autoReplies is on", async () => {
  const s = store();
  add(s, lead({ id: "L1", phone: "+16175550101" }));
  s.outbound.push({ id: "r1", leadId: "L1", phone: "+16175550101", template: "reply-hot", body: "Good question - Jamal, Woburn Toyota", status: "draft", createdAt: WED_10AM.toISOString() });
  const p = fakeProvider();
  const r = await sendDraft(s, "r1", { now: WED_10AM, config: cfg({ autoReplies: false }), provider: p });
  assert.equal(r.reason, "TEMPLATE_NOT_AUTO");
  assert.equal(p.sent.length, 0);
});

test("planReply: 'can I come in tomorrow' with no visit booked -> booking link; with one booked -> just alert", () => {
  const c = cfg();
  const s = store();
  const classification = { type: "HANDOFF", priority: "hot", reasons: ["wants to come in"] };
  const free = planReply(s, { phone: "+16175550101", classification, leads: [lead()] }, "can I come in tomorrow?", { now: WED_10AM, config: c });
  assert.equal(free.template, "reply-book");
  const booked = planReply(s, { phone: "+16175550101", classification, leads: [lead({ appointmentDate: "2026-10-23" })] }, "see you tomorrow", { now: WED_10AM, config: c });
  assert.equal(booked.template, null);
});

// ---------- reading Messages ----------

test("Messages query: integer cursor only, incoming 1-to-1 texts only", () => {
  const sql = newRepliesSql(42);
  assert.match(sql, /ROWID > 42/);
  assert.match(sql, /is_from_me = 0/);
  assert.match(sql, /cache_roomnames IS NULL/);
  assert.throws(() => newRepliesSql("42; DROP TABLE message"), /bad Messages cursor/);
  assert.throws(() => newRepliesSql(-1), /bad Messages cursor/);
});

test("decodes text kept only in attributedBody (newer macOS)", () => {
  const typed = (s) => {
    const b = Buffer.from(s, "utf8");
    const len = b.length < 0x80 ? Buffer.from([b.length]) : Buffer.concat([Buffer.from([0x81]), Buffer.from([b.length & 0xff, b.length >> 8])]);
    return Buffer.concat([Buffer.from("040b73747265616d747970656481e803840140848484124e5341747472696275746564537472696e67", "hex"), Buffer.from("NSString"), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]), len, b, Buffer.from([0x86, 0x84])]).toString("hex");
  };
  assert.equal(decodeAttributedBody(typed("How much is the RAV4?")), "How much is the RAV4?");
  const long = "x".repeat(300);
  assert.equal(decodeAttributedBody(typed(long)), long);
  assert.equal(decodeAttributedBody(""), "");
  assert.equal(decodeAttributedBody("deadbeef"), "");
  const m = rowToMessage({ rowid: 7, guid: "G", text: null, ab: typed("call me \uFFFC"), unix: 1792000000, handle: "+16175550101" });
  assert.equal(m.text, "call me");
  assert.equal(m.rowid, 7);
});
