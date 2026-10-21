/**
 * Outbound price/finance denylist. Texts never quote numbers or promises;
 * those conversations happen with Jamal directly.
 *
 * This is a backstop, not a guarantee: the real protection is that no
 * template has a price placeholder. False positives are fine here, because a
 * blocked draft only means Jamal writes that one himself.
 */
const PATTERNS = [
  [/\$/, "dollar sign"],
  [/\b\d{1,3}(?:,\d{3})+\b/, "large number"],
  [/\b\d+(?:\.\d+)?\s?%/, "percentage"],
  [/\/\s?mo\b|\bper\s+month\b|\ba\s+month\b|\bmonthly\b/i, "monthly payment"],
  [/\bAPR\b/i, "APR"],
  [/\bMSRP\b/i, "MSRP"],
  [/\bdiscount/i, "discount"],
  [/\brebate/i, "rebate"],
  [/\btrade[-\s]?in\s+value\b|\btrade\s+value\b/i, "trade value"],
  [/\bfinal\s+price\b|\bbest\s+price\b|\blowest\s+price\b/i, "price promise"],
  [/\bout[-\s]the[-\s]door\b|\bOTD\b/i, "out-the-door"],
  [/\bguarantee/i, "guarantee"],
  [/\b(?:pre-?)?approved\b|\bapproval\b/i, "credit approval"],
  [/\bno\s+money\s+down\b|\bzero\s+down\b|\$0\s+down\b/i, "down payment promise"],
  [/\bfinanc(?:e|ing)\s+(?:rate|offer|special)\b/i, "finance offer"],
];

/** Returns the list of reasons the text was blocked; empty means clean. */
export function priceFlags(text) {
  const s = String(text || "");
  return PATTERNS.filter(([re]) => re.test(s)).map(([, why]) => why);
}

export function containsPricing(text) {
  return priceFlags(text).length > 0;
}
