import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { loadStore, saveStore } from "./store.js";
import { buildDrafts } from "./drafts.js";
import { renderPage } from "./page.js";
import { runAction } from "./actions.js";

/**
 * The Command Center: a private page served from Jamal's own device.
 *
 * Privacy, in layers:
 *  - Binds to 127.0.0.1 by default, so only this device can open it.
 *    --lan opens it to phones on the same Wi-Fi; still needs the key.
 *  - A random key is printed at start. Opening the printed link trades it
 *    for a cookie (HttpOnly, SameSite=Strict); without it, nothing loads.
 *  - Every tap also sends the key in a header, so another website open in
 *    the same browser can't trigger actions behind your back.
 *  - The Host header must be this machine, which blocks DNS-rebinding tricks.
 *  - No-referrer and no-store, so the key and customer data don't leak
 *    into font requests or the browser cache.
 *
 * Undo keeps one snapshot: the store as it was before the last tap.
 */
export function startServer({ dataDir, config, port = 4777, lan = false, nowFn = () => new Date(), log = console.log }) {
  const key = randomBytes(18).toString("base64url");
  const host = lan ? "0.0.0.0" : "127.0.0.1";
  let undo = null; // { snapshot, label, at }

  const allowedHosts = () => {
    const names = new Set(["localhost", "127.0.0.1", "[::1]"]);
    if (lan) for (const ip of lanAddresses()) names.add(ip);
    return names;
  };

  const sameKey = (v) => {
    const a = Buffer.from(String(v || ""));
    const b = Buffer.from(key);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const cookieKey = (req) => {
    const m = /(?:^|;\s*)pa_key=([^;]+)/.exec(req.headers.cookie || "");
    return m ? decodeURIComponent(m[1]) : "";
  };

  const send = (res, status, body, type = "text/plain; charset=utf-8", extra = {}) => {
    res.writeHead(status, {
      "content-type": type,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      ...extra,
    });
    res.end(body);
  };

  const server = createServer(async (req, res) => {
    try {
      const hostName = String(req.headers.host || "").replace(/:\d+$/, "");
      if (!allowedHosts().has(hostName)) return send(res, 421, "Wrong host.");
      const url = new URL(req.url, "http://localhost");

      // Opening the printed link: swap the key for a cookie, then drop it from the URL.
      if (req.method === "GET" && url.searchParams.has("key")) {
        if (!sameKey(url.searchParams.get("key"))) return send(res, 403, "That link is old. Use the one printed when the server started.");
        return send(res, 303, "", "text/plain", {
          location: "/",
          "set-cookie": `pa_key=${encodeURIComponent(key)}; HttpOnly; SameSite=Strict; Path=/`,
        });
      }
      if (!sameKey(cookieKey(req))) return send(res, 403, "Private. Open the link printed in your terminal.");

      if (req.method === "GET" && url.pathname === "/") {
        const now = nowFn();
        const store = loadStore(dataDir);
        const result = buildDrafts(store, { now, config });
        saveStore(dataDir, store);
        const fresh = undo && now - undo.at < 10 * 60 * 1000 ? undo : null;
        const html = renderPage(store, result, { now, config, live: { key, undoLabel: fresh && fresh.label } });
        return send(res, 200, html, "text/html; charset=utf-8");
      }

      if (req.method === "POST" && url.pathname === "/api/action") {
        if (!sameKey(req.headers["x-pa-key"])) return send(res, 403, "Missing key.");
        const body = await readJSON(req);
        const now = nowFn();
        const store = loadStore(dataDir);

        if (body.action === "undo") {
          if (!undo) return sendJSON(res, 409, { ok: false, reason: "NOTHING_TO_UNDO" });
          saveStore(dataDir, JSON.parse(undo.snapshot));
          const label = `Undid: ${undo.label}`;
          undo = null;
          return sendJSON(res, 200, { ok: true, label });
        }

        const snapshot = JSON.stringify(store);
        const r = runAction(body.action, body.args, store, { now, config });
        if (!r.ok) return sendJSON(res, 400, r);
        saveStore(dataDir, store);
        undo = { snapshot, label: r.label, at: now };
        log(`[command center] ${r.label}`);
        return sendJSON(res, 200, r);
      }

      return send(res, 404, "Not found.");
    } catch (e) {
      log(`[command center] error: ${e.message}`);
      return send(res, 500, "Something broke. Check the terminal.");
    }
  });

  function sendJSON(res, status, obj) {
    send(res, status, JSON.stringify(obj), "application/json");
  }

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actual = server.address().port;
      const urls = [`http://127.0.0.1:${actual}/?key=${key}`];
      if (lan) for (const ip of lanAddresses()) urls.push(`http://${ip}:${actual}/?key=${key}`);
      resolve({ server, port: actual, key, urls });
    });
  });
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 10000) {
        reject(new Error("request too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("bad JSON"));
      }
    });
    req.on("error", reject);
  });
}

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}
