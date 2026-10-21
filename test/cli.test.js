import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const SAMPLE = fileURLToPath(new URL("../examples/cdk-export-sample.csv", import.meta.url));
const NOW = ["--now", "2026-10-21T10:00:00-04:00"];

function run(dir, ...args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, PHONE_AGENT_DATA: join(dir, "data"), PHONE_AGENT_OUT: join(dir, "out"), KILL_SWITCH: "" },
    encoding: "utf8",
  });
}

test("cli: full day on the sample export", () => {
  const dir = mkdtempSync(join(tmpdir(), "phone-agent-"));
  try {
    assert.match(run(dir, "import", SAMPLE, ...NOW), /10 rows: 10 new/);

    const out = run(dir, "drafts", ...NOW);
    assert.match(out, /2026-10-21: 5 to text, 0 replies waiting, 1 to call/);
    const page = readFileSync(join(dir, "out", "today.html"), "utf8");
    for (const name of ["Ashley Brooks", "Kevin Patel", "Derek Chen", "Maria Gonzalez"]) assert.ok(page.includes(name), name);
    assert.ok(!page.includes("Sam Ortiz"), "sold lead is not texted");
    assert.ok(page.includes("sms:+15085550103?&amp;body="), "tap-to-text link");
    assert.ok(existsSync(join(dir, "out", "drafts-2026-10-21.csv")));

    const ids = [...out.matchAll(/\[([0-9a-f]{6,})\]/g)].map((m) => m[1]);
    assert.equal(ids.length, 5);
    assert.match(run(dir, "sent", ids[0], ids[1], ...NOW), /Logged 2 sent/);
    assert.match(run(dir, "drafts", ...NOW), /3 to text/);

    assert.match(run(dir, "reply", "617-555-0101", "how much would my payment be?", ...NOW), /HOT — .*payment/);
    assert.match(run(dir, "reply", "781-555-0102", "STOP", ...NOW), /opted out/);
    const after = run(dir, "drafts", ...NOW);
    assert.match(after, /2 to text, 1 reply waiting/);
    assert.ok(!/Derek Chen — new lead/.test(after), "opted-out lead dropped from the list");
    assert.match(after, /they texted STOP/, "one opt-out confirmation drafted");

    assert.match(run(dir, "consent", "617-555-0105", "--source", "asked on call", ...NOW), /Tom Rivera/);
    assert.match(run(dir, "status", ...NOW), /Opted out numbers: 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: kill switch shows on the page", () => {
  const dir = mkdtempSync(join(tmpdir(), "phone-agent-"));
  try {
    run(dir, "import", SAMPLE, ...NOW);
    const out = execFileSync(process.execPath, [CLI, "drafts", ...NOW], {
      env: { ...process.env, PHONE_AGENT_DATA: join(dir, "data"), PHONE_AGENT_OUT: join(dir, "out"), KILL_SWITCH: "true" },
      encoding: "utf8",
    });
    assert.match(out, /0 to text/);
    assert.match(out, /KILL SWITCH IS ON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
