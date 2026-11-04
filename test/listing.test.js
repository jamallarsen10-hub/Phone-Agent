import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePrice, startPriceChange, markSigned, markLive, loadListing, checkReady } from "../src/listing/listing.js";
import { sellerText, sellerEmail, addendumHtml, packetHtml, offerFollowUp } from "../src/listing/packet.js";
import { collectPrivateTerms, scanText, streetTerms, isForbiddenPath } from "../src/listing/privacy.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src/cli.js");
const SAMPLE = join(ROOT, "examples/listing-sample.json");
const NOW = new Date("2026-11-04T19:00:00Z");

function withSample() {
  const dir = mkdtempSync(join(tmpdir(), "pa-listing-"));
  mkdirSync(join(dir, "data", "listings"), { recursive: true });
  copyFileSync(SAMPLE, join(dir, "data", "listings", "maple-st.json"));
  return dir;
}
const sample = (dir) => loadListing(join(dir, "data"), "maple-st");

test("parsePrice reads the ways people type prices", () => {
  assert.equal(parsePrice("339,900"), 339900);
  assert.equal(parsePrice("$339900"), 339900);
  assert.equal(parsePrice("339.9k"), 339900);
  assert.equal(parsePrice(339900), 339900);
  assert.equal(parsePrice("about 340"), null);
});

test("price change rejects typos and asks before replacing an unsigned change", () => {
  const dir = withSample();
  const l = sample(dir);
  assert.throws(() => startPriceChange(l, { to: "33990", now: NOW }), /typo/);
  assert.throws(() => startPriceChange(l, { to: "389000", now: NOW }), /already/);
  const { change, warnings } = startPriceChange(l, { to: "339900", now: NOW });
  assert.equal(change.from, 389000);
  assert.equal(change.pct, -12.6);
  assert.deepEqual(Object.keys(change.signatures), ["Pat Sample", "Robin Sample"]);
  assert.equal(warnings.length, 0);
  assert.throws(() => startPriceChange(l, { to: "349900", now: NOW }), /--replace/);
  assert.equal(startPriceChange(l, { to: "349900", now: NOW, replace: true }).change.to, 349900);
  rmSync(dir, { recursive: true });
});

test("goes live only after every seller signs", () => {
  const dir = withSample();
  const l = sample(dir);
  startPriceChange(l, { to: 339900, now: NOW });
  assert.equal(markSigned(l, "1", { now: NOW }).name, "Pat Sample");
  assert.throws(() => markLive(l, { now: NOW }), /Robin Sample/);
  assert.equal(markSigned(l, "robin", { now: NOW }).allSigned, true);
  markLive(l, { now: NOW });
  assert.equal(l.currentPrice, 339900);
  assert.equal(l.priceHistory.at(-1).price, 339900);
  rmSync(dir, { recursive: true });
});

test("messages carry the numbers and never invent a seller", () => {
  const dir = withSample();
  const l = sample(dir);
  startPriceChange(l, { to: 339900, now: NOW });
  const t = sellerText(l, l.pendingChange, l.sellers[0]);
  assert.match(t, /^Hi Pat, it's Jamal/);
  assert.match(t, /\$389,000 to \$339,900/);
  assert.match(t, /120 Example Maple St .* sold for \$315,000/);
  assert.match(sellerText(l, l.pendingChange, l.sellers[1]), /^Hi Mom, here’s where 100 Example Maple St stands\./);
  const e = sellerEmail(l, l.pendingChange, l.sellers[1]);
  assert.match(e.body, /^Hi Mom,/);
  assert.ok(!/\n\n\n/.test(e.body), "no stray blank lines");
  assert.match(e.subject, /\$339,900/);
  assert.match(e.body, /every owner signs/);
  const f = offerFollowUp(l, l.pendingChange, l.offers[0]);
  assert.match(f.body, /You were at \$275,000/);
  assert.match(f.body, /tenant-occupied/);
  const form = addendumHtml(l, { now: NOW });
  for (const s of ["Pat Sample", "Robin Sample", "$389,000", "$339,900", "X00000000"]) assert.ok(form.includes(s), s);
  const page = packetHtml(l, { now: NOW });
  assert.ok(page.includes("sms:+15550100001?&amp;body="), "tap-to-text for seller with a phone");
  assert.ok(page.includes("mailto:robin%40example.com"), "mail link for seller with email only");
  assert.ok(!page.includes("<script>alert"), "escaped");
  rmSync(dir, { recursive: true });
});

test("checkReady blocks a packet with no sellers or price", () => {
  const dir = withSample();
  const l = sample(dir);
  l.sellers = [];
  l.currentPrice = null;
  assert.deepEqual(checkReady(l).blocking, ["currentPrice (the live MLS price)", "at least one seller name"]);
  rmSync(dir, { recursive: true });
});

test("privacy: terms come from data/ and are found in text", () => {
  const dir = withSample();
  writeFileSync(join(dir, "data", "private-terms.txt"), "# extra\nSecret Project\n");
  writeFileSync(join(dir, "data", "store.json"), JSON.stringify({ leads: { a: { name: "Lena Customer", phone: "+16175550199" } } }));
  const terms = collectPrivateTerms(join(dir, "data"));
  assert.deepEqual(streetTerms("100 SW Birch Ln"), ["birch", "100 sw birch"]);
  const hits = (s) => scanText(s, terms).map((x) => x.kind);
  assert.deepEqual(hits("call Pat Sample tomorrow"), ["name", "name"]);
  assert.deepEqual(hits("cell (555) 010-0001"), ["seller phone"]);
  assert.deepEqual(hits("on Maple St"), ["private term"]);
  assert.deepEqual(hits("text Lena Customer at 617-555-0199"), ["name", "customer phone"]);
  assert.deepEqual(hits("the secret project"), ["private term"]);
  assert.deepEqual(hits("Patsy and Robinson"), [], "whole words only");
  assert.ok(scanText("x", terms).every((h) => !h.hint.includes("Sample")), "warning masks the value");
  rmSync(dir, { recursive: true });
});

test("privacy: forbidden paths", () => {
  for (const p of ["data/listings/x.json", "out/listings/x/packet.html", ".env", "sub/.env.local", "store.json"]) assert.ok(isForbiddenPath(p), p);
  for (const p of ["src/listing/cli.js", "examples/listing-sample.json", "README.md"]) assert.ok(!isForbiddenPath(p), p);
});

test("pre-commit guard blocks private data and allows clean commits", () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-guard-"));
  const repo = join(dir, "repo");
  cpSync(ROOT, repo, { recursive: true, filter: (s) => !/[\\/](\.git|data|out|node_modules)([\\/]|$)/.test(s.slice(ROOT.length)) });
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("config", "core.hooksPath", ".githooks");
  g("add", "-A");
  g("commit", "-qm", "base");
  mkdirSync(join(repo, "data", "listings"), { recursive: true });
  copyFileSync(SAMPLE, join(repo, "data", "listings", "maple-st.json"));

  writeFileSync(join(repo, "notes.md"), "Remember to call Robin Sample.\n");
  g("add", "notes.md");
  const blocked = spawnSync("git", ["-C", repo, "commit", "-m", "leak"], { encoding: "utf8" });
  assert.notEqual(blocked.status, 0, "commit with a seller name is blocked");
  assert.match(blocked.stderr, /notes\.md:1: name/);
  assert.ok(!blocked.stderr.includes("Robin Sample"), "does not echo the name");

  g("rm", "-q", "--cached", "notes.md");
  g("add", "-f", "data/listings/maple-st.json");
  const forced = spawnSync("git", ["-C", repo, "commit", "-m", "force"], { encoding: "utf8" });
  assert.notEqual(forced.status, 0, "force-added data/ is blocked");
  assert.match(forced.stderr, /private folder/);

  g("rm", "-q", "--cached", "data/listings/maple-st.json");
  writeFileSync(join(repo, "notes.md"), "Generic notes.\n");
  g("add", "notes.md");
  const ok = spawnSync("git", ["-C", repo, "commit", "-qm", "clean"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  rmSync(dir, { recursive: true, force: true });
});

test("cli: new -> price -> signed -> live writes the packet outside git", () => {
  const dir = withSample();
  const run = (...a) =>
    execFileSync(process.execPath, [CLI, ...a, "--now", "2026-11-04T14:00:00-05:00"], {
      env: { ...process.env, PHONE_AGENT_DATA: join(dir, "data"), PHONE_AGENT_OUT: join(dir, "out") },
      encoding: "utf8",
    });
  assert.match(run("listing", "new", "elm-st", "--address", "1 Elm St", "--price", "300k"), /Created/);
  assert.match(run("listing", "price", "maple-st", "339,900", "--reason", "comps"), /\$389,000 -> \$339,900 \(-12.6%\)/);
  assert.ok(existsSync(join(dir, "out", "listings", "maple-st", "packet.html")));
  assert.ok(existsSync(join(dir, "out", "listings", "maple-st", "addendum.html")));
  assert.match(readFileSync(join(dir, "out", "listings", "maple-st", "messages.txt"), "utf8"), /TEXT to Pat Sample/);
  assert.match(run("listing", "signed", "maple-st", "1"), /Waiting on: Robin Sample/);
  assert.match(run("listing", "signed", "maple-st", "Robin"), /Everyone signed/);
  assert.match(run("listing", "live", "maple-st"), /1 buyer follow-up ready/);
  assert.match(run("listing"), /maple-st: .* listed at \$339,900/);
  rmSync(dir, { recursive: true });
});
