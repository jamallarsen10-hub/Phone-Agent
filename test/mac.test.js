import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, store, lead, add, WED_10AM } from "./helpers.js";
import { DEFAULTS, validateConfig } from "../src/config.js";
import { TEMPLATES } from "../src/templates.js";
import { buildDrafts } from "../src/drafts.js";
import { handleInbound } from "../src/inbound.js";
import { sendDraft, dryRunProvider } from "../src/send.js";
import { autoState, autoTick } from "../src/auto.js";
import { macMessagesProvider, buildOsascriptArgs, APPLESCRIPT_LINES } from "../src/providers/macMessages.js";

// Nothing here can text anyone: the Mac provider only ever gets a fake exec,
// and no test sets mode "auto" in a data folder or runs the CLI live.

const PHONE = "+15085550104";
const ctx = { now: WED_10AM };

/** Someone who booked for Friday: confirm is due, and the booking page's notice covers visit texts. */
const booked = (over = {}) =>
  lead({
    name: "Nina Walsh",
    phone: PHONE,
    consent: false,
    visitConsent: true,
    stage: "New Request",
    appointmentDate: "2026-10-23",
    appointmentAt: "2026-10-23T19:00:00Z",
    appointmentTime: "3:00 PM",
    ...over,
  });

/** A real-looking provider that only counts. */
function counting({ fail = false } = {}) {
  const calls = [];
  return {
    name: "fake",
    calls,
    async send(m) {
      calls.push(m);
      if (fail) throw new Error("Messages is not running");
      return { id: "SM1" };
    },
  };
}

const armed = (over = {}) => config({ mode: "auto", ...over });
const statuses = (s) => s.outbound.map((m) => m.status);

// ---------- the Mac provider ----------

test("mac: phone and message go as arguments, never into the script", async () => {
  const calls = [];
  const exec = async (file, args, opts) => (calls.push({ file, args, opts }), { stdout: "" });
  const p = macMessagesProvider({ exec, platform: "darwin", sleep: async () => {} });
  const hostile = `He said "hi" \\ and\nthen: tell application "Finder" to delete every item -- ' ; end tell — $(rm -rf ~) \`x\``;
  const r = await p.send({ to: PHONE, body: hostile, idempotencyKey: "abc123" });
  assert.deepEqual(r, { id: "mac-abc123" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "osascript");
  const { args } = calls[0];
  assert.equal(args.at(-2), PHONE);
  assert.equal(args.at(-1), hostile, "body arrives intact, byte for byte");

  const script = args.slice(0, -2);
  assert.equal(script.length, APPLESCRIPT_LINES.length * 2);
  script.forEach((a, i) => assert.equal(a, i % 2 === 0 ? "-e" : APPLESCRIPT_LINES[(i - 1) / 2]));
  assert.ok(!script.join("\n").includes("Finder"), "nothing from the body is in the script");
  assert.ok(!script.join("\n").includes(PHONE), "the number is not in the script either");
  // The script text does not depend on the message at all.
  assert.deepEqual(buildOsascriptArgs(PHONE, "a").slice(0, -1), buildOsascriptArgs(PHONE, "something else").slice(0, -1));
  // The script reads its inputs from argv and picks the SMS service.
  const text = APPLESCRIPT_LINES.join("\n");
  assert.match(text, /on run argv/);
  assert.match(text, /1st account whose service type = SMS/);
  assert.match(text, /participant thePhone of s/);
});

test("mac: refuses to run anywhere but a Mac", () => {
  assert.throws(() => macMessagesProvider({ platform: "linux", exec: async () => ({}) }), /only works on a Mac/);
  assert.throws(() => macMessagesProvider({ platform: "win32", exec: async () => ({}) }), /only works on a Mac/);
  assert.doesNotThrow(() => macMessagesProvider({ platform: "darwin", exec: async () => ({}) }));
});

test("mac: bad numbers and bad messages never reach osascript", async () => {
  let ran = 0;
  const p = macMessagesProvider({ exec: async () => (ran++, {}), platform: "darwin", sleep: async () => {} });
  const send = (over) => p.send({ to: PHONE, body: "Hi", idempotencyKey: "k", ...over });
  await assert.rejects(send({ to: "617-555-0101" }), /not a valid US number/);
  await assert.rejects(send({ to: "+16175550101; do shell script" }), /not a valid US number/);
  await assert.rejects(send({ to: undefined }), /not a valid US number/);
  await assert.rejects(send({ body: "" }), /empty message/);
  await assert.rejects(send({ body: "   \n " }), /empty message/);
  await assert.rejects(send({ body: undefined }), /empty message/);
  await assert.rejects(send({ body: "x".repeat(641) }), /too long/);
  await assert.rejects(send({ body: "a\0b" }), /NUL/);
  assert.equal(ran, 0);
});

test("mac: a few seconds between consecutive sends, and an error is passed up", async () => {
  let t = 0;
  const waits = [];
  const exec = async () => ({});
  const p = macMessagesProvider({ exec, platform: "darwin", clock: () => t, sleep: async (ms) => waits.push(ms) });
  const msg = { to: PHONE, body: "Hi", idempotencyKey: "k" };
  await p.send(msg);
  assert.deepEqual(waits, [], "first send goes straight out");
  await p.send(msg);
  assert.deepEqual(waits, [5000], "second send waits out the gap");
  t = 60000;
  await p.send(msg);
  assert.deepEqual(waits, [5000], "no wait once the gap has passed");

  const broken = macMessagesProvider({
    exec: async () => {
      throw new Error("Not authorized to send Apple events to Messages");
    },
    platform: "darwin",
  });
  await assert.rejects(broken.send(msg), /Not authorized/);
});

// ---------- config and the allowlist ----------

test("config: autoTemplates default is the three appointment texts, by real template key", () => {
  assert.deepEqual([...DEFAULTS.autoTemplates], ["booking-confirm", "reminder-night", "reminder-2h"]);
  for (const t of DEFAULTS.autoTemplates) assert.ok(TEMPLATES[t], t);
  assert.equal(DEFAULTS.mode, "drafts");
  assert.equal(DEFAULTS.killSwitch, false);
  assert.doesNotThrow(() => validateConfig({ ...DEFAULTS }));
  assert.throws(() => validateConfig({ ...DEFAULTS, autoTemplates: ["confirm"] }), /unknown template/);
  assert.throws(() => validateConfig({ ...DEFAULTS, autoTemplates: "booking-confirm" }), /list of template names/);
});

test("sendDraft: a real provider only sends templates on the allowlist", async () => {
  const s = store();
  add(s, lead({ followUpDate: "2026-10-21" })); // due for a routine follow-up, which is not auto-sendable
  const [d] = buildDrafts(s, { ...ctx, config: armed() }).drafts;
  assert.equal(d.template, "lead-followup");
  const p = counting();
  const r = await sendDraft(s, d.id, { ...ctx, config: armed(), provider: p });
  assert.equal(r.reason, "TEMPLATE_NOT_AUTO");
  assert.equal(p.calls.length, 0);
  assert.equal(s.outbound[0].status, "draft");

  // A config with no list at all sends nothing.
  const bare = { ...armed() };
  delete bare.autoTemplates;
  assert.equal((await sendDraft(s, d.id, { ...ctx, config: bare, provider: p })).reason, "TEMPLATE_NOT_AUTO");
  assert.equal(p.calls.length, 0);

  // The mode check still comes first.
  assert.equal((await sendDraft(s, d.id, { ...ctx, config: config(), provider: p })).reason, "DRAFTS_MODE");
});

// ---------- the automatic pass ----------

test("auto: default settings send nothing, even with a real provider", async () => {
  const s = store();
  add(s, booked());
  const p = counting();
  const rep = await autoTick(s, { ...ctx, config: config(), provider: p });
  assert.equal(p.calls.length, 0);
  assert.equal(rep.sent.length, 0);
  assert.equal(rep.held[0].reason, "DRAFTS_MODE");
  assert.deepEqual(statuses(s), ["draft"]);
  assert.equal(autoState(config()).live, false);
  assert.equal(autoState(config(), { live: false }).live, false);
});

test("auto: --live without mode auto is a dry run", async () => {
  const state = autoState(config(), { live: true });
  assert.equal(state.live, false);
  assert.match(state.notes[0], /--live ignored/);
  assert.match(state.notes[0], /drafts/);

  // And mode auto without --live is a dry run too.
  assert.equal(autoState(armed(), { live: false }).live, false);

  // Only both together arm it.
  assert.equal(autoState(armed(), { live: true }).live, true);

  // What a dry run does: lists the text, changes nothing, calls nothing.
  const s = store();
  add(s, booked());
  const logs = [];
  const rep = await autoTick(s, { ...ctx, config: armed(), provider: dryRunProvider((x) => logs.push(x)) });
  assert.equal(rep.sent.length, 0);
  assert.equal(rep.wouldSend.length, 1);
  assert.equal(rep.wouldSend[0].template, "booking-confirm");
  assert.match(rep.wouldSend[0].body, /Nina/);
  assert.deepEqual(statuses(s), ["draft"]);
});

test("auto: the CLI treats --live as a dry run unless mode is auto (nothing is texted)", () => {
  const dir = mkdtempSync(join(tmpdir(), "phone-agent-auto-"));
  try {
    const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const SAMPLE = fileURLToPath(new URL("../examples/cdk-export-sample.csv", import.meta.url));
    const env = { ...process.env, PHONE_AGENT_DATA: join(dir, "data"), PHONE_AGENT_OUT: join(dir, "out"), KILL_SWITCH: "", NOTION_TOKEN: "" };
    const run = (...a) => execFileSync(process.execPath, [CLI, ...a, "--now", "2026-10-21T10:00:00-04:00"], { env, encoding: "utf8" });
    run("import", SAMPLE);
    const out = run("auto", "--once", "--live");
    assert.match(out, /--live ignored/);
    assert.match(out, /would text .*booking-confirm/);
    assert.ok(!/ sent \[/.test(out), "nothing was sent");
    assert.match(out, /left as drafts for you/);
    assert.match(run("status"), /Texts logged sent: 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto: sends the allowlisted text once, records it, and leaves other drafts alone", async () => {
  const s = store();
  const nina = add(s, booked());
  add(s, lead({ id: "L2", name: "Maria Gonzalez", phone: "+16175550101", followUpDate: "2026-10-21" }));
  const p = counting();
  const snapshots = [];
  const persist = () => snapshots.push(statuses(s));

  const rep = await autoTick(s, { ...ctx, config: armed(), provider: p, persist });
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].to, PHONE);
  assert.match(p.calls[0].body, /Reply STOP to opt out\.$/);
  assert.equal(rep.sent.length, 1);
  assert.equal(rep.notAuto.length, 1, "the follow-up stays a draft for Jamal");
  assert.equal(rep.sent[0].template, "booking-confirm");

  const confirm = s.outbound.find((m) => m.template === "booking-confirm");
  assert.equal(confirm.status, "sent");
  assert.equal(confirm.via, "fake");
  assert.equal(s.outbound.find((m) => m.template === "lead-followup").status, "draft");
  assert.equal(nina.lastContact, "2026-10-21", "recorded like a text sent by hand");

  // The save before the send already said "sending", so a crash cannot leave a sendable draft behind.
  assert.ok(snapshots.some((x) => x.includes("sending")), JSON.stringify(snapshots));
  assert.ok(!snapshots[0].every((x) => x === "draft"), "not saved as a plain draft right before sending");

  // Running it again, and again, never texts them twice.
  await autoTick(s, { ...ctx, config: armed(), provider: p });
  await autoTick(s, { ...ctx, now: new Date(WED_10AM.getTime() + 60000), config: armed(), provider: p });
  assert.equal(p.calls.length, 1);
  assert.equal((await sendDraft(s, confirm.id, { ...ctx, config: armed(), provider: p })).reason, "NOT_A_DRAFT");
  assert.equal(p.calls.length, 1);
});

test("auto: a failed send stops the run and is never retried", async () => {
  const s = store();
  add(s, booked());
  const bad = counting({ fail: true });
  const rep = await autoTick(s, { ...ctx, config: armed(), provider: bad });
  assert.equal(rep.stop, true);
  assert.equal(rep.failed.length, 1);
  assert.equal(rep.sent.length, 0);
  assert.match(rep.failed[0].detail, /Messages is not running/);
  assert.equal(s.outbound[0].status, "failed");

  // Next run: buildDrafts would draft the same text again; auto holds it instead of sending.
  const good = counting();
  const again = await autoTick(s, { ...ctx, config: armed(), provider: good });
  assert.equal(good.calls.length, 0);
  assert.equal(again.sent.length, 0);
  assert.equal(again.held[0].reason, "UNKNOWN_OUTCOME");

  // Same for a send that was cut off mid-way (left as "sending" on disk).
  const s2 = store();
  add(s2, booked());
  buildDrafts(s2, { ...ctx, config: armed() });
  s2.outbound[0].status = "sending";
  const g2 = counting();
  const r2 = await autoTick(s2, { ...ctx, config: armed(), provider: g2 });
  assert.equal(g2.calls.length, 0);
  assert.equal(r2.held[0].reason, "UNKNOWN_OUTCOME");
});

test("auto: the kill switch stops everything, even armed", async () => {
  const s = store();
  add(s, booked());
  const kill = armed({ killSwitch: true });
  assert.equal(autoState(kill, { live: true }).live, false);
  const p = counting();
  const rep = await autoTick(s, { ...ctx, config: kill, provider: p });
  assert.equal(p.calls.length, 0);
  assert.equal(rep.sent.length, 0);
  assert.deepEqual(statuses(s), []);
});

test("auto: a number that sent STOP is never texted", async () => {
  const s = store();
  add(s, booked());
  s.optOuts[PHONE] = { at: "2026-10-20T12:00:00Z", via: "reply", text: "STOP" };
  const p = counting();
  const rep = await autoTick(s, { ...ctx, config: armed(), provider: p });
  assert.equal(p.calls.length, 0);
  assert.equal(rep.sent.length, 0);

  // Even a draft that already existed is refused at send time if STOP arrives after it was made.
  const s2 = store();
  add(s2, booked());
  const [d] = buildDrafts(s2, { ...ctx, config: armed() }).drafts;
  s2.optOuts[PHONE] = { at: WED_10AM.toISOString(), via: "reply", text: "STOP" };
  const r = await sendDraft(s2, d.id, { ...ctx, config: armed(), provider: p });
  assert.equal(r.reason, "OPTED_OUT");
  assert.equal(p.calls.length, 0);
});

test("auto: no permission, quiet hours, and a customer reply all hold the text", async () => {
  const p = counting();
  const noConsent = store();
  add(noConsent, booked({ visitConsent: false }));
  const nc = await autoTick(noConsent, { ...ctx, config: armed(), provider: p });
  assert.equal(nc.sent.length, 0, "no permission on file, so it lands on the call list instead");

  const night = store();
  add(night, booked());
  const rep = await autoTick(night, { now: new Date("2026-10-21T11:00:00Z"), config: armed(), provider: p }); // 7 AM
  assert.equal(rep.held[0].reason, "OUTSIDE_HOURS");

  const replied = store();
  add(replied, booked());
  handleInbound(replied, { from: PHONE, body: "can I come an hour earlier?" }, { ...ctx, config: armed() });
  const rr = await autoTick(replied, { ...ctx, config: armed(), provider: p });
  assert.equal(rr.sent.length, 0, "they replied, so Jamal answers first");

  assert.equal(p.calls.length, 0);
});
