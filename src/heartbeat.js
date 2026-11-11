import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The auto sender's pulse. `auto` writes data/heartbeat.json after every pass
 * (about once a minute), so `status` from the phone can tell Jamal whether the
 * Mac is actually sending, asleep, or stopped after a failed text.
 * No customer data goes in here: only times, counts and a short reason.
 */
const FILE = "heartbeat.json";
const STALE_MIN = 10;

export function writeHeartbeat(dataDir, beat) {
  const path = join(dataDir, FILE);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify({ ...beat, pid: process.pid }, null, 2));
  renameSync(tmp, path);
}

export function readHeartbeat(dataDir) {
  const path = join(dataDir, FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const ago = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

/** One plain line for the phone. */
export function heartbeatLine(beat, now = new Date()) {
  if (!beat || !beat.at) return "Auto sender: never ran on this Mac yet";
  const age = now.getTime() - Date.parse(beat.at);
  if (beat.state === "stopped")
    return `Auto sender: STOPPED ${ago(age)} after a failed text (${beat.note || "check Messages"}). It restarts in a few minutes; check that text by hand.`;
  if (age > STALE_MIN * 60000)
    return `Auto sender: SILENT, last check ${ago(age)}. The Mac may be asleep, off, or offline.`;
  return `Auto sender: running, last check ${ago(age)}${beat.live ? "" : " (dry run, texting no one)"}. Sent today: ${beat.sentToday ?? 0}`;
}
