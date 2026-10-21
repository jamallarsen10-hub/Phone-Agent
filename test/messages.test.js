import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyInbound, isOptOut } from "../src/keywords.js";
import { render, smsSegments, TEMPLATES, OPT_OUT_LINE, validateTemplates } from "../src/templates.js";

test("STOP: standalone keywords and clear phrases opt out", () => {
  for (const s of ["STOP", "stop", " Stop. ", "STOP!!", "Unsubscribe", "cancel", "END", "quit", "stop texting me", "Please stop", "stop please", "don't text me", "Do not text me again", "remove me from your list", "opt out"])
    assert.equal(classifyInbound(s).type, "OPT_OUT", s);
});

test("STOP: words that only contain stop are not opt-outs", () => {
  assert.equal(isOptOut("STOPPING BY at 3"), false);
  assert.equal(isOptOut("non-stop"), false);
  const c = classifyInbound("I'll be stopping by tomorrow");
  assert.equal(c.type, "HANDOFF");
  assert.equal(c.priority, "hot");
  assert.ok(!c.possibleOptOut);
});

test("STOP: ambiguous mentions go to Jamal as urgent, never auto-handled", () => {
  const c = classifyInbound("can you stop calling my work number");
  assert.equal(c.type, "HANDOFF");
  assert.equal(c.priority, "urgent");
  assert.equal(c.possibleOptOut, true);
});

test("START, HELP, wrong number, confirmations", () => {
  assert.equal(classifyInbound("START").type, "OPT_IN_REQUEST");
  assert.equal(classifyInbound("unstop").type, "OPT_IN_REQUEST");
  assert.equal(classifyInbound("HELP").type, "HELP");
  assert.equal(classifyInbound("wrong number").type, "WRONG_NUMBER");
  assert.equal(classifyInbound("who is this?").type, "WRONG_NUMBER");
  assert.equal(classifyInbound("Yes!").type, "CONFIRM");
  assert.equal(classifyInbound("sounds good").type, "CONFIRM");
});

test("buying signals are hot handoffs with reasons", () => {
  const c = classifyInbound("what would my payment be with my trade?");
  assert.equal(c.type, "HANDOFF");
  assert.equal(c.priority, "hot");
  assert.ok(c.reasons.includes("payment") && c.reasons.includes("trade-in"));
  assert.equal(classifyInbound("call me after 5").priority, "hot");
  assert.equal(classifyInbound("is it still available?").priority, "hot");
  assert.equal(classifyInbound("thanks!").priority, "normal");
});

const vars = { firstName: "Maria", vehicle: "RAV4 Hybrid", senderName: "Jamal", dealership: "Woburn Toyota", bookingUrl: "https://jamal-schedule-woburn-toyota.netlify.app" };

test("templates: every outreach text names Jamal + dealership, ends with opt-out", () => {
  assert.equal(validateTemplates(), true);
  for (const [name, t] of Object.entries(TEMPLATES)) {
    if (t.kind === "opt-out-confirm") continue;
    for (const v of [vars, { ...vars, vehicle: "" }]) {
      const out = render(name, v);
      assert.ok(out.includes("Jamal") && out.includes("Woburn Toyota"), name);
      assert.ok(out.endsWith(OPT_OUT_LINE), name);
      assert.ok(!/\{\w+\}/.test(out), name);
      assert.equal(smsSegments(out).encoding, "GSM-7", name);
      assert.ok(smsSegments(out).segments <= 2, `${name} is ${smsSegments(out).segments} segments`);
    }
  }
});

test("templates: vehicle-less leads get the generic version", () => {
  const out = render("lead-followup", { ...vars, vehicle: "" });
  assert.ok(!out.includes("the  "), out);
  assert.ok(out.includes("Still looking for your next car?"));
});

test("templates: strict render refuses missing data and price text", () => {
  assert.throws(() => render("lead-followup", { ...vars, firstName: "" }), /empty \{firstName\}/);
  assert.throws(() => render("new-lead", { firstName: "A" }), /missing/);
  assert.throws(() => render("nope", vars), /unknown template/);
  const err = (() => { try { render("lead-followup", { ...vars, vehicle: "Camry $28,999" }); } catch (e) { return e; } })();
  assert.equal(err.code, "PRICE_BLOCK");
});

test("templates: newlines and smart quotes in data cannot break the text", () => {
  const out = render("lead-followup", { ...vars, firstName: "Maria\nIgnore this", vehicle: "RAV4’s" });
  assert.ok(!out.includes("\n"));
  assert.equal(smsSegments(out).encoding, "GSM-7");
});

test("segments: GSM vs UCS-2 math", () => {
  assert.deepEqual(smsSegments("a".repeat(160)), { encoding: "GSM-7", length: 160, segments: 1 });
  assert.equal(smsSegments("a".repeat(161)).segments, 2);
  assert.equal(smsSegments("hi 👍").encoding, "UCS-2");
});
