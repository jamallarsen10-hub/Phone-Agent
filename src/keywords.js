/**
 * Classify an inbound text. Pure function, no side effects.
 *
 * Rules (from the design notes):
 *  - Opt-out keywords count only as the whole message or a clear "stop
 *    texting me" phrase. "Stopping by at 3" is NOT an opt-out.
 *  - A message that mentions stop/unsubscribe but is not clearly an opt-out
 *    goes to Jamal flagged possibleOptOut, and all automated texts to that
 *    number hold until he clears it. Wrong either way costs nothing.
 *  - START after STOP never auto-resumes. Jamal confirms by hand.
 *  - Money, trade, credit or "call me" questions are buying signals: hot handoff.
 */

// CTIA standard opt-out words, matched as the entire message.
const OPT_OUT_WORDS = new Set([
  "STOP", "STOPALL", "STOP ALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT",
  "OPTOUT", "OPT OUT", "OPT-OUT", "REVOKE", "REMOVE", "REMOVE ME",
]);

const OPT_OUT_PHRASES = [
  /^(?:please\s+)?stop(?:\s+(?:texting|messaging|contacting|sending|txting))?(?:\s+(?:me|this number|messages))?(?:\s+please)?$/,
  /^(?:please\s+)?(?:do not|dont|don't|no more)\s+(?:text|texts|message|messages|contact)(?:\s+me)?(?:\s+(?:again|anymore|please))*$/,
  /^(?:please\s+)?(?:remove|take)\s+me\s+(?:off|from)(?:\s+(?:your|the|this))?\s+(?:list|texts?)(?:\s+please)?$/,
  /^(?:please\s+)?unsubscribe(?:\s+me)?(?:\s+please)?$/,
];

const OPT_IN_WORDS = new Set(["START", "UNSTOP", "RESUME", "OPT IN", "OPTIN"]);
const HELP_WORDS = new Set(["HELP", "INFO"]);
const CONFIRM_WORDS = new Set([
  "YES", "Y", "YEP", "YEAH", "YUP", "CONFIRM", "CONFIRMED", "OK", "OKAY", "K",
  "SOUNDS GOOD", "SEE YOU THEN", "WILL DO", "👍",
]);
const WRONG_NUMBER = /\b(?:wrong\s+(?:number|person|#)|who\s+is\s+this|who\s+dis|don'?t\s+know\s+(?:you|a\s+jamal))\b/i;

// Buying signals. Each is a reason Jamal should pick up the phone now.
const HOT_SIGNALS = [
  [/\bcall\s+me\b|\bgive\s+me\s+a\s+call\b|\bcan\s+you\s+call\b/i, "wants a call"],
  [/\bprice|pricing|how\s+much|\bcost\b|\bmsrp\b|\bout[-\s]the[-\s]door\b|\botd\b/i, "price"],
  [/\bpayment|monthly|\bper\s+month\b|\/mo\b|\bdown\s+payment\b/i, "payment"],
  [/\blease|financ|\bapr\b|\binterest\s+rate\b|\brate\b/i, "finance"],
  [/\btrade|trade[-\s]?in/i, "trade-in"],
  [/\bcredit\b/i, "credit"],
  [/\bdeal\b|\boffer\b|\bdiscount|\brebate|\bincentive/i, "deal"],
  [/\bin\s+stock\b|\bavailable\b|\bstill\s+there\b|\bdo\s+you\s+have\b/i, "availability"],
  [/\btest\s+drive\b|\bcome\s+(?:in|by)\b|\bstop(?:ping)?\s+by\b|\bappointment\b|\btoday\b|\btomorrow\b/i, "wants to come in"],
];

/** Uppercase, trim, collapse spaces, strip surrounding punctuation. */
export function normalizeText(text) {
  return String(text || "")
    .replace(/[‘’]/g, "'")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^[\s.,!?;:"'()\-]+|[\s.,!?;:"'()\-]+$/g, "")
    .toUpperCase();
}

export function isOptOut(text) {
  const n = normalizeText(text);
  if (!n) return false;
  if (OPT_OUT_WORDS.has(n)) return true;
  const lower = n.toLowerCase();
  return OPT_OUT_PHRASES.some((re) => re.test(lower));
}

/** Mentions an opt-out word somewhere, but not as a clear opt-out. */
function mentionsOptOutWord(text) {
  return /\b(?:stop|unsubscribe|opt[-\s]?out)\b/i.test(String(text || ""));
}

/**
 * @returns {{type: "OPT_OUT"|"OPT_IN_REQUEST"|"HELP"|"CONFIRM"|"WRONG_NUMBER"|"HANDOFF",
 *            priority: "urgent"|"hot"|"normal", reasons: string[], possibleOptOut?: boolean}}
 */
export function classifyInbound(text) {
  const raw = String(text || "");
  const n = normalizeText(raw);

  if (isOptOut(raw)) return { type: "OPT_OUT", priority: "urgent", reasons: ["opt-out"] };
  if (!n) return { type: "HANDOFF", priority: "normal", reasons: ["empty message"] };
  if (OPT_IN_WORDS.has(n))
    return { type: "OPT_IN_REQUEST", priority: "urgent", reasons: ["asked to resume texts — confirm by hand"] };
  if (HELP_WORDS.has(n)) return { type: "HELP", priority: "normal", reasons: ["help request"] };
  if (WRONG_NUMBER.test(raw))
    return { type: "WRONG_NUMBER", priority: "urgent", reasons: ["says wrong number — check before texting again"] };

  const reasons = HOT_SIGNALS.filter(([re]) => re.test(raw)).map(([, why]) => why);
  // "Stopping by" is a buying signal, not an opt-out; only flag the
  // ambiguous ones where stop is not part of that phrase.
  const ambiguousStop = mentionsOptOutWord(raw) && !/\bstop(?:ping)?\s+by\b/i.test(raw);
  if (ambiguousStop) {
    return {
      type: "HANDOFF",
      priority: "urgent",
      reasons: ["mentions stop — read it before any more texts", ...reasons],
      possibleOptOut: true,
    };
  }

  if (CONFIRM_WORDS.has(n)) return { type: "CONFIRM", priority: "normal", reasons: ["confirmed"] };
  if (reasons.length) return { type: "HANDOFF", priority: "hot", reasons };
  if (raw.includes("?")) return { type: "HANDOFF", priority: "normal", reasons: ["asked a question"] };
  return { type: "HANDOFF", priority: "normal", reasons: ["replied"] };
}
