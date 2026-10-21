import { execFile } from "node:child_process";
import { isE164US } from "../phone.js";

/**
 * Sends a text through the Messages app on a Mac, which relays it as a normal
 * SMS from the iPhone signed in to the same Apple ID (Text Message Forwarding).
 * Same provider shape as the dry-run one: { name, send({ to, body, idempotencyKey }) }.
 *
 * What this can and cannot tell you:
 *  - osascript only reports that Messages accepted the text. Delivery cannot be
 *    read back, and iMessage can silently take over from SMS. So any error is
 *    treated as "outcome unknown": sendDraft marks it failed and NEVER retries.
 *  - It was written on Linux and has not been run against a real Messages app.
 *    The first live test on the Mac decides whether this SMS path works on the
 *    macOS version installed there.
 *
 * Safety: the phone number and the message are passed to AppleScript as
 * arguments (`on run argv`), never spliced into the script text, so nothing a
 * customer's name or a template contains can change what the script does.
 */

const MAX_BODY = 640; // four segments; every shipped template is far shorter
const DEFAULT_GAP_MS = 5000;
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * THE ONE PLACE TO ADJUST if the first live test fails (research notes):
 *  - Pick the SMS account with `1st account whose service type = SMS`.
 *    Verified on macOS 15.5: the older `service` class fails there with
 *    -10000 (AppleEvent handler failed); `account` works. Leaving the
 *    account out sends as iMessage instead of SMS.
 *  - `participant <phone> of s` (verified on macOS 15.5). `buddy` is the
 *    pre-Big Sur form.
 *  - Messages must be running, so it is launched first.
 * The script is a fixed list of lines. Nothing from a customer or a template
 * is ever added to it.
 */
export const APPLESCRIPT_LINES = Object.freeze([
  "on run argv",
  "set thePhone to item 1 of argv",
  "set theBody to item 2 of argv",
  'tell application "Messages" to launch',
  "delay 1",
  'tell application "Messages"',
  "set s to 1st account whose service type = SMS",
  "set b to participant thePhone of s",
  "send theBody to b",
  "end tell",
  "end run",
]);

/** Builds the osascript argument list: static script, then phone, then body. */
export function buildOsascriptArgs(phone, body) {
  const args = [];
  for (const line of APPLESCRIPT_LINES) args.push("-e", line);
  // The phone is first, and always starts with "+", so osascript's option
  // parsing stops there and the body is taken as plain data even if it starts with "-".
  args.push(phone, body);
  return args;
}

function defaultExec(file, args, { timeout }) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message || "").trim().slice(0, 300);
        return reject(new Error(detail || "osascript failed"));
      }
      resolve({ stdout: String(stdout || "") });
    });
  });
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} [o]
 * @param {Function} [o.exec]      (file, args, { timeout }) => Promise; injectable so tests never run osascript
 * @param {string}   [o.platform]  injectable for tests
 * @param {number}   [o.gapMs]     minimum pause between two sends
 * @param {Function} [o.sleep]     injectable for tests
 * @param {Function} [o.clock]     injectable for tests; returns ms
 */
export function macMessagesProvider({
  exec = defaultExec,
  platform = process.platform,
  gapMs = DEFAULT_GAP_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sleep = defaultSleep,
  clock = Date.now,
} = {}) {
  if (platform !== "darwin") throw new Error("Mac Messages sending only works on a Mac (this is " + platform + ")");

  let lastSendAt = null;

  return {
    name: "mac-messages",
    async send({ to, body, idempotencyKey }) {
      if (!isE164US(to)) throw new Error(`not a valid US number: ${String(to)}`);
      if (typeof body !== "string" || !body.trim()) throw new Error("empty message");
      if (body.length > MAX_BODY) throw new Error(`message too long (${body.length} > ${MAX_BODY})`);
      if (body.includes("\0")) throw new Error("message contains a NUL character");

      // A few seconds between consecutive sends, so Messages is never hammered.
      if (lastSendAt !== null) {
        const wait = gapMs - (clock() - lastSendAt);
        if (wait > 0) await sleep(wait);
      }
      lastSendAt = clock();

      await exec("osascript", buildOsascriptArgs(to, body), { timeout: timeoutMs });
      return { id: "mac-" + idempotencyKey };
    },
  };
}
