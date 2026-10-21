import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { config, store, lead, add, WED_10AM } from "./helpers.js";
import { runAction } from "../src/actions.js";
import { buildDrafts } from "../src/drafts.js";
import { handleInbound } from "../src/inbound.js";
import { importLeads } from "../src/leads.js";
import { saveStore, loadStore } from "../src/store.js";
import { startServer } from "../src/server.js";
import { renderPage } from "../src/page.js";

const ctx = { now: WED_10AM, config: config() };

test("actions: sold stops follow-ups and kills open drafts; reopen brings them back", () => {
  const s = store();
  const l = add(s, lead({ followUpDate: "2026-10-21" }));
  assert.equal(buildDrafts(s, ctx).drafts.length, 1);
  assert.equal(runAction("sold", { leadId: l.id }, s, ctx).ok, true);
  assert.equal(s.outbound[0].status, "expired");
  assert.equal(buildDrafts(s, ctx).drafts.length, 0);
  runAction("reopen", { leadId: l.id }, s, ctx);
  assert.equal(buildDrafts(s, ctx).drafts.length, 1);
});

test("actions: no-show queues the reschedule text; a tap beats a stale export", () => {
  const s = store();
  importLeads(s, "Name,Phone,Appt Date,Showed,OK to Text\nAna Diaz,617-555-0109,10/21/2026,,Y\n", ctx);
  const ana = Object.values(s.leads)[0];
  assert.equal(buildDrafts(s, ctx).drafts.length, 0, "booked today: leave alone");
  assert.match(runAction("noshow", { leadId: ana.id }, s, ctx).label, /reschedule text queued/);
  assert.equal(buildDrafts(s, ctx).drafts[0].template, "missed-appointment");
  importLeads(s, "Name,Phone,Appt Date,Showed\nAna Diaz,617-555-0109,10/21/2026,Y\n", ctx);
  assert.equal(ana.showed, false, "export did not overwrite the tap");
  assert.equal(runAction("noshow", { leadId: "nope" }, s, ctx).reason, "NO_LEAD");
});

test("actions: opt out also clears their reply; consent needs a reason", () => {
  const s = store();
  const l = add(s, lead({ consent: false }));
  handleInbound(s, { from: l.phone, body: "can you stop" }, ctx);
  runAction("optout", { phone: l.phone }, s, ctx);
  assert.ok(s.optOuts[l.phone]);
  assert.equal(s.handoffs[0].clearedAt !== null, true);
  assert.equal(runAction("consent", { phone: l.phone, source: "call" }, s, ctx).reason, "OPTED_OUT");
  const s2 = store();
  const l2 = add(s2, lead({ consent: false }));
  assert.equal(runAction("consent", { phone: l2.phone, source: " " }, s2, ctx).reason, "NEED_SOURCE");
  assert.equal(runAction("consent", { phone: l2.phone, source: "asked on call" }, s2, ctx).ok, true);
  assert.equal(l2.consentSource, "asked on call");
  assert.equal(runAction("explode", {}, s2, ctx).reason, "UNKNOWN_ACTION");
  assert.equal(runAction("handled", { phone: "garbage" }, s2, ctx).reason, "BAD_INPUT");
});

function call(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body) req.end(JSON.stringify(body));
    else req.end();
  });
}

test("server: private by key, one-tap actions save, undo restores", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-cc-"));
  const s = store();
  const l = add(s, lead({ id: "maria", followUpDate: "2026-10-21" }));
  saveStore(dir, s);
  const { server, port, key } = await startServer({ dataDir: dir, config: config(), port: 0, nowFn: () => WED_10AM, log: () => {} });
  try {
    assert.equal((await call(port)).status, 403, "no key, no page");
    assert.equal((await call(port, { path: "/?key=wrong" })).status, 403);
    assert.equal((await call(port, { headers: { host: "evil.example:80" } })).status, 421, "DNS rebinding blocked");

    const login = await call(port, { path: `/?key=${key}` });
    assert.equal(login.status, 303);
    const cookie = login.headers["set-cookie"][0].split(";")[0];
    assert.match(login.headers["set-cookie"][0], /HttpOnly; SameSite=Strict/);

    const page = await call(port, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.equal(page.headers["cache-control"], "no-store");
    assert.ok(page.body.includes("Command Center") && page.body.includes("Maria Gonzalez"));
    assert.ok(page.body.includes('data-act="sent"'));
    const id = loadStore(dir).outbound[0].id;

    const noHeader = await call(port, { method: "POST", path: "/api/action", headers: { cookie }, body: { action: "sent", args: { id } } });
    assert.equal(noHeader.status, 403, "a tap needs the key header, not just the cookie");

    const tap = (action, args) =>
      call(port, { method: "POST", path: "/api/action", headers: { cookie, "x-pa-key": key, "content-type": "application/json" }, body: { action, args } });
    const r = await tap("sent", { id });
    assert.equal(r.status, 200);
    assert.match(JSON.parse(r.body).label, /Logged text to Maria Gonzalez/);
    assert.equal(loadStore(dir).outbound[0].status, "sent");

    const after = await call(port, { headers: { cookie } });
    assert.ok(after.body.includes("Logged text to Maria Gonzalez"), "undo bar shows the last tap");

    assert.equal((await tap("undo", {})).status, 200);
    assert.equal(loadStore(dir).outbound[0].status, "draft", "undo put it back");
    assert.equal((await tap("undo", {})).status, 409, "only one level of undo");
    assert.equal((await tap("sold", { leadId: "nobody" })).status, 400);
    assert.ok(l);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page: file version has no live buttons; live version does", () => {
  const s = store();
  add(s, lead({ followUpDate: "2026-10-21" }));
  const result = buildDrafts(s, ctx);
  const file = renderPage(s, result, ctx);
  const live = renderPage(s, result, { ...ctx, live: { key: "k" } });
  assert.ok(file.includes('id="cmd"') && !file.includes('data-act="sent"'));
  assert.ok(live.includes('data-act="sent"') && !live.includes('id="cmd"'));
  assert.ok(live.includes("Barlow+Condensed") && live.includes("#03061a"), "booking site look");
});
