import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { config } from "./helpers.js";
import { mapPage, mergePages, syncNotion, flushQueue, notionClient, buildUpdate, GRACE_MS } from "../src/notion.js";
import { loadStore, saveStore, EMPTY } from "../src/store.js";
import { buildDrafts, dueFor } from "../src/drafts.js";
import { runAction } from "../src/actions.js";
import { startServer } from "../src/server.js";

const cfg = config({ notionToken: "test" });
const TZ = "America/New_York";

/** A page shaped like the Notion API returns for the Lead Pipeline. */
function page(o) {
  const rt = (s) => (s ? [{ type: "text", text: { content: s, link: null }, annotations: { bold: false }, plain_text: s }] : []);
  return {
    object: "page",
    id: o.id,
    url: `https://www.notion.so/${o.id}`,
    created_time: o.created || "2026-10-20T15:00:00.000Z",
    archived: false,
    properties: {
      Name: { type: "title", title: rt(o.name) },
      Phone: { type: "phone_number", phone_number: o.phone ?? "(617) 555-0123" },
      Email: { type: "email", email: null },
      Vehicle: { type: "select", select: o.vehicle ? { name: o.vehicle } : null },
      Stage: { type: "select", select: { name: o.stage || "New Request" } },
      Source: { type: "select", select: o.source ? { name: o.source } : null },
      Requested: { type: "date", date: o.requested ? { start: o.requested, end: null } : null },
      "Follow-Up": { type: "date", date: o.followUp ? { start: o.followUp, end: null } : null },
      "Last Contact": { type: "date", date: o.lastContact ? { start: o.lastContact, end: null } : null },
      "Touches Sent": { type: "multi_select", multi_select: (o.touches || []).map((name) => ({ name })) },
      Notes: { type: "rich_text", rich_text: o.richNotes || rt(o.notes) },
    },
  };
}

/** In-memory Notion that applies updates the way the API does. */
function fakeNotion(pages) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const log = [];
  return {
    log,
    pages: byId,
    async queryAll() { log.push("query"); return [...byId.values()].map((p) => structuredClone(p)); },
    async getPage(id) { log.push("get " + id); return structuredClone(byId.get(id)); },
    async updatePage(id, properties) {
      log.push("update " + id);
      const p = byId.get(id);
      for (const [k, v] of Object.entries(properties)) {
        if (v.select) p.properties[k] = { type: "select", select: v.select };
        else if (v.date) p.properties[k] = { type: "date", date: v.date };
        else if (v.multi_select) p.properties[k] = { type: "multi_select", multi_select: v.multi_select };
        else if (v.rich_text) p.properties[k] = { type: "rich_text", rich_text: v.rich_text.map((t) => ({ ...t, plain_text: t.text.content })) };
      }
      return p;
    },
  };
}

test("mapPage: reads the pipeline the way Jamal uses it", () => {
  const l = mapPage(page({
    id: "p1", name: "Ana Diaz", vehicle: "Not sure yet", source: "Instagram",
    requested: "2026-10-22T15:00:00.000-04:00", touches: ["confirm"], followUp: "2026-10-30",
    notes: "bringing my wife\nBooked on website: OK to text about this visit (2026-10-21T14:00Z)",
  }), TZ);
  assert.equal(l.phone, "+16175550123");
  assert.equal(l.vehicle, "", "'Not sure yet' never ends up in a text");
  assert.equal(l.appointmentDate, "2026-10-22");
  assert.equal(l.appointmentTime, "15:00");
  assert.equal(l.appointmentAt, "2026-10-22T19:00:00.000Z");
  assert.deepEqual(l.touches, ["confirm"]);
  assert.equal(l.visitConsent, true);
  assert.equal(l.notesConsent, false, "visit texts only");
  // A UTC timestamp from Notion still lands on the right Woburn day.
  assert.equal(mapPage(page({ id: "p2", requested: "2026-10-23T01:30:00.000Z" }), TZ).appointmentDate, "2026-10-22");
  assert.equal(mapPage(page({ id: "p3", notes: "OK to text follow-ups: asked on call (2026-10-21)" }), TZ).notesConsent, true);
  assert.equal(mapPage(page({ id: "p4", notes: "Texts: replied STOP 2026-10-21. Do not text." }), TZ).notesOptOut, true);
  assert.equal(mapPage(page({ id: "p5", source: "Walk-in", requested: "2026-10-22" }), TZ).visitConsent, false, "walk-ins need permission on file");
});

test("mergePages: taps and first-seen sale survive a pull; missing pages are parked", () => {
  const s = EMPTY();
  const now = new Date("2026-10-21T14:00:00Z");
  mergePages(s, [page({ id: "a1", name: "Ana Diaz", stage: "Accepted" }), page({ id: "b2", name: "Bo Li" })], { now, config: cfg });
  const ana = s.leads.n_a1;
  ana.consentTap = { source: "asked on call", at: now.toISOString() };
  mergePages(s, [page({ id: "a1", name: "Ana Diaz", stage: "Sold" })], { now, config: cfg });
  assert.equal(ana.consent, true, "the tap is kept");
  assert.ok(ana.soldAt, "sale noticed the first time");
  assert.equal(s.leads.n_b2.notionGone, true);
  mergePages(s, [page({ id: "c3", name: "Cy", notes: "Do not text", phone: "781-555-0199" })], { now, config: cfg });
  assert.ok(s.optOuts["+17815550199"], "a do-not-text note becomes an opt-out");
});

test("Notion booking end to end: confirm, write-back, reminders, STOP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-notion-"));
  try {
    const notion = fakeNotion([
      page({ id: "a1", name: "Ana Diaz", vehicle: "RAV4 Hybrid", source: "Instagram", stage: "New Request",
        requested: "2026-10-22T15:00:00.000-04:00", touches: ["cdk-intro"],
        richNotes: [{ type: "text", text: { content: "see ", link: null }, annotations: {}, plain_text: "see " },
                    { type: "text", text: { content: "listing", link: { url: "https://x.example" } }, annotations: {}, plain_text: "listing" }] }),
      page({ id: "w2", name: "Walk In", phone: "781-555-0142", source: "Walk-in", stage: "CDK Lead", followUp: "2026-10-20" }),
    ]);
    const wed10 = new Date("2026-10-21T14:00:00Z");
    saveStore(dir, EMPTY());

    // 1. Pull: Ana's website booking tomorrow needs a confirm. The CDK walk-in has no permission: call list.
    assert.equal((await syncNotion(dir, cfg, notion, { now: wed10 })).count, 2);
    let s = loadStore(dir);
    let r = buildDrafts(s, { now: wed10, config: cfg });
    const confirm = r.drafts.find((d) => d.template === "booking-confirm");
    assert.ok(confirm, "confirm drafted from the booking page's visit permission");
    assert.match(confirm.body, /You're set for Thu, Oct 22 at 3:00 PM to see the RAV4 Hybrid\./);
    assert.ok(r.callList.some((c) => c.lead.name === "Walk In"));
    saveStore(dir, s);

    // 2. Tap Sent: Notion change is queued, held through the undo window.
    s = loadStore(dir);
    assert.equal(runAction("sent", { id: confirm.id }, s, { now: wed10, config: cfg }).ok, true);
    assert.equal(s.leads.n_a1.stage, "Accepted", "shows right away");
    saveStore(dir, s);
    await flushQueue(dir, cfg, notion, { now: new Date(wed10.getTime() + 30 * 1000) });
    assert.ok(!notion.log.some((x) => x.startsWith("update")), "nothing sent inside the grace period");

    // 3. After the grace period it lands in Notion, merged with what was there.
    await flushQueue(dir, cfg, notion, { now: new Date(wed10.getTime() + GRACE_MS + 1000) });
    const live = notion.pages.get("a1").properties;
    assert.deepEqual(live["Touches Sent"].multi_select.map((o) => o.name).sort(), ["cdk-intro", "confirm"]);
    assert.equal(live.Stage.select.name, "Accepted");
    assert.equal(live["Last Contact"].date.start, "2026-10-21");
    assert.equal(loadStore(dir).notionQueue.length, 0);

    // 4. Same day: no night reminder right after the confirm. Re-sync keeps that.
    await syncNotion(dir, cfg, notion, { now: new Date("2026-10-21T22:00:00Z") });
    s = loadStore(dir);
    assert.equal(dueFor(s, s.leads.n_a1, "2026-10-21", { now: new Date("2026-10-21T22:00:00Z"), config: cfg }), null);

    // 5. Day of, 1 PM: the 2-hour reminder is due.
    const thu1pm = new Date("2026-10-22T17:00:00Z");
    assert.equal(dueFor(s, s.leads.n_a1, "2026-10-22", { now: thu1pm, config: cfg }).template, "reminder-2h");
    // ...and after 3 PM nothing is due until Jamal marks Showed or No-show.
    assert.equal(dueFor(s, s.leads.n_a1, "2026-10-22", { now: new Date("2026-10-22T19:30:00Z"), config: cfg }), null);

    // 6. She texts STOP: opt-out now, one line appended to Notes with the link kept.
    runAction("reply", { phone: "617-555-0123", text: "STOP" }, s, { now: thu1pm, config: cfg });
    saveStore(dir, s);
    await flushQueue(dir, cfg, notion, { now: new Date(thu1pm.getTime() + GRACE_MS + 1000) });
    const notes = notion.pages.get("a1").properties.Notes.rich_text;
    assert.equal(notes[1].text.link.url, "https://x.example", "existing link kept");
    assert.match(notes.map((t) => t.text.content).join(""), /Texts: replied STOP 2026-10-22\. Do not text\.$/);
    // Flushing the same note again never duplicates it.
    assert.deepEqual(buildUpdate({ set: {}, appendNote: "Texts: replied STOP 2026-10-22. Do not text." }, notion.pages.get("a1")), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("undo inside the window means Notion never hears about it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-undo-"));
  try {
    const notion = fakeNotion([page({ id: "a1", name: "Ana Diaz", stage: "Showed", requested: "2026-10-20T15:00:00.000-04:00" })]);
    const now = new Date("2026-10-21T14:00:00Z");
    saveStore(dir, EMPTY());
    await syncNotion(dir, cfg, notion, { now });
    const before = JSON.stringify(loadStore(dir));
    const s = loadStore(dir);
    runAction("sold", { leadId: "n_a1" }, s, { now, config: cfg });
    saveStore(dir, s);
    saveStore(dir, JSON.parse(before)); // what Undo does
    await flushQueue(dir, cfg, notion, { now: new Date(now.getTime() + GRACE_MS * 2) });
    assert.equal(notion.pages.get("a1").properties.Stage.select.name, "Showed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("client: friendly errors and retry on busy", async () => {
  let calls = 0;
  const busyThenOk = async () => {
    calls++;
    return calls === 1
      ? new Response("{}", { status: 429, headers: { "retry-after": "0" } })
      : new Response(JSON.stringify({ results: [{ id: "x" }], has_more: false }), { status: 200 });
  };
  const c = notionClient({ token: "t", fetchImpl: busyThenOk, sleep: async () => {} });
  assert.equal((await c.queryAll("db")).length, 1);
  assert.equal(calls, 2);
  const notShared = notionClient({ token: "t", fetchImpl: async () => new Response(JSON.stringify({ code: "object_not_found" }), { status: 404 }), sleep: async () => {} });
  await assert.rejects(notShared.queryAll("db"), /isn't shared with your Phone Agent integration/);
  assert.throws(() => notionClient({ token: "" }), /No Notion token/);
});

test("server: opening the Command Center pulls Notion and shows who's coming in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-srv-"));
  const notion = fakeNotion([page({ id: "a1", name: "Ana Diaz", vehicle: "Camry", source: "Instagram", requested: "2026-10-22T15:00:00.000-04:00" })]);
  const { server, port, key } = await startServer({ dataDir: dir, config: cfg, port: 0, nowFn: () => new Date("2026-10-21T14:00:00Z"), log: () => {}, notion });
  try {
    const get = (path, headers = {}) => new Promise((resolve, reject) => {
      request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
      }).on("error", reject).end();
    });
    const login = await get(`/?key=${key}`);
    const cookie = login.headers["set-cookie"][0].split(";")[0];
    const html = (await get("/", { cookie })).body;
    assert.ok(notion.log.includes("query"), "pulled on open");
    assert.ok(html.includes("Coming in") && html.includes("Ana Diaz") && html.includes("Needs confirm"));
    assert.ok(html.includes("Notion synced just now"));
    assert.ok(html.includes('id="replyForm"'));
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
