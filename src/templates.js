import { priceFlags } from "./priceBlock.js";

/**
 * Message templates. Rules every outbound template must pass (enforced by
 * validateTemplates() at load and by the test suite):
 *  - says who is texting: the sender's first name and the dealership
 *  - ends with the opt-out line
 *  - contains no price, payment, or finance language and no price placeholder
 *  - plain ASCII, so each text stays in the cheaper 160-character encoding
 *
 * Each template has a `withVehicle` and a `generic` version so a lead with no
 * vehicle on file still gets a natural message instead of a blank.
 */
export const OPT_OUT_LINE = "Reply STOP to opt out.";

export const TEMPLATES = Object.freeze({
  "new-lead": {
    kind: "outreach",
    scope: "followup",
    label: "New lead",
    withVehicle:
      "Hi {firstName}, it's {senderName} at {dealership}. Thanks for reaching out about the {vehicle}. Want to set a time to see it? Pick one here: {bookingUrl} " + OPT_OUT_LINE,
    generic:
      "Hi {firstName}, it's {senderName} at {dealership}. Thanks for reaching out. Want to set a time to come in? Pick one here: {bookingUrl} " + OPT_OUT_LINE,
  },
  "lead-followup": {
    kind: "outreach",
    scope: "followup",
    label: "Follow-up",
    withVehicle:
      "Hi {firstName}, {senderName} from {dealership} checking in on the {vehicle}. Still looking? I can hold a time for you: {bookingUrl} " + OPT_OUT_LINE,
    generic:
      "Hi {firstName}, {senderName} from {dealership} checking in. Still looking for your next car? I can hold a time for you: {bookingUrl} " + OPT_OUT_LINE,
  },
  "after-test-drive": {
    kind: "outreach",
    scope: "visit",
    label: "After test drive",
    withVehicle:
      "Hi {firstName}, {senderName} at {dealership}. Thanks for taking the {vehicle} out. Any questions come up since? Happy to help with next steps. " + OPT_OUT_LINE,
    generic:
      "Hi {firstName}, {senderName} at {dealership}. Thanks for coming in for the test drive. Any questions come up since? Happy to help with next steps. " + OPT_OUT_LINE,
  },
  "missed-appointment": {
    kind: "outreach",
    scope: "visit",
    touch: "noshow-3h",
    label: "Missed appointment",
    withVehicle:
      "Hi {firstName}, it's {senderName} at {dealership}. Sorry we missed you. Want to pick a new time to see the {vehicle}? {bookingUrl} " + OPT_OUT_LINE,
    generic:
      "Hi {firstName}, it's {senderName} at {dealership}. Sorry we missed you. Want to pick a new time to come in? {bookingUrl} " + OPT_OUT_LINE,
  },
  // ---- Appointment touches (names match "Touches Sent" in Notion) ----
  "booking-confirm": {
    kind: "appointment",
    scope: "visit",
    touch: "confirm",
    label: "Confirm",
    withVehicle:
      "Hi {firstName}, it's {senderName} at {dealership}. You're set for {when} to see the {vehicle}. Reply YES to confirm or text me a better time. " + OPT_OUT_LINE,
    generic:
      "Hi {firstName}, it's {senderName} at {dealership}. You're set for {when}. Reply YES to confirm or text me a better time. " + OPT_OUT_LINE,
  },
  "reminder-night": {
    kind: "appointment",
    scope: "visit",
    touch: "reminder-night",
    label: "Night-before reminder",
    withVehicle:
      "Hi {firstName}, {senderName} at {dealership}. Quick reminder: see you tomorrow at {time} for the {vehicle}. Plans change? Just text me. " + OPT_OUT_LINE,
    generic:
      "Hi {firstName}, {senderName} at {dealership}. Quick reminder: see you tomorrow at {time}. Plans change? Just text me. " + OPT_OUT_LINE,
  },
  "reminder-2h": {
    kind: "appointment",
    scope: "visit",
    touch: "reminder-2h",
    label: "Same-day reminder",
    withVehicle:
      "Hi {firstName}, {senderName} here at {dealership}. See you at {time} today. I'll have the {vehicle} ready. " + OPT_OUT_LINE,
    generic:
      "Hi {firstName}, {senderName} here at {dealership}. See you at {time} today. Running late? Just text me. " + OPT_OUT_LINE,
  },

  // ---- After a visit with no sale ----
  "nosale-1d": {
    kind: "outreach",
    scope: "visit",
    touch: "nosale-1d",
    label: "Day after visit",
    withVehicle:
      "Hi {firstName}, {senderName} at {dealership}. Thanks again for coming in. Any questions on the {vehicle} since? Happy to help. " + OPT_OUT_LINE,
    generic:
      "Hi {firstName}, {senderName} at {dealership}. Thanks again for coming in. Any questions since? Happy to help. " + OPT_OUT_LINE,
  },
  "nosale-3d": {
    kind: "outreach",
    scope: "followup",
    touch: "nosale-3d",
    label: "3 days after visit",
    withVehicle:
      "Hi {firstName}, {senderName} from {dealership}. Still thinking about the {vehicle}? I'm here if anything came up. " + OPT_OUT_LINE,
    generic:
      "Hi {firstName}, {senderName} from {dealership}. Still thinking it over? I'm here if anything came up. " + OPT_OUT_LINE,
  },
  "nosale-7d": {
    kind: "outreach",
    scope: "followup",
    touch: "nosale-7d",
    label: "Week after visit",
    withVehicle:
      "Hi {firstName}, {senderName} at {dealership} checking in. Want me to keep an eye out for a {vehicle} that fits what you want? " + OPT_OUT_LINE,
    generic:
      "Hi {firstName}, {senderName} at {dealership} checking in. Want me to keep an eye out for something that fits what you want? " + OPT_OUT_LINE,
  },
  "nosale-30d": {
    kind: "outreach",
    scope: "followup",
    touch: "nosale-30d",
    label: "Month after visit",
    generic:
      "Hi {firstName}, it's {senderName} at {dealership}. It's been a few weeks since your visit. Still looking? Happy to help when the timing is right. " + OPT_OUT_LINE,
  },

  // ---- After a sale ----
  "sold-review": {
    kind: "outreach",
    scope: "followup",
    touch: "sold-review",
    label: "Review request",
    generic:
      "Hi {firstName}, {senderName} at {dealership}. Thanks again for your purchase! If you have a minute, a quick review means a lot: {reviewUrl} " + OPT_OUT_LINE,
  },
  "sold-6mo": {
    kind: "outreach",
    scope: "followup",
    touch: "sold-6mo",
    label: "6-month check-in",
    withVehicle:
      "Hi {firstName}, {senderName} at {dealership}. It's been about 6 months with your {vehicle}. How's it treating you? " + OPT_OUT_LINE,
    generic:
      "Hi {firstName}, {senderName} at {dealership}. It's been about 6 months since you picked up your car. How's it treating you? " + OPT_OUT_LINE,
  },

  // ---- CDK lead sequence ----
  "cdk-intro": {
    kind: "outreach",
    scope: "followup",
    touch: "cdk-intro",
    label: "CDK intro",
    withVehicle:
      "Hi {firstName}, it's {senderName} at {dealership}. I saw you were looking at the {vehicle}. Any questions I can answer? " + OPT_OUT_LINE,
    generic:
      "Hi {firstName}, it's {senderName} at {dealership}. I saw you reached out to us. Any questions I can answer? " + OPT_OUT_LINE,
  },
  "cdk-bump": {
    kind: "outreach",
    scope: "followup",
    touch: "cdk-bump",
    label: "CDK bump",
    withVehicle:
      "Hi {firstName}, {senderName} from {dealership} again. Still interested in the {vehicle}? Pick a time that works: {bookingUrl} " + OPT_OUT_LINE,
    generic:
      "Hi {firstName}, {senderName} from {dealership} again. Still shopping? Pick a time that works: {bookingUrl} " + OPT_OUT_LINE,
  },
  "cdk-last": {
    kind: "outreach",
    scope: "followup",
    touch: "cdk-last",
    label: "CDK last check-in",
    generic:
      "Hi {firstName}, {senderName} at {dealership}. I don't want to bug you, so this is my last check-in for now. If you want help later, just text me. " + OPT_OUT_LINE,
  },

  // Replies to the customer's own keyword. Required by carriers.
  help: {
    kind: "response",
    label: "HELP reply",
    generic:
      "{senderName} at {dealership}: reply here or call this number with any questions. Msg frequency varies. Msg & data rates may apply. " + OPT_OUT_LINE,
  },
  "opt-out-confirm": {
    kind: "opt-out-confirm",
    label: "Opt-out confirmation",
    generic: "You're unsubscribed from {senderName} at {dealership} texts. No more messages will be sent.",
  },
});

const MAX_FIELD = { firstName: 20, vehicle: 40 };

/** Touch name (as in Notion's "Touches Sent") for each template that has one. */
export const TOUCH_OF = Object.fromEntries(
  Object.entries(TEMPLATES).filter(([, t]) => t.touch).map(([name, t]) => [name, t.touch])
);

function cleanVar(name, value) {
  let s = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  if (MAX_FIELD[name] && s.length > MAX_FIELD[name]) s = s.slice(0, MAX_FIELD[name]).trim();
  return s;
}

/**
 * Strict render: a missing or empty variable throws, and so does any
 * placeholder left in the text. A broken message is never sent.
 */
export function render(templateName, vars) {
  const t = TEMPLATES[templateName];
  if (!t) throw new Error(`unknown template: ${templateName}`);
  const hasVehicle = Boolean(cleanVar("vehicle", vars.vehicle));
  const body = hasVehicle && t.withVehicle ? t.withVehicle : t.generic;
  const out = body.replace(/\{(\w+)\}/g, (_, name) => {
    if (!(name in vars)) throw new Error(`template ${templateName}: missing {${name}}`);
    const v = cleanVar(name, vars[name]);
    if (!v) throw new Error(`template ${templateName}: empty {${name}}`);
    return v;
  });
  if (/\{\w+\}/.test(out)) throw new Error(`template ${templateName}: unfilled placeholder`);
  const flags = priceFlags(out);
  if (flags.length) {
    const err = new Error(`template ${templateName}: blocked for ${flags.join(", ")}`);
    err.code = "PRICE_BLOCK";
    err.flags = flags;
    throw err;
  }
  return out;
}

// GSM 03.38 basic set plus extension table. Anything else forces UCS-2.
const GSM = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
);
const GSM_EXT = new Set("^{}\\[~]|€");

/** How many SMS segments a message costs. */
export function smsSegments(text) {
  const chars = [...String(text)];
  const gsm = chars.every((c) => GSM.has(c) || GSM_EXT.has(c));
  if (gsm) {
    const len = chars.reduce((n, c) => n + (GSM_EXT.has(c) ? 2 : 1), 0);
    return { encoding: "GSM-7", length: len, segments: len <= 160 ? 1 : Math.ceil(len / 153) };
  }
  const len = chars.reduce((n, c) => n + (c.codePointAt(0) > 0xffff ? 2 : 1), 0);
  return { encoding: "UCS-2", length: len, segments: len <= 70 ? 1 : Math.ceil(len / 67) };
}

/** Throws if any template breaks the rules. Runs at import time. */
export function validateTemplates() {
  for (const [name, t] of Object.entries(TEMPLATES)) {
    for (const body of [t.withVehicle, t.generic].filter(Boolean)) {
      if (!body.includes("{senderName}") || !body.includes("{dealership}"))
        throw new Error(`template ${name} must identify the sender and dealership`);
      if (t.kind !== "opt-out-confirm" && !body.endsWith(OPT_OUT_LINE))
        throw new Error(`template ${name} must end with "${OPT_OUT_LINE}"`);
      if (/[^\x20-\x7e]/.test(body)) throw new Error(`template ${name} must be plain ASCII`);
      if (/\{(price|payment|amount|msrp|apr|rate|discount)\}/i.test(body))
        throw new Error(`template ${name} has a price placeholder`);
      const flags = priceFlags(body);
      if (flags.length) throw new Error(`template ${name} trips the price block: ${flags.join(", ")}`);
    }
  }
  return true;
}

validateTemplates();
