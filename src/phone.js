/**
 * US phone normalization. Returns +1XXXXXXXXXX or null.
 * Rejects anything that is not a dialable NANP number, because texting a
 * malformed number is how a message lands on a stranger's phone.
 */
export function toE164(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Drop extensions like "x123" or "ext. 4" before counting digits.
  const main = s.split(/\s*(?:x|ext\.?|extension)\s*\d+\s*$/i)[0];
  let digits = main.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  // NANP: area code and exchange both start 2-9.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;
  return "+1" + digits;
}

export function isE164US(p) {
  return typeof p === "string" && /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(p);
}

/** (617) 555-0123 for display. */
export function prettyPhone(e164) {
  if (!isE164US(e164)) return e164 || "";
  const d = e164.slice(2);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
