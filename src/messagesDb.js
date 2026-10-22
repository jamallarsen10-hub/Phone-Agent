import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Reads incoming texts from the Mac's Messages history (chat.db), READ-ONLY.
 *
 * - Uses the sqlite3 that ships with macOS, opened with -readonly. Nothing is
 *   ever written to Messages' database.
 * - Needs Full Disk Access for the app that runs the engine (Terminal),
 *   otherwise macOS refuses to open the file. That error comes back as
 *   code "NO_ACCESS" so the engine can say so and keep sending.
 * - Only 1-to-1 chats, only messages from the other person, no tapbacks.
 *   Which of these are leads is decided elsewhere (src/replies.js).
 * - The cursor is a ROWID. It is checked to be an integer before it goes into
 *   the SQL, and nothing from a message is ever put into a query.
 */
export const DEFAULT_DB = join(homedir(), "Library", "Messages", "chat.db");
export const SQLITE = "/usr/bin/sqlite3";

// Apple stores dates as seconds (old) or nanoseconds (High Sierra and later) since 2001-01-01.
const UNIX_OF_DATE =
  "CASE WHEN m.date > 100000000000 THEN CAST(m.date / 1000000000 AS INTEGER) ELSE m.date END + 978307200";

export function newRepliesSql(cursor, limit = 200) {
  if (!Number.isInteger(cursor) || cursor < 0) throw new Error(`bad Messages cursor: ${cursor}`);
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`bad limit: ${limit}`);
  return [
    "SELECT m.ROWID AS rowid, m.guid AS guid, m.text AS text, hex(m.attributedBody) AS ab,",
    `${UNIX_OF_DATE} AS unix, m.service AS service, h.id AS handle`,
    "FROM message m JOIN handle h ON h.ROWID = m.handle_id",
    `WHERE m.ROWID > ${cursor} AND m.is_from_me = 0 AND m.cache_roomnames IS NULL`,
    "AND COALESCE(m.associated_message_type, 0) = 0 AND COALESCE(m.item_type, 0) = 0",
    `ORDER BY m.ROWID LIMIT ${limit};`,
  ].join(" ");
}

export const MAX_ROW_SQL = "SELECT COALESCE(MAX(ROWID), 0) AS max FROM message;";

function defaultExec(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message || "").trim().slice(0, 300);
        const e = new Error(detail || "sqlite3 failed");
        if (/authorization denied|unable to open database|operation not permitted/i.test(detail)) e.code = "NO_ACCESS";
        return reject(e);
      }
      resolve({ stdout: String(stdout || "") });
    });
  });
}

export async function querySqlite(sql, { db = DEFAULT_DB, exec = defaultExec } = {}) {
  const { stdout } = await exec(SQLITE, ["-readonly", "-json", db, sql]);
  const out = String(stdout || "").trim();
  return out ? JSON.parse(out) : [];
}

/**
 * Newer macOS keeps the text only inside attributedBody (an NSAttributedString
 * "typedstream"). The plain string sits after "NSString", a "+" marker, and a
 * length: one byte, or 0x81 + 2 bytes, or 0x82 + 4 bytes (little-endian).
 */
export function decodeAttributedBody(hex) {
  if (!hex || typeof hex !== "string") return "";
  const buf = Buffer.from(hex, "hex");
  const at = buf.indexOf(Buffer.from("NSString"));
  if (at < 0) return "";
  const plus = buf.indexOf(0x2b, at + 8);
  if (plus < 0 || plus - (at + 8) > 12) return "";
  let p = plus + 1;
  let len = buf[p];
  if (len === 0x81) {
    len = buf.readUInt16LE(p + 1);
    p += 3;
  } else if (len === 0x82) {
    len = buf.readUInt32LE(p + 1);
    p += 5;
  } else p += 1;
  if (!(len > 0) || p + len > buf.length) return "";
  return buf.subarray(p, p + len).toString("utf8");
}

/** One chat.db row -> { rowid, guid, handle, text, receivedAt, service } */
export function rowToMessage(row) {
  const text = (row.text && String(row.text)) || decodeAttributedBody(row.ab);
  return {
    rowid: Number(row.rowid),
    guid: String(row.guid || row.rowid),
    handle: String(row.handle || ""),
    // U+FFFC is the placeholder Messages puts where an attachment was.
    text: text.replace(/\uFFFC/g, "").trim(),
    receivedAt: Number.isFinite(Number(row.unix)) ? new Date(Number(row.unix) * 1000).toISOString() : null,
    service: row.service || null,
  };
}

export async function readNewReplies(cursor, opts = {}) {
  return (await querySqlite(newRepliesSql(cursor), opts)).map(rowToMessage);
}

export async function readMaxRow(opts = {}) {
  const rows = await querySqlite(MAX_ROW_SQL, opts);
  return Number(rows[0]?.max || 0);
}
