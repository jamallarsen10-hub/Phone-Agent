import { buildDrafts, upcomingAppointments } from "./drafts.js";
import { runAction, recordSentEffects } from "./actions.js";
import { sendDraft } from "./send.js";
import { openHandoffs } from "./store.js";
import { toE164, prettyPhone } from "./phone.js";
import { TEMPLATES } from "./templates.js";

/**
 * The phone's way in: one line of plain text -> one fixed engine action -> a
 * short plain-text reply. Used by Mac Remote's "Pipeline" agent (no AI in the
 * loop), and by `node src/cli.js pipe "<text>"` for testing.
 *
 * Only the verbs below exist. Nothing typed here ever reaches a shell or an AI,
 * and customer text (names, notes) is only ever printed back, never run.
 *
 * runPipe(text, store, { now, config, provider }) -> { reply, changed }
 * `changed` tells the caller to save the store.
 */

export const PIPE_HELP = `Commands
due — today's texts, waiting replies
coming — appointments next 3 days
send <id> [id…] — text it now from your Mac
skip <id> — drop a draft
sent <id> — you texted it yourself
sold | lost | showed | noshow <name or phone>
handled <name or phone> — you answered their reply
status — totals`;

const VERBS = new Set(["help", "due", "today", "coming", "send", "skip", "sent", "sold", "lost", "showed", "noshow", "no-show", "handled", "status"]);

export function parsePipe(text) {
  const words = String(text || "")
    .trim()
    .replace(/^\/+/, "")
    .split(/\s+/)
    .filter(Boolean);
  const verb = (words.shift() || "help").toLowerCase();
  if (!VERBS.has(verb)) return { verb: "unknown", rest: [verb, ...words] };
  return { verb: verb === "today" ? "due" : verb === "no-show" ? "noshow" : verb, rest: words };
}

const label = (t) => TEMPLATES[t]?.label || t;
const nameOf = (store, m) => (m.leadId && store.leads[m.leadId]?.name) || prettyPhone(m.phone);

/** Find one lead by phone number or by (part of) a name. */
export function findLead(store, query) {
  const q = String(query || "").trim();
  if (!q) return { error: "say who: a name or a phone number" };
  const leads = Object.values(store.leads).filter((l) => !l.notionGone);
  const phone = /\d{7,}/.test(q.replace(/\D/g, "")) ? toE164(q) : null;
  let hits = phone ? leads.filter((l) => l.phone === phone) : [];
  if (!phone) {
    const needle = q.toLowerCase();
    const exact = leads.filter((l) => (l.name || "").toLowerCase() === needle);
    hits = exact.length ? exact : leads.filter((l) => (l.name || "").toLowerCase().includes(needle));
  }
  if (!hits.length) return { error: `no lead matches "${q}"` };
  if (hits.length > 1) {
    const open = hits.filter((l) => !l.closed);
    if (open.length === 1) return { lead: open[0] };
    const list = hits.slice(0, 5).map((l) => `${l.name || "unnamed"} ${prettyPhone(l.phone)}`).join("; ");
    return { error: `${hits.length} match "${q}": ${list}. Use the phone number.` };
  }
  return { lead: hits[0] };
}

function dueText(store, ctx) {
  const r = buildDrafts(store, ctx);
  const auto = new Set(ctx.config.autoTemplates || []);
  const lines = [];
  const mine = r.drafts.filter((d) => !auto.has(d.template));
  const autos = r.drafts.filter((d) => auto.has(d.template));
  if (mine.length) {
    lines.push(`${mine.length} to approve:`);
    for (const d of mine) lines.push(`• ${d.id} ${d.lead?.name || prettyPhone(d.phone)}: ${label(d.template)}${d.why ? ` (${d.why})` : ""}`);
  } else lines.push("Nothing to approve.");
  if (autos.length) lines.push(`${autos.length} going out on their own (${[...new Set(autos.map((d) => label(d.template)))].join(", ")}).`);
  const replies = openHandoffs(store);
  if (replies.length) {
    lines.push(`${replies.length} repl${replies.length === 1 ? "y" : "ies"} waiting:`);
    for (const h of replies.slice(0, 5)) {
      const who = (h.leadIds || []).map((id) => store.leads[id]?.name).filter(Boolean).join(" / ") || prettyPhone(h.phone);
      const said = String(h.body || "").replace(/\s+/g, " ").slice(0, 60);
      lines.push(`• ${who}${said ? `: "${said}"` : ""}`);
    }
  }
  if (r.callList.length) lines.push(`${r.callList.length} to call (no text OK).`);
  if (mine.length) lines.push(`Reply "send ${mine[0].id}" or "skip ${mine[0].id}".`);
  return lines.join("\n");
}

function comingText(store, ctx) {
  const list = upcomingAppointments(store, ctx, 3, 1).filter((a) => a.since <= 0 || a.status === "mark");
  if (!list.length) return "No appointments in the next 3 days.";
  const tag = { confirmed: "✓ confirmed", waiting: "texted, no reply", unconfirmed: "not texted", mark: "mark showed / noshow", showed: "showed", "no-show": "no-show" };
  return list.map((a) => `• ${a.day}${a.time ? " " + a.time : ""}: ${a.lead.name || prettyPhone(a.lead.phone)}${a.lead.vehicle ? ", " + a.lead.vehicle : ""} (${tag[a.status] || a.status})`).join("\n");
}

function why(r) {
  const map = {
    NOT_FOUND: "no draft with that id. Send \"due\" for today's ids",
    NOT_A_DRAFT: `already ${r.detail}`,
    ALREADY_SENT: "already logged as sent",
    OPTED_OUT: "they texted STOP. Never text this number",
    DRAFTS_MODE: "Mac sending isn't armed (mode is drafts)",
    OUTSIDE_HOURS: "outside texting hours (Mon–Sat 9–8)",
    NO_CONSENT: "no OK to text on file",
    AWAITING_JAMAL: "they replied. Answer them, then send \"handled <name>\"",
    DAILY_LIMIT: "already texted today",
    TOO_SOON: `texted recently (${r.detail})`,
    KILL_SWITCH: "kill switch is on",
    PRICE_BLOCK: "message mentions price/payment, send it yourself",
    NO_LEAD: "lead not found",
    NOTHING_OPEN: "no open reply from them",
    STORE_BUSY: "busy saving, try again in a minute",
  };
  return map[r.reason] || [r.reason, r.detail].filter(Boolean).join(": ").toLowerCase();
}

export async function runPipe(text, store, { now, config, provider = null }) {
  const ctx = { now, config };
  const { verb, rest } = parsePipe(text);

  if (verb === "help") return { reply: PIPE_HELP, changed: false };
  if (verb === "unknown") return { reply: `Didn't get "${rest.join(" ").slice(0, 40)}".\n\n${PIPE_HELP}`, changed: false };
  if (verb === "due") return { reply: dueText(store, ctx), changed: true };
  if (verb === "coming") return { reply: comingText(store, ctx), changed: false };

  if (verb === "status") {
    const leads = Object.values(store.leads).filter((l) => !l.notionGone);
    const sentToday = store.outbound.filter((m) => m.status === "sent" && (m.sentAt || "").slice(0, 10) === now.toISOString().slice(0, 10)).length;
    return {
      reply: [
        `Leads: ${leads.length} (${leads.filter((l) => l.consent === true).length} OK to text)`,
        `Sold: ${leads.filter((l) => l.stage === "Sold").length}. Lost: ${leads.filter((l) => l.stage === "Lost").length}`,
        `Texts sent today: ${sentToday}. Replies waiting: ${openHandoffs(store).length}`,
        `Mac sending: ${config.killSwitch ? "OFF (kill switch)" : config.mode === "auto" ? "armed" : "off (drafts mode)"}`,
      ].join("\n"),
      changed: false,
    };
  }

  if (verb === "send" || verb === "skip" || verb === "sent") {
    const ids = verb === "skip" ? rest.slice(0, 1) : rest;
    if (!ids.length) return { reply: `Which one? Try "${verb} <id>". Send "due" for ids.`, changed: false };
    if (verb === "send" && ids.length > 5) return { reply: "Five at a time, max.", changed: false };
    // Make sure the ids refer to today's drafts (and that drafts exist at all).
    buildDrafts(store, ctx);
    const out = [];
    let changed = false;
    for (const raw of ids) {
      const id = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (verb === "skip") {
        const r = runAction("skip", { id, why: rest.slice(1).join(" ").slice(0, 120) || "skipped from phone" }, store, ctx);
        out.push(r.ok ? r.label : `${id}: ${why(r)}`);
        changed ||= r.ok;
      } else if (verb === "sent") {
        const r = runAction("sent", { id }, store, ctx);
        out.push(r.ok ? r.label : `${id}: ${why(r)}`);
        changed ||= r.ok;
      } else {
        if (!provider) {
          out.push(`${id}: Mac sending isn't available here`);
          continue;
        }
        const r = await sendDraft(store, id, { now, config, provider, approved: true });
        if (r.ok && !r.dryRun) {
          recordSentEffects(store, r.message, ctx);
          out.push(`Sent to ${nameOf(store, r.message)}`);
          changed = true;
        } else if (r.ok) {
          out.push(`Would send to ${nameOf(store, r.message)} (dry run)`);
        } else {
          if (r.reason === "PROVIDER_ERROR") changed = true; // marked failed, never retried
          out.push(`${id}: ${r.reason === "PROVIDER_ERROR" ? `Messages failed (${r.detail}). Check your phone before resending.` : why(r)}`);
          if (r.reason === "PROVIDER_ERROR") break;
        }
      }
    }
    return { reply: out.join("\n"), changed };
  }

  // Lead outcomes: sold | lost | showed | noshow | handled
  const f = findLead(store, rest.join(" "));
  if (f.error) return { reply: f.error, changed: false };
  const args = verb === "handled" ? { phone: f.lead.phone } : { leadId: f.lead.id };
  const r = runAction(verb, args, store, ctx);
  return { reply: r.ok ? r.label : `${f.lead.name || "Lead"}: ${why(r)}`, changed: r.ok };
}
