/**
 * Date helpers. Everything compares plain YYYY-MM-DD strings in dealership
 * time, so a lead's follow-up date means the same day in Woburn no matter
 * which machine runs the script or what the server clock's zone is.
 */

/** Local parts of an instant in a time zone. */
export function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${hour}:${get("minute")}`,
    weekday: weekdays[get("weekday")],
  };
}

export function localDate(date, timeZone) {
  return localParts(date, timeZone).date;
}

function toUTCDays(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

/** Whole days from a to b (b - a). */
export function daysBetween(a, b) {
  return Math.round(toUTCDays(b) - toUTCDays(a));
}

export function addDays(ymd, n) {
  const t = new Date((toUTCDays(ymd) + n) * 86400000);
  return t.toISOString().slice(0, 10);
}

export function isValidYMD(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * Parse the date formats a DMS export tends to use into YYYY-MM-DD.
 * Accepts 2026-10-20, 10/20/2026, 10/20/26, 10-20-2026, each optionally
 * followed by a time (ignored). Returns null when unsure rather than guessing.
 */
export function parseDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (m) {
    const ymd = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    return isValidYMD(ymd) ? ymd : null;
  }
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})(?:\s.*)?$/);
  if (m) {
    const year = m[3].length === 2 ? "20" + m[3] : m[3];
    const ymd = `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    return isValidYMD(ymd) ? ymd : null;
  }
  return null;
}
