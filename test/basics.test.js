import { test } from "node:test";
import assert from "node:assert/strict";
import { toE164, prettyPhone } from "../src/phone.js";
import { parseDate, daysBetween, addDays, localParts } from "../src/dates.js";
import { parseCSV, parseCSVObjects, toCSV } from "../src/csv.js";
import { priceFlags } from "../src/priceBlock.js";

test("phone: normalizes common US formats to E.164", () => {
  for (const raw of ["(617) 555-0101", "617-555-0101", "617.555.0101", "6175550101", "+1 617 555 0101", "1-617-555-0101", "617-555-0101 x22"])
    assert.equal(toE164(raw), "+16175550101", raw);
});

test("phone: rejects numbers that could reach a stranger", () => {
  for (const raw of ["555-1234", "017-555-0101", "617-055-0101", "+44 20 7946 0958", "", null, "61755501011", "not a phone"])
    assert.equal(toE164(raw), null, String(raw));
  assert.equal(prettyPhone("+16175550101"), "(617) 555-0101");
});

test("dates: parses DMS export formats, refuses impossible dates", () => {
  assert.equal(parseDate("10/20/2026"), "2026-10-20");
  assert.equal(parseDate("1/5/26"), "2026-01-05");
  assert.equal(parseDate("2026-10-20T15:30:00"), "2026-10-20");
  assert.equal(parseDate("10/20/2026 3:30 PM"), "2026-10-20");
  assert.equal(parseDate("02/30/2026"), null);
  assert.equal(parseDate("next tuesday"), null);
  assert.equal(daysBetween("2026-10-19", "2026-10-21"), 2);
  assert.equal(daysBetween("2026-11-01", "2026-11-02"), 1); // across the DST change
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("dates: local time is dealership time on both sides of DST", () => {
  assert.deepEqual(localParts(new Date("2026-10-21T14:00:00Z"), "America/New_York"), { date: "2026-10-21", time: "10:00", weekday: 3 });
  assert.deepEqual(localParts(new Date("2026-11-10T15:00:00Z"), "America/New_York"), { date: "2026-11-10", time: "10:00", weekday: 2 });
  // 1 AM UTC is still the previous evening in Woburn.
  assert.equal(localParts(new Date("2026-10-22T01:00:00Z"), "America/New_York").date, "2026-10-21");
});

test("csv: quotes, embedded commas/newlines, BOM, CRLF", () => {
  const text = '﻿Name,Notes\r\n"Lee, Jordan","said ""call me""\nafter 5"\r\nAna,ok\r\n';
  assert.deepEqual(parseCSV(text), [["Name", "Notes"], ["Lee, Jordan", 'said "call me"\nafter 5'], ["Ana", "ok"]]);
  const { records } = parseCSVObjects(text);
  assert.equal(records[0].Name, "Lee, Jordan");
  assert.throws(() => parseCSV('a,"unclosed'), /unclosed/);
});

test("csv: output neutralizes spreadsheet formulas", () => {
  const out = toCSV(["a"], [{ a: "=HYPERLINK(\"x\")" }]);
  assert.match(out, /^a\r\n"'=HYPERLINK/);
});

test("price block: catches prices, payments, rates, promises", () => {
  for (const s of ["It's $28,500", "only 399/mo", "0% APR", "21,358 off", "we can do a discount", "your trade value is", "guaranteed approval", "out the door", "per month"])
    assert.ok(priceFlags(s).length, s);
  for (const s of ["Hi Maria, it's Jamal at Woburn Toyota.", "Want to set a time to see it?", "Reply STOP to opt out."])
    assert.deepEqual(priceFlags(s), [], s);
});
