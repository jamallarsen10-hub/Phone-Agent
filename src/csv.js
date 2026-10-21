/**
 * Small RFC 4180 CSV reader/writer: quoted fields, doubled quotes, commas and
 * newlines inside quotes, CRLF, and a leading byte-order mark (Excel adds one).
 */
export function parseCSV(text) {
  const s = String(text).replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      inQuotes = true;
      i++;
    } else if (c === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (c === "\r" || c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += c === "\r" && s[i + 1] === "\n" ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (inQuotes) throw new Error("CSV has an unclosed quote");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/** Rows as objects keyed by the header row. */
export function parseCSVObjects(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, idx) => {
      o[h] = (r[idx] ?? "").trim();
    });
    return o;
  });
  return { headers, records };
}

function esc(v) {
  const s = v == null ? "" : String(v);
  // Neutralize spreadsheet formulas so a cell like =HYPERLINK(...) stays text.
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCSV(headers, records) {
  const lines = [headers.map(esc).join(",")];
  for (const r of records) lines.push(headers.map((h) => esc(r[h])).join(","));
  return lines.join("\r\n") + "\r\n";
}
