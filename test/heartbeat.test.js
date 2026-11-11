import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHeartbeat, readHeartbeat, heartbeatLine } from "../src/heartbeat.js";

const now = new Date("2026-11-11T15:00:00Z");

test("heartbeat round-trips and reads as running", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  assert.equal(readHeartbeat(dir), null);
  writeHeartbeat(dir, { at: "2026-11-11T14:58:00Z", live: true, state: "ok", sentToday: 3 });
  const line = heartbeatLine(readHeartbeat(dir), now);
  assert.match(line, /running, last check 2 min ago\. Sent today: 3\./);
});

test("silent Mac and stopped sender are called out plainly", () => {
  assert.match(heartbeatLine(null, now), /never ran/);
  assert.match(heartbeatLine({ at: "2026-11-11T14:30:00Z", state: "ok" }, now), /SILENT, last check 30 min ago.*asleep/);
  assert.match(heartbeatLine({ at: "2026-11-11T14:59:00Z", state: "stopped", note: "Messages error" }, now), /STOPPED .*Messages error/);
  assert.match(heartbeatLine({ at: "2026-11-11T14:59:30Z", state: "ok", live: false }, now), /dry run/);
});

test("blocked Messages access is spelled out", () => {
  assert.match(heartbeatLine({ at: "2026-11-11T14:59:00Z", state: "ok", live: true, replies: "blocked" }, now), /Full Disk Access/);
});
