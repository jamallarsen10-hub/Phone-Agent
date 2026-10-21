import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * One JSON file is the whole database: data/store.json (gitignored).
 * Small enough for a personal pipeline, readable by eye, and backed up with a
 * copy. Writes go to a temp file first and are renamed into place, so a crash
 * mid-write leaves the previous good copy instead of a half-written file.
 *
 * Shape:
 *   leads     { [id]: Lead }
 *   optOuts   { [e164]: { at, via, text } }   per phone number, not per lead
 *   outbound  [ { id, key, leadId, phone, template, body, status, createdAt, sentAt, via } ]
 *   inbound   { [messageId]: { phone, body, receivedAt, type, priority, reasons } }
 *   handoffs  [ { id, phone, leadIds, messageId, type, priority, reasons, body, at, clearedAt } ]
 */
export const EMPTY = () => ({
  version: 1,
  leads: {},
  optOuts: {},
  outbound: [],
  inbound: {},
  handoffs: [],
});

export function storePath(dataDir) {
  return join(dataDir, "store.json");
}

export function loadStore(dataDir) {
  const path = storePath(dataDir);
  if (!existsSync(path)) return EMPTY();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} is unreadable (${e.message}). Restore data/store.backup.json before continuing.`);
  }
  return { ...EMPTY(), ...parsed };
}

export function saveStore(dataDir, store) {
  const path = storePath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  // Keep the last good version next to it.
  if (existsSync(path)) copyFileSync(path, join(dataDir, "store.backup.json"));
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/** Every lead sharing a phone number. */
export function leadsByPhone(store, phone) {
  return Object.values(store.leads).filter((l) => l.phone === phone);
}

export function isOptedOut(store, phone) {
  return Boolean(phone && store.optOuts[phone]);
}

/** Outbound texts actually sent to a number. */
export function sentTo(store, phone) {
  return store.outbound.filter((m) => m.phone === phone && m.status === "sent");
}

export function openHandoffs(store, phone) {
  return store.handoffs.filter((h) => !h.clearedAt && (!phone || h.phone === phone));
}
