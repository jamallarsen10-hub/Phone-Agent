import { buildDrafts } from "./drafts.js";
import { sendDraft } from "./send.js";
import { recordSentEffects } from "./actions.js";

/**
 * The automatic path for confirmations and reminders. Ships OFF.
 *
 * Real sending needs ALL of these at once:
 *   1. "mode": "auto" in data/config.json
 *   2. the --live flag on `auto`
 *   3. the kill switch off
 * Anything less runs as a dry run that prints what it would do and texts no one.
 *
 * Only templates in config.autoTemplates are ever sent here. Every other draft
 * stays a draft for you to send by hand. Each text still goes through the same
 * gate as always (consent, STOP, hours, price block, daily limits), re-checked
 * at the moment of sending.
 */
export function autoState(config, { live = false } = {}) {
  if (config.killSwitch) return { live: false, notes: ["KILL SWITCH IS ON. Nothing will be sent."] };
  if (!live)
    return {
      live: false,
      notes: ['Dry run: showing what would be sent, texting no one. To send for real, set "mode": "auto" in data/config.json AND add --live.'],
    };
  if (config.mode !== "auto")
    return { live: false, notes: ['--live ignored: mode is "drafts", so this is a dry run and texts no one. Set "mode": "auto" in data/config.json to arm it.'] };
  return {
    live: true,
    notes: [`LIVE: automatically texting ${(config.autoTemplates || []).join(", ")}. Everything else stays a draft for you. Ctrl+C to stop.`],
  };
}

/**
 * One pass: build today's drafts, then send the allowlisted ones.
 * `persist` saves the store. It runs just before each real send, while the
 * message is marked "sending", so a crash mid-send leaves it as "sending" on
 * disk and never as a draft that could go out twice.
 *
 * Stops after the first provider error (report.stop): if Messages is broken,
 * working through the rest would only mark more texts failed.
 */
export async function autoTick(store, { now, config, provider, persist = () => {} }) {
  const report = { sent: [], wouldSend: [], held: [], notAuto: [], failed: [], stop: false };
  const result = buildDrafts(store, { now, config });
  const allowed = new Set(config.autoTemplates || []);
  const guarded = {
    ...provider,
    async send(msg) {
      persist();
      return provider.send(msg);
    },
  };

  for (const d of result.drafts) {
    if (!allowed.has(d.template)) {
      report.notAuto.push({ id: d.id, template: d.template });
      continue;
    }
    const base = { id: d.id, template: d.template, to: d.phone };
    // An earlier attempt at this same text that failed or was cut off mid-send
    // may have gone out. buildDrafts would otherwise draft the same text again
    // and we would send it a second time, so hold it for you to check.
    const unsure = store.outbound.find((m) => m.key === d.key && m.id !== d.id && (m.status === "failed" || m.status === "sending"));
    if (unsure) {
      report.held.push({ ...base, reason: "UNKNOWN_OUTCOME", detail: `an earlier try (${unsure.id}) may have gone out; check Messages, then tap Sent or Skip` });
      continue;
    }
    const r = await sendDraft(store, d.id, { now, config, provider: guarded });
    if (r.ok && r.dryRun) {
      report.wouldSend.push({ ...base, body: d.body });
    } else if (r.ok) {
      recordSentEffects(store, r.message, { now, config });
      persist();
      report.sent.push(base);
    } else if (r.reason === "PROVIDER_ERROR") {
      persist();
      report.failed.push({ ...base, detail: r.detail });
      report.stop = true;
      break;
    } else {
      report.held.push({ ...base, reason: r.reason, detail: r.detail });
    }
  }
  persist();
  return report;
}
