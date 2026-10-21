import { canSend } from "./guardrails.js";
import { priceFlags } from "./priceBlock.js";

/**
 * Recording and sending. Two paths, one gate.
 *
 * markSent(): Jamal texted it from his own phone and is logging that. The
 * text already went out, so this records reality; it refuses only things
 * that should never be logged as sent (wrong id, already sent, opted out).
 *
 * sendDraft(): the automatic path. Re-runs the full gate at the moment of
 * sending, including quiet hours and a fresh price check, then hands off to
 * a provider. Providers shipped: the dry-run one, and src/providers/macMessages.js
 * (Messages on a Mac, off unless mode is "auto" and `auto --live` is used).
 * Only templates in config.autoTemplates may be sent this way.
 */
export function markSent(store, id, { now, via = "manual" }) {
  const m = store.outbound.find((x) => x.id === id);
  if (!m) return { ok: false, reason: "NOT_FOUND", detail: id };
  if (m.status === "sent") return { ok: false, reason: "ALREADY_SENT", detail: m.sentAt };
  if (m.template !== "opt-out-confirm" && store.optOuts[m.phone])
    return { ok: false, reason: "OPTED_OUT", detail: "this number sent STOP; do not text it" };
  m.status = "sent";
  m.sentAt = now.toISOString();
  m.via = via;
  return { ok: true, message: m };
}

export function skipDraft(store, id, { now, why = "" }) {
  const m = store.outbound.find((x) => x.id === id);
  if (!m) return { ok: false, reason: "NOT_FOUND", detail: id };
  if (m.status !== "draft") return { ok: false, reason: "NOT_A_DRAFT", detail: m.status };
  m.status = "skipped";
  m.skippedAt = now.toISOString();
  m.skipWhy = why;
  return { ok: true, message: m };
}

export async function sendDraft(store, id, { now, config, provider, approved = false }) {
  const m = store.outbound.find((x) => x.id === id);
  if (!m) return { ok: false, reason: "NOT_FOUND" };
  if (m.status !== "draft") return { ok: false, reason: "NOT_A_DRAFT", detail: m.status };
  if (!provider) return { ok: false, reason: "NO_PROVIDER" };
  if (config.mode !== "auto" && !provider.dryRun)
    return { ok: false, reason: "DRAFTS_MODE", detail: 'set mode to "auto" in data/config.json to send automatically' };
  // Even in auto mode, only the templates listed in config.autoTemplates may go
  // out on their own. A missing list means none (fail closed).
  // `approved` = Jamal picked this exact draft by id from his phone. It lifts
  // only the autoTemplates limit; every check below still runs.
  if (!provider.dryRun && !approved && !(config.autoTemplates || []).includes(m.template))
    return { ok: false, reason: "TEMPLATE_NOT_AUTO", detail: `${m.template} is not in autoTemplates; send it yourself` };

  const lead = m.leadId ? store.leads[m.leadId] : null;
  const check = canSend(store, { lead, phone: m.phone, template: m.template }, { now, config, checkHours: true });
  if (!check.ok) return check;
  const flags = priceFlags(m.body);
  if (flags.length) return { ok: false, reason: "PRICE_BLOCK", detail: flags.join(", ") };

  // A dry run passes every check and touches nothing, so it never uses up
  // a number's daily limit or marks a real draft as sent.
  if (provider.dryRun) {
    await provider.send({ to: m.phone, body: m.body, idempotencyKey: m.id });
    return { ok: true, dryRun: true, message: m };
  }

  // The draft id doubles as the idempotency key, so a retried call cannot
  // produce a second text even if the provider saw the first one.
  m.status = "sending";
  m.attemptAt = now.toISOString();
  try {
    const res = await provider.send({ to: m.phone, body: m.body, idempotencyKey: m.id });
    m.status = "sent";
    m.sentAt = now.toISOString();
    m.via = provider.name;
    m.providerMessageId = res && res.id;
    return { ok: true, message: m };
  } catch (e) {
    // Unknown outcome: do NOT flip back to draft, or a retry could double-text.
    m.status = "failed";
    m.error = String(e && e.message).slice(0, 200);
    return { ok: false, reason: "PROVIDER_ERROR", detail: m.error };
  }
}

/** Prints instead of sending. Lets the automatic path be tested end to end. */
export function dryRunProvider(log = console.log) {
  return {
    name: "dry-run",
    dryRun: true,
    async send({ to, body, idempotencyKey }) {
      log(`[dry-run] would text ${to} (key ${idempotencyKey}): ${body}`);
      return { id: "dry-" + idempotencyKey };
    },
  };
}
