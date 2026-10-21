import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Defaults. Override any of these in data/config.json (gitignored) or with
 * the env vars noted below. Sending hours are a guess until Jamal confirms.
 */
export const DEFAULTS = Object.freeze({
  timeZone: "America/New_York",
  // 0 = Sunday ... 6 = Saturday. Texts only go out on these days.
  sendDays: [1, 2, 3, 4, 5, 6],
  sendStart: "09:00",
  sendEnd: "20:00",
  // Hard cap per phone number per local day, across every lead on that number.
  maxPerPhonePerDay: 1,
  // A routine follow-up waits this many days after any earlier text to the number.
  minDaysBetweenFollowups: 2,
  senderName: "Jamal",
  dealership: "Woburn Toyota",
  bookingUrl: "https://jamal-schedule-woburn-toyota.netlify.app",
  // "drafts" = Jamal sends from his own phone. "auto" needs a real provider.
  mode: "drafts",
  killSwitch: false,
});

export function loadConfig(dataDir, env = process.env) {
  let fileCfg = {};
  const path = join(dataDir, "config.json");
  if (existsSync(path)) {
    try {
      fileCfg = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new Error(`data/config.json is not valid JSON: ${e.message}`);
    }
  }
  const cfg = { ...DEFAULTS, ...fileCfg };
  // KILL_SWITCH=true in the environment always wins: it can stop sends, never start them.
  if (/^(1|true|yes|on)$/i.test(env.KILL_SWITCH || "")) cfg.killSwitch = true;
  if (env.BOOKING_URL) cfg.bookingUrl = env.BOOKING_URL;
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg) {
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!hhmm.test(cfg.sendStart) || !hhmm.test(cfg.sendEnd))
    throw new Error("sendStart/sendEnd must be HH:MM (24h)");
  if (cfg.sendStart >= cfg.sendEnd) throw new Error("sendStart must be before sendEnd");
  if (!Array.isArray(cfg.sendDays) || cfg.sendDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
    throw new Error("sendDays must be weekday numbers 0-6");
  if (!["drafts", "auto"].includes(cfg.mode)) throw new Error('mode must be "drafts" or "auto"');
  if (!(cfg.maxPerPhonePerDay >= 1)) throw new Error("maxPerPhonePerDay must be at least 1");
}
