import { test } from "node:test";
import assert from "node:assert/strict";
import { config, store, lead, add, WED_10AM } from "./helpers.js";
import { checkDeliveries, classify, outgoingSql, rowToOutgoing, deliverySummary, undelivered, toCheck } from "../src/delivery.js";
import { macMessagesProvider, buildOsascriptArgs, APPLESCRIPT_SMS_LINES, APPLESCRIPT_LINES } from "../src/providers/macMessages.js";
import { querySqlite } from "../src/messagesDb.js";
import { runPipe } from "../src/pipe.js";
import { validateConfig } from "../src/config.js";

// Nothing here can text anyone: every provider is a fake that records calls,
// and Messages' history is either a list in memory or a throwaway database.

const JAMAL = "+16175550100";
const LEAD = "+16175550199";
const BODY = "Hi Dana, it's Jamal at Woburn Toyota. You're booked Thu Oct 30 at 9:30 AM.";
const cfg = (o = {}) => config({ mode: "auto", alertPhone: JAMAL, ...o });
const min = (n) => new Date(WED_10AM.getTime() + n * 60000);
const fake = ({ fail = false } = {}) => {
  const calls = [];
  return { name: "fake", calls, async send(m) { calls.push(m); if (fail) throw new Error("no SMS account"); return { id: "f", service: m.service || "iMessage" }; } };
};

function setup() {
  const s = store();
  const l = add(s, lead({ id: "L1", name: "Dana Test", phone: LEAD, vehicle: "Corolla" }));
  const m = { id: "8dbd2c", key: "L1:booking-confirm:x", leadId: l.id, phone: LEAD, template: "booking-confirm", body: BODY, status: "sent", via: "mac-messages", attemptAt: WED_10AM.toISOString(), sentAt: WED_10AM.toISOString(), service: "iMessage" };
  s.outbound.push(m);
  return { s, m };
}
let rid = 500;
const row = (o = {}) => ({ rowid: ++rid, phone: LEAD, text: BODY, service: "iMessage", isSent: true, isDelivered: false, error: 0, at: WED_10AM.getTime() + 1000, deliveredAt: null, ...o });
const run = (s, rows, { now = min(1), c = cfg(), provider = fake() } = {}) => checkDeliveries(s, { now, config: c, provider, read: async () => rows }).then((rep) => ({ rep, provider }));

// ---------- reading Messages ----------

test("delivery sql: only a whole-number time goes in", () => {
  assert.throws(() => outgoingSql("1; DROP TABLE message"));
  assert.throws(() => outgoingSql(1.5));
  assert.throws(() => outgoingSql(-1));
  const sql = outgoingSql(1700000000);
  assert.match(sql, /is_from_me = 1/);
  assert.match(sql, />= 1700000000/);
});

test("delivery rows: phone normalized, text from attributedBody, flags read", () => {
  const r = rowToOutgoing({ rowid: 9, text: "  hi￼ there ", handle: "+1 (617) 555-0199", service: "SMS", is_sent: 1, is_delivered: 0, error: 0, unix: 1761055200 });
  assert.equal(r.phone, LEAD);
  assert.equal(r.text, "hi there");
  assert.equal(r.service, "SMS");
  assert.equal(r.isSent, true);
});

test("classify: delivered, SMS accepted, failed, pending then unconfirmed", () => {
  const c = cfg();
  assert.equal(classify(row({ isDelivered: true }), 0, c), "delivered");
  assert.equal(classify(row({ service: "SMS", isDelivered: true }), 0, c), "accepted");
  assert.equal(classify(row({ service: "SMS" }), 0, c), "accepted");
  assert.equal(classify(row({ error: 22 }), 0, c), "failed");
  assert.equal(classify(row(), 14 * 60000, c), "pending");
  assert.equal(classify(row(), 15 * 60000, c), "unconfirmed");
});

// ---------- one pass ----------

test("delivered: recorded, no alert, then never checked again", async () => {
  const { s, m } = setup();
  const { rep, provider } = await run(s, [row({ isDelivered: true })]);
  assert.equal(m.delivery.state, "delivered");
  assert.equal(m.delivery.service, "iMessage");
  assert.equal(provider.calls.length, 0);
  assert.equal(rep.alerts.length, 0);
  assert.equal(toCheck(s, min(2)).length, 0);
});

test("Not Delivered: Jamal gets ONE alert, the text stays 'sent' and is never resent", async () => {
  const { s, m } = setup();
  const rows = [row({ error: 22 })];
  const { provider } = await run(s, rows);
  assert.equal(m.delivery.state, "failed");
  assert.equal(m.status, "sent");
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].to, JAMAL);
  assert.match(provider.calls[0].body, /NOT delivered: Dana Test \(Corolla\)/);
  assert.match(provider.calls[0].body, /\(617\) 555-0199/);
  const again = await run(s, rows, { now: min(3) });
  assert.equal(again.provider.calls.length, 0);
  assert.equal(s.outbound.length, 1);
});

test("no receipt: pending at 10 minutes, flagged once at 15", async () => {
  const { s, m } = setup();
  const rows = [row()];
  const a = await run(s, rows, { now: min(10) });
  assert.equal(m.delivery.state, "pending");
  assert.equal(a.provider.calls.length, 0);
  const b = await run(s, rows, { now: min(16) });
  assert.equal(m.delivery.state, "unconfirmed");
  assert.equal(b.provider.calls.length, 1);
  // A late receipt still counts, without a second alert.
  rows[0].isDelivered = true;
  const c = await run(s, rows, { now: min(30) });
  assert.equal(m.delivery.state, "delivered");
  assert.equal(c.provider.calls.length, 0);
});

test("never in Messages: waits 5 minutes, then flags it", async () => {
  const { s, m } = setup();
  await run(s, [], { now: min(2) });
  assert.equal(m.delivery.state, "pending");
  const { provider } = await run(s, [], { now: min(6) });
  assert.equal(m.delivery.state, "missing");
  assert.match(provider.calls[0].body, /never showed up/);
});

test("matching: wrong number, wrong text, or an older bubble never counts", async () => {
  const { s, m } = setup();
  await run(s, [row({ phone: JAMAL, isDelivered: true }), row({ text: "something else", isDelivered: true }), row({ at: WED_10AM.getTime() - 10 * 60000, isDelivered: true })], { now: min(1) });
  assert.equal(m.delivery.state, "pending");
});

test("matching: two identical texts claim two different bubbles", async () => {
  const { s, m } = setup();
  const m2 = { ...m, id: "second", key: "k2", delivery: undefined };
  s.outbound.push(m2);
  await run(s, [row({ isDelivered: true }), row({ error: 22 })]);
  assert.notEqual(m.delivery.rowid, m2.delivery.rowid);
  assert.deepEqual([m.delivery.state, m2.delivery.state].sort(), ["delivered", "failed"]);
});

test("only texts this engine sent from the Mac are checked", async () => {
  const { s, m } = setup();
  m.via = "manual";
  const { rep } = await run(s, [row({ error: 22 })]);
  assert.equal(rep.checked, 0);
  assert.equal(m.delivery, undefined);
});

test("no alert phone / no provider (the read-only `delivery` command): records, texts no one", async () => {
  const { s, m } = setup();
  await checkDeliveries(s, { now: min(1), config: cfg(), read: async () => [row({ error: 22 })] });
  assert.equal(m.delivery.state, "failed");
  assert.equal(s.alerts[0].status, "none");
});

// ---------- opt-in SMS retry ----------

test("SMS retry is off by default", async () => {
  const { s } = setup();
  const { provider } = await run(s, [row({ error: 22 })]);
  assert.equal(provider.calls.filter((c) => c.service === "SMS").length, 0);
});

test("SMS retry on: exactly one SMS try, then it follows the SMS bubble", async () => {
  const { s, m } = setup();
  const c = cfg({ smsRetry: true });
  const failed = row({ error: 22 });
  const a = await run(s, [failed], { c });
  assert.equal(a.provider.calls.length, 1);
  assert.deepEqual([a.provider.calls[0].to, a.provider.calls[0].service, a.provider.calls[0].idempotencyKey], [LEAD, "SMS", "8dbd2c-sms"]);
  assert.equal(m.delivery.state, "pending");
  const sms = row({ service: "SMS", at: min(1).getTime() });
  const b = await run(s, [failed, sms], { c, now: min(2) });
  assert.equal(m.delivery.state, "accepted");
  assert.equal(m.delivery.rowid, sms.rowid);
  assert.equal(b.provider.calls.length, 0);
  const again = await run(s, [failed, sms], { c, now: min(5) });
  assert.equal(again.provider.calls.length, 0);
});

test("SMS retry that fails: alert says so, never tried again", async () => {
  const { s, m } = setup();
  const c = cfg({ smsRetry: true });
  const p = fake({ fail: true });
  await run(s, [row({ error: 22 })], { c, provider: p });
  assert.equal(m.delivery.retry.status, "failed");
  assert.equal(m.delivery.state, "failed");
  await run(s, [row({ error: 22 })], { c, provider: p, now: min(5) });
  assert.equal(p.calls.filter((x) => x.service === "SMS").length, 1);
});

test("SMS retry never fires for a dry run", async () => {
  const { s } = setup();
  const p = { ...fake(), dryRun: true };
  await run(s, [row({ error: 22 })], { c: cfg({ smsRetry: true }), provider: p });
  assert.equal(p.calls.filter((x) => x.service === "SMS").length, 0);
});

// ---------- the Mac sender's SMS-only mode ----------

test("mac: SMS-only mode uses the fixed SMS script; anything else is refused", async () => {
  const seen = [];
  const p = macMessagesProvider({ platform: "darwin", gapMs: 0, exec: async (f, args) => (seen.push(args), { stdout: "SMS\n" }) });
  const r = await p.send({ to: LEAD, body: "hi", idempotencyKey: "k", service: "SMS" });
  assert.equal(r.service, "SMS");
  assert.deepEqual(seen[0], buildOsascriptArgs(LEAD, "hi", { service: "SMS" }));
  assert.ok(seen[0].includes(APPLESCRIPT_SMS_LINES[6]));
  assert.ok(!seen[0].join("\n").includes("iMessage"));
  await assert.rejects(p.send({ to: LEAD, body: "hi", idempotencyKey: "k", service: "carrier-pigeon" }), /unknown service/);
  await p.send({ to: LEAD, body: "hi", idempotencyKey: "k2" });
  assert.ok(seen[1].includes(APPLESCRIPT_LINES[8])); // default is still iMessage first
});

// ---------- phone commands and config ----------

test("pipe: due lists texts that didn't arrive; handled clears; status counts", async () => {
  const { s } = setup();
  await run(s, [row({ error: 22 })]);
  const c = cfg();
  const due = await runPipe("due", s, { now: min(5), config: c });
  assert.match(due.reply, /1 text DIDN'T ARRIVE/);
  assert.match(due.reply, /Dana Test: .*failed, iMessage/);
  const st = await runPipe("status", s, { now: min(5), config: c });
  assert.match(st.reply, /Delivery \(7 days\): 0 delivered, 0 sent as SMS, 1 didn't arrive/);
  const h = await runPipe("handled dana", s, { now: min(6), config: c });
  assert.match(h.reply, /cleared 1 didn't-arrive flag/);
  assert.equal(undelivered(s, min(7)).length, 0);
  assert.equal(deliverySummary(s, min(7)).failed, 1); // history keeps the truth
});

test("config: delivery settings are checked", () => {
  assert.throws(() => validateConfig(config({ smsRetry: "yes" })), /smsRetry/);
  assert.throws(() => validateConfig(config({ unconfirmedAfterMinutes: 0 })), /unconfirmed/);
  assert.equal(config().smsRetry, false);
});

// ---------- the real SQL against Messages' table layout ----------

test("delivery sql runs against a chat.db-shaped database", async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return t.skip("node:sqlite not available in this Node");
  }
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER, service TEXT,
      is_from_me INTEGER, is_sent INTEGER, is_delivered INTEGER, error INTEGER, date INTEGER, date_delivered INTEGER,
      cache_roomnames TEXT, associated_message_type INTEGER, item_type INTEGER);
    INSERT INTO handle VALUES (1, '+16175550199', 'iMessage');
    INSERT INTO chat VALUES (1, '+16175550199');`);
  const apple = (ms) => (Math.floor(ms / 1000) - 978307200) * 1e9;
  const ins = db.prepare("INSERT INTO message VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0)");
  ins.run(1, "g1", BODY, 1, "iMessage", 1, 1, 0, 22, apple(WED_10AM.getTime() + 1000), 0); // our text, Not Delivered
  ins.run(2, "g2", "reply from them", 1, "iMessage", 0, 0, 0, 0, apple(WED_10AM.getTime() + 2000), 0); // incoming: ignored
  ins.run(3, "g3", BODY, 0, "iMessage", 1, 1, 1, 0, apple(WED_10AM.getTime() + 3000), 0); // handle_id 0: found via chat
  db.exec("INSERT INTO chat_message_join VALUES (1, 3)");
  const exec = async (_f, args) => ({ stdout: JSON.stringify(db.prepare(args[3]).all()) });
  const rows = (await querySqlite(outgoingSql(Math.floor(WED_10AM.getTime() / 1000) - 60), { exec })).map(rowToOutgoing);
  assert.deepEqual(rows.map((r) => [r.rowid, r.phone, r.error, r.isDelivered]), [[1, LEAD, 22, false], [3, LEAD, 0, true]]);
});
