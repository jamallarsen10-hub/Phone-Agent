#!/usr/bin/env node
/**
 * Pre-commit privacy guard. Runs from .githooks/pre-commit.
 *
 *   node scripts/privacy-guard.js          check what's staged (the hook)
 *   node scripts/privacy-guard.js --all    audit every tracked file
 *
 * Exit 1 blocks the commit and says which file and line to fix. Nothing about
 * your deals or customers is printed in full.
 */
import { execFileSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectPrivateTerms, termCount, scanText, isForbiddenPath } from "../src/listing/privacy.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = resolve(process.env.PHONE_AGENT_DATA || join(ROOT, "data"));
const all = process.argv.includes("--all");

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const files = (all ? git("ls-files", "-z") : git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"))
  .split("\0")
  .filter(Boolean);

const terms = collectPrivateTerms(DATA);
const problems = [];

for (const f of files) {
  if (isForbiddenPath(f)) {
    problems.push(`${f}: private folder or file. Unstage it: git rm --cached "${f}"`);
    continue;
  }
  let text;
  try {
    text = all ? git("show", `HEAD:${f}`) : git("show", `:${f}`);
  } catch {
    continue;
  }
  if (text.includes("\0")) continue; // binary
  for (const h of scanText(text, terms)) problems.push(`${f}:${h.line}: ${h.kind} (${h.hint})`);
}

if (problems.length) {
  console.error("\nPrivacy guard: this commit would publish private data. Nothing was committed.\n");
  for (const p of problems.slice(0, 40)) console.error("  " + p);
  if (problems.length > 40) console.error(`  ...and ${problems.length - 40} more`);
  console.error("\nKeep real names, numbers and addresses in data/ (never committed). Use fake ones in examples/ and tests.\n");
  process.exit(1);
}
if (all) console.log(`Privacy audit: ${files.length} tracked files clean against ${termCount(terms)} private terms.`);
