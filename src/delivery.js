import { randomUUID } from "node:crypto";
import { querySqlite, decodeAttributedBody } from "./messagesDb.js";
import { toE164, prettyPhone } from "./phone.js";
import { TEMPLATES } from "./templates.js";

/**
 * Delivery check: did a text the engine "sent" actually reach the person?
 *
 * Why: osascript only says Messages ACCEPTED a text. An iMessage to an Android
 * number, or an SMS with Text Message Forwarding off, is accepted without error
 * and then quietly fails (red "Not Delivered" in Messages). The engine used to
 * call that "sent" and move on. Now it reads Messages' own history (chat.db,
 * read-only) and records what really happened on the message as `delivery`:
 *
 *   delivered    iMessage with a delivery receipt                    good, final
 *   accepted     SMS handed to the carrier (SMS has no receipts)     good, final
 *   pending      found in Messages, not settled yet                   keep checking
 *   failed       Messages marked it Not Delivered (error != 0)       bad -> alert
 *   unconfirmed  iMessage, no receipt after unconfirmedAfterMinutes  bad -> alert
 *   missing      never showed up in Messages after missingAfterMinutes  bad -> alert
 *
 * `status` stays "sent" on purpose: daily limits and duplicate protection keep
 * counting it, so a failed delivery can never cause the engine to draft and
 * send the same text again by itself. The only resend is the opt-in, one-time
 * SMS retry below (config.smsRetry), and only after Messages itself says the
 * iMessage failed.
 *
 * Nothing from a message goes into SQL: the only value in the query is a
 * whole-number timestamp, checked first.
 */

export const GOOD = new Set(["delivered", "accepted"]);
export const BAD = new Set(["failed", "unconfirmed", "missing"]);
const WINDOW_HOURS = 48;

const UNIX_OF = (col) => `(CASE WHEN ${col} > 100000000000 THEN CAST(${col} / 1000000000 AS INTEGER) ELSE ${col} END + 978307200)`;

/** Outgoing 1-to-1 texts since `sinceUnix` (whole seconds). */
export function outgoingSql(sinceUnix, limit = 1000) {
  if (!Number.isInteger(sinceUnix) || sinceUnix < 0) throw new Error(`bad since: ${sinceUnix}`);
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`bad limit: ${limit}`);
  return [
    "SELECT m.ROWID AS rowid, m.text AS text, hex(m.attributedBody) AS ab, m.service AS service,",
    "m.is_sent AS is_sent, m.is_delivered AS is_delivered, m.error AS error,",
    `${UNIX_OF("m.date")} AS unix, CASE WHEN m.date_delivered > 0 THEN ${UNIX_OF("m.date_delivered")} ELSE NULL END AS delivered_unix,`,
    "COALESCE(NULLIF(h.id, ''), c.chat_identifier) AS handle",
    "FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id",
    "LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID LEFT JOIN chat c ON c.ROWID = cmj.chat_id",
    `WHERE m.is_from_me = 1 AND m.cache_roomnames IS NULL AND ${UNIX_OF("m.date")} >= ${sinceUnix}`,
    "AND COALESCE(m.associated_message_type, 0) = 0 AND COALESCE(m.item_type, 0) = 0",
    `ORDER BY m.ROWID LIMIT ${limit};`,
  ].join(" ");
}

export function rowToOutgoing(row) {
  const text = (row.text && String(row.text)) || decodeAttributedBody(row.ab);
  return {
    rowid: Number(row.rowid),
    phone: toE164(row.handle),
    text: norm(text),
    service: row.service || null,
    isSent: Number(row.is_sent) === 1,
    isDelivered: Number(row.is_delivered) === 1,
    error: Number(row.error) || 0,
    at: Number.isFinite(Number(row.unix)) ? Number(row.unix) * 1000 : null,
    deliveredAt: row.delivered_unix ? new Date(Number(row.delivered_unix) * 1000).toISOString() : null,
  };
}

export async function readOutgoing(sinceMs, opts = {}) {
  const rows = await querySqlite(outgoingSql(Math.floor(sinceMs / 1000)), opts);
  const seen = new Set();
  return rows.map(rowToOutgoing).filter((r) => (seen.has(r.rowid) ? false : seen.add(r.rowid)));
}

const norm = (t) => String(t || "").replace(/￼/g, "").replace(/\s+/g, " ").trim();

/** What one Messages row says about delivery, given how long ago it was sent. */
export function classify(row, ageMs, config) {
  if (row.error) return "failed";
  if (row.isDelivered) return row.service === "SMS" ? "accepted" : "delivered";
  if (row.service === "SMS" && row.isSent) return "accepted";
  return ageMs >= (config.unconfirmedAfterMinutes ?? 15) * 60000 ? "unconfirmed" : "pending";
}

/** Texts the engine itself sent through Messages in the last two days that aren't settled. */
export function toCheck(store, now) {
  const since = now.getTime() - WINDOW_HOURS * 3600000;
  return store.outbound.filter((m) => {
    if (m.status !== "sent" || m.via !== "mac-messages") return false;
    const at = Date.parse(m.attemptAt || m.sentAt);
    if (!(at >= since)) return false;
    const st = m.delivery?.state;
    return !GOOD.has(st) && !(st === "failed" && m.delivery?.retry?.status !== "sent");
  });
}

export function alertBody(store, m) {
  const lead = m.leadId ? store.leads[m.leadId] : null;
  const who = lead?.name || prettyPhone(m.phone);
  const what = TEMPLATES[m.template]?.label || m.template;
  const how = { failed: "NOT delivered", unconfirmed: "not confirmed delivered", missing: "never showed up in Messages" }[m.delivery.state];
  return [
    `Text ${how}: ${who}${lead?.vehicle ? ` (${lead.vehicle})` : ""}, ${what} via ${m.delivery.service || m.service || "Messages"}.`,
    m.delivery.retry?.status === "sent" ? "Retried once as SMS." : "Text or call them yourself.",
    `${prettyPhone(m.phone)}`,
  ].join("\n");
}

/**
 * One pass. `read(sinceMs)` returns outgoing rows (readOutgoing, injectable).
 * `provider` is only used for alerts to Jamal and the opt-in SMS retry.
 */
export async function checkDeliveries(store, { now, config, read, provider = null, persist = () => {} }) {
  const report = { checked: 0, changed: [], alerts: [], retries: [], failed: [] };
  const list = toCheck(store, now);
  if (!list.length) return report;
  const earliest = Math.min(...list.map((m) => Date.parse(m.attemptAt || m.sentAt)));
  const rows = await read(earliest - 2 * 60000);
  // A Messages row belongs to at most one engine text.
  const claimed = new Set(store.outbound.map((m) => m.delivery?.rowid).filter(Number.isInteger));
  const alertTo = config.alertPhone ? toE164(config.alertPhone) : null;

  for (const m of list) {
    report.checked++;
    const at = Date.parse(m.attemptAt || m.sentAt);
    const body = norm(m.body);
    const d = (m.delivery ||= { state: "pending" });
    const before = d.state;

    // After an SMS retry, follow the retry's row instead of the failed iMessage.
    const wantAfter = d.retry?.status === "sent" ? d.retry.rowAfter ?? d.rowid ?? 0 : -1;
    let row = rows.find((r) => r.rowid === d.rowid && r.rowid > wantAfter);
    if (!row) {
      row = rows.find((r) => !claimed.has(r.rowid) && r.rowid > wantAfter && r.phone === m.phone && r.text === body && r.at >= at - 2 * 60000);
      if (row) claimed.add(row.rowid);
    }

    if (row) {
      d.rowid = row.rowid;
      d.service = row.service;
      d.error = row.error || undefined;
      d.deliveredAt = row.deliveredAt || undefined;
      d.state = classify(row, now.getTime() - at, config);
    } else if (now.getTime() - at >= (config.missingAfterMinutes ?? 5) * 60000) {
      d.state = "missing";
    }
    d.checkedAt = now.toISOString();

    // Opt-in: an iMessage that Messages itself marked failed gets ONE try as SMS.
    if (d.state === "failed" && d.service === "iMessage" && config.smsRetry === true && !d.retry && provider && !provider.dryRun) {
      d.retry = { at: now.toISOString(), status: "sending", rowAfter: d.rowid };
      persist();
      try {
        await provider.send({ to: m.phone, body: m.body, idempotencyKey: m.id + "-sms", service: "SMS" });
        d.retry.status = "sent";
        d.state = "pending";
        report.retries.push({ id: m.id, to: m.phone });
      } catch (e) {
        d.retry.status = "failed";
        d.retry.error = String(e && e.message).slice(0, 200);
        report.failed.push({ id: m.id, detail: d.retry.error });
      }
    }

    if (d.state !== before) report.changed.push({ id: m.id, to: m.phone, template: m.template, from: before, state: d.state, service: d.service });

    // Tell Jamal once per text.
    if (BAD.has(d.state) && !d.alertedAt) {
      d.alertedAt = now.toISOString();
      const a = { id: randomUUID().slice(0, 8), to: alertTo, about: m.phone, kind: "undelivered", messageId: m.id, at: d.alertedAt, status: "none" };
      if (alertTo && provider) {
        a.status = "sending";
        store.alerts.push(a);
        persist();
        try {
          await provider.send({ to: alertTo, body: alertBody(store, m), idempotencyKey: "alert-" + a.id });
          a.status = provider.dryRun ? "dry-run" : "sent";
          report.alerts.push({ id: m.id, state: d.state });
        } catch (e) {
          a.status = "failed";
          a.error = String(e && e.message).slice(0, 200);
          report.failed.push({ alert: a.id, detail: a.error });
        }
      } else store.alerts.push(a);
    }
    persist();
  }
  return report;
}

/** Counts for `status`, last `days` days. */
export function deliverySummary(store, now, days = 7) {
  const since = now.getTime() - days * 86400000;
  const out = { delivered: 0, accepted: 0, pending: 0, failed: 0, unconfirmed: 0, missing: 0, unchecked: 0 };
  for (const m of store.outbound) {
    if (m.status !== "sent" || m.via !== "mac-messages" || !(Date.parse(m.attemptAt || m.sentAt) >= since)) continue;
    out[m.delivery?.state || "unchecked"]++;
  }
  return out;
}

/** Texts that didn't make it and haven't been dealt with (for `due`). */
export function undelivered(store, now) {
  const since = now.getTime() - WINDOW_HOURS * 3600000;
  return store.outbound.filter((m) => BAD.has(m.delivery?.state) && !m.delivery.handledAt && Date.parse(m.attemptAt || m.sentAt) >= since);
}
