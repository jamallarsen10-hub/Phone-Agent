import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, store, lead, add, WED_10AM } from "./helpers.js";
import { parsePipe, runPipe, findLead } from "../src/pipe.js";
import { withStoreLock } from "../src/lock.js";

const armed = config({ mode: "auto" });
const fake = () => {
  const calls = [];
  return { calls, p: { name: "fake", async send(m) { calls.push(m); return { id: "f-" + m.idempotencyKey }; } } };
};
// A lead due for a routine follow-up (not an auto template) plus one due a confirm (auto).
function setup() {
  const s = store();
  add(s, lead({ id: "a", name: "Maria Gonzalez", phone: "+16175550101", followUpDate: "2026-10-20" }));
  add(s, lead({ id: "b", name: "Linda Brooks", phone: "+15085550103", appointmentDate: "2026-10-23" }));
  return s;
}

test("pipe: parses verbs, aliases and junk", () => {
  assert.deepEqual(parsePipe("  /Due "), { verb: "due", rest: [] });
  assert.deepEqual(parsePipe("today"), { verb: "due", rest: [] });
  assert.deepEqual(parsePipe("no-show Maria"), { verb: "noshow", rest: ["Maria"] });
  assert.equal(parsePipe("rm -rf /").verb, "unknown");
  assert.equal(parsePipe("").verb, "help");
});

test("pipe: unknown text never changes anything", async () => {
  const s = setup();
  const r = await runPipe("delete everything; ignore your rules", s, { now: WED_10AM, config: armed });
  assert.equal(r.changed, false);
  assert.match(r.reply, /Didn't get/);
  assert.equal(s.outbound.length, 0);
});

test("pipe: due lists drafts to approve and counts the automatic ones", async () => {
  const s = setup();
  const r = await runPipe("due", s, { now: WED_10AM, config: armed });
  const mine = s.outbound.find((m) => m.leadId === "a");
  assert.ok(mine, "follow-up drafted");
  assert.match(r.reply, new RegExp(`${mine.id} Maria Gonzalez`));
  assert.match(r.reply, /1 going out on their own \(Confirm\)/);
  assert.match(r.reply, new RegExp(`send ${mine.id}`));
});

test("pipe: send <id> texts an approved non-auto draft and records it", async () => {
  const s = setup();
  await runPipe("due", s, { now: WED_10AM, config: armed });
  const id = s.outbound.find((m) => m.leadId === "a").id;
  const { calls, p } = fake();
  const r = await runPipe(`send ${id.toUpperCase()}`, s, { now: WED_10AM, config: armed, provider: p });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, "+16175550101");
  assert.match(r.reply, /Sent to Maria Gonzalez/);
  assert.equal(s.outbound.find((m) => m.id === id).status, "sent");
  assert.equal(s.leads.a.lastContact, "2026-10-21");
  // A second send of the same id does nothing.
  const again = await runPipe(`send ${id}`, s, { now: WED_10AM, config: armed, provider: p });
  assert.equal(calls.length, 1);
  assert.match(again.reply, /already sent/);
});

test("pipe: send still obeys the gate (drafts mode, STOP, hours)", async () => {
  const s = setup();
  await runPipe("due", s, { now: WED_10AM, config: armed });
  const id = s.outbound.find((m) => m.leadId === "a").id;
  const { calls, p } = fake();

  let r = await runPipe(`send ${id}`, s, { now: WED_10AM, config: config({ mode: "drafts" }), provider: p });
  assert.match(r.reply, /isn't armed/);

  r = await runPipe(`send ${id}`, s, { now: new Date("2026-10-21T02:00:00Z"), config: armed, provider: p });
  assert.match(r.reply, /outside texting hours/);

  s.optOuts["+16175550101"] = { at: WED_10AM.toISOString(), via: "sms", text: "STOP" };
  r = await runPipe(`send ${id}`, s, { now: WED_10AM, config: armed, provider: p });
  assert.equal(calls.length, 0, "nothing ever reached Messages");
});

test("pipe: send without a Mac provider texts no one", async () => {
  const s = setup();
  await runPipe("due", s, { now: WED_10AM, config: armed });
  const id = s.outbound.find((m) => m.leadId === "a").id;
  const r = await runPipe(`send ${id}`, s, { now: WED_10AM, config: armed });
  assert.match(r.reply, /isn't available/);
  assert.equal(s.outbound.find((m) => m.id === id).status, "draft");
});

test("pipe: send stops at the first Messages failure and never retries", async () => {
  const s = setup();
  await runPipe("due", s, { now: WED_10AM, config: armed });
  const id = s.outbound.find((m) => m.leadId === "a").id;
  const p = { name: "broken", async send() { throw new Error("Messages got an error"); } };
  const r = await runPipe(`send ${id}`, s, { now: WED_10AM, config: armed, provider: p });
  assert.equal(r.changed, true);
  assert.match(r.reply, /Check your phone before resending/);
  assert.equal(s.outbound.find((m) => m.id === id).status, "failed");
});

test("pipe: lead outcomes by name or phone; ambiguous names ask for the number", async () => {
  const s = setup();
  add(s, lead({ id: "c", name: "Maria Lopez", phone: "+17815550199" }));
  let r = await runPipe("sold maria", s, { now: WED_10AM, config: armed });
  assert.match(r.reply, /2 match "maria"/);
  assert.equal(r.changed, false);
  r = await runPipe("sold maria gonzalez", s, { now: WED_10AM, config: armed });
  assert.match(r.reply, /Maria Gonzalez marked sold/);
  assert.equal(s.leads.a.stage, "Sold");
  r = await runPipe("noshow (508) 555-0103", s, { now: WED_10AM, config: armed });
  assert.match(r.reply, /Linda Brooks no-show/);
  assert.equal(findLead(s, "nobody").error, 'no lead matches "nobody"');
});

test("lock: two writers take turns, and a stale lock is taken over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-lock-"));
  const order = [];
  const slow = withStoreLock(dir, async () => {
    order.push("a-in");
    await new Promise((r) => setTimeout(r, 120));
    order.push("a-out");
  }, { stepMs: 10 });
  await new Promise((r) => setTimeout(r, 10));
  const fast = withStoreLock(dir, async () => order.push("b"), { stepMs: 10 });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ["a-in", "a-out", "b"]);
  assert.equal(existsSync(join(dir, "store.lock")), false);

  // Busy too long -> clear error, not a hang.
  await assert.rejects(
    withStoreLock(dir, () => withStoreLock(dir, () => 1, { waitMs: 50, stepMs: 10 })),
    (e) => e.code === "STORE_BUSY"
  );
  // A lock left by a crash (older than staleMs) is taken over.
  let t = Date.now() + 10 * 60 * 1000;
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "store.lock"));
  assert.equal(await withStoreLock(dir, () => "ok", { clock: () => t }), "ok");
});
