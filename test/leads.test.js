import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { store } from "./helpers.js";
import { importLeads, mapColumns, firstNameOf, parseYesNo } from "../src/leads.js";

const sample = readFileSync(new URL("../examples/cdk-export-sample.csv", import.meta.url), "utf8");
const at = { now: new Date("2026-10-21T14:00:00Z"), sourceFile: "sample.csv" };

test("import: maps CDK-style headers", () => {
  const cols = mapColumns(["Customer Name", "Cell Phone", "Vehicle of Interest", "Next Follow Up", "OK to Text", "Appt Date"]);
  assert.equal(cols.name, "Customer Name");
  assert.equal(cols.phone, "Cell Phone");
  assert.equal(cols.followUpDate, "Next Follow Up");
  assert.equal(cols.consent, "OK to Text");
  assert.equal(cols.appointmentDate, "Appt Date");
});

test("import: sample file loads every row, flags shared and bad phones", () => {
  const s = store();
  const r = importLeads(s, sample, at);
  assert.equal(r.rows, 10);
  assert.equal(r.added, 10);
  assert.equal(r.badPhone, 1);
  assert.equal(r.sharedPhone, 2);
  assert.equal(r.consentYes, 9);
  assert.deepEqual(r.warnings, []);
  const kevin = Object.values(s.leads).find((l) => l.name === "Kevin Patel");
  assert.equal(kevin.phone, "+13395550104");
  assert.equal(kevin.testDriveDate, "2026-10-21");
});

test("import: re-import updates in place, never deletes, blanks don't erase", () => {
  const s = store();
  importLeads(s, sample, at);
  const before = Object.keys(s.leads).length;
  const update = "Customer Name,Cell Phone,Vehicle of Interest,Next Follow Up\nMaria Gonzalez,617-555-0101,,10/28/2026\n";
  const r = importLeads(s, update, at);
  assert.equal(r.updated, 1);
  assert.equal(Object.keys(s.leads).length, before);
  const maria = Object.values(s.leads).find((l) => l.name === "Maria Gonzalez");
  assert.equal(maria.followUpDate, "2026-10-28");
  assert.equal(maria.vehicle, "RAV4 Hybrid", "blank cell kept the old vehicle");
  assert.equal(maria.consent, true, "no consent column means consent unchanged");
});

test("import: consent only from an explicit yes; explicit no revokes", () => {
  const s = store();
  importLeads(s, "Name,Phone\nAna Diaz,617-555-0109\n", at);
  const ana = Object.values(s.leads)[0];
  assert.equal(ana.consent, false);
  importLeads(s, "Name,Phone,SMS Consent\nAna Diaz,617-555-0109,maybe\n", at);
  assert.equal(ana.consent, false);
  importLeads(s, "Name,Phone,SMS Consent\nAna Diaz,617-555-0109,Yes\n", at);
  assert.equal(ana.consent, true);
  assert.match(ana.consentSource, /export/);
  importLeads(s, "Name,Phone,SMS Consent\nAna Diaz,617-555-0109,No\n", at);
  assert.equal(ana.consent, false);
});

test("import: warns when the file can't support texting", () => {
  const r = importLeads(store(), "Customer,Email\nA B,a@b.com\n", at);
  assert.ok(r.warnings.some((w) => /phone/.test(w)));
  assert.ok(r.warnings.some((w) => /consent/.test(w)));
});

test("names and yes/no cells", () => {
  assert.equal(firstNameOf({ name: "jordan lee" }), "Jordan");
  assert.equal(firstNameOf({ name: "J" }), "there");
  assert.equal(firstNameOf({ name: "" }), "there");
  assert.equal(firstNameOf({ name: "MARY-KATE O'NEIL" }), "Mary-Kate");
  assert.equal(parseYesNo("Y"), true);
  assert.equal(parseYesNo("opted out"), false);
  assert.equal(parseYesNo(""), null);
});
