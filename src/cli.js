#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { loadStore, saveStore, leadsByPhone, openHandoffs } from "./store.js";
import { importLeads } from "./leads.js";
import { buildDrafts } from "./drafts.js";
import { renderPage } from "./page.js";
import { handleInbound } from "./inbound.js";
import { markSent, skipDraft, sendDraft, dryRunProvider } from "./send.js";
import { runAction } from "./actions.js";
import { startServer } from "./server.js";
import { notionClient, syncNotion, GRACE_MS } from "./notion.js";
import { autoState, autoTick } from "./auto.js";
import { macMessagesProvider } from "./providers/macMessages.js";
import { toE164, prettyPhone } from "./phone.js";
import { runPipe } from "./pipe.js";
import { withStoreLock } from "./lock.js";
import { toCSV } from "./csv.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = resolve(process.env.PHONE_AGENT_DATA || join(ROOT, "data"));
const OUT = resolve(process.env.PHONE_AGENT_OUT || join(ROOT, "out"));

const HELP = `Phone Agent — drafts-first text follow-up

Daily:
  serve [--lan]              Open the Command Center: every button saves on tap
  reply <phone> <text>       Log a text a customer sent you (STOP, questions, anything)
  drafts                     Or: build out/today.html as a file (no server)
  sent <id> [id...]          Log texts you sent from the file version
  sold|lost <phone>          Stop follow-ups for a lead

Setup and fixes:
  sync                       Pull the Notion Lead Pipeline now and save any taps waiting to go out
  import <export.csv>        Load or refresh leads from a CDK export (never deletes)
  consent <phone> --source "how they said yes"   Record permission to text
  optout <phone>             Record a do-not-text you got another way (call, email)
  handled <phone>            You answered their reply; follow-ups may resume
  skip <id> [--why "..."]    Drop a draft you will not send
  status                     Counts, opt-outs, open replies
  pipe "<text>"              One phone command (due, send <id>, sold <name>…); used by Mac Remote
  send --dry-run             Run drafts through the automatic path without sending
  auto [--once] [--live]     Confirmations and reminders on your Mac. Dry run unless mode is "auto" AND --live

Options:  --now 2026-10-20T10:00:00-04:00   pretend it is another time (testing)
Env:      KILL_SWITCH=true stops every text. PHONE_AGENT_DATA, PHONE_AGENT_OUT move folders.`;

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[k] = next;
        i++;
      } else flags[k] = true;
    } else args.push(a);
  }
  return { args, flags };
}

function needPhone(raw) {
  const p = toE164(raw);
  if (!p) fail(`"${raw}" is not a valid US phone number`);
  return p;
}

function fail(msg) {
  console.error("Error: " + msg);
  process.exit(1);
}

function writePage(store, config, now) {
  const result = buildDrafts(store, { now, config });
  mkdirSync(OUT, { recursive: true, mode: 0o700 });
  const page = join(OUT, "today.html");
  writeFileSync(page, renderPage(store, result, { now, config }), { mode: 0o600 });
  const csv = join(OUT, `drafts-${result.today}.csv`);
  writeFileSync(
    csv,
    toCSV(
      ["id", "name", "phone", "template", "why", "segments", "message"],
      result.drafts.map((d) => ({
        id: d.id,
        name: d.lead?.name || "",
        phone: prettyPhone(d.phone),
        template: d.template,
        why: d.why || "",
        segments: d.segments,
        message: d.body,
      }))
    ),
    { mode: 0o600 }
  );
  return { result, page, csv };
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const cmd = args.shift();
  if (!cmd || cmd === "help" || flags.help) return console.log(HELP);

  const config = loadConfig(DATA);
  const now = flags.now ? new Date(flags.now) : new Date();
  if (Number.isNaN(now.getTime())) fail("--now is not a valid date");
  const store = loadStore(DATA);

  switch (cmd) {
    case "import": {
      const file = args[0] || fail("usage: import <export.csv>");
      const s = importLeads(store, readFileSync(file, "utf8"), { now, sourceFile: basename(file) });
      saveStore(DATA, store);
      console.log(`Imported ${s.rows} rows: ${s.added} new, ${s.updated} updated.`);
      console.log(`Columns used: ${Object.entries(s.columns).map(([k, v]) => `${k}<-"${v}"`).join(", ") || "none"}`);
      if (s.unmapped.length) console.log(`Ignored columns: ${s.unmapped.join(", ")}`);
      if (s.badPhone) console.log(`${s.badPhone} rows have no usable phone (kept, but can't be texted).`);
      if (s.sharedPhone) console.log(`${s.sharedPhone} leads share a number with someone else (one text per number per day).`);
      console.log(`${s.consentYes} leads have permission to text on file.`);
      s.warnings.forEach((w) => console.log("Warning: " + w));
      return;
    }

    case "sync": {
      if (!config.notionToken) fail("No Notion token. Add notionToken to data/config.json or set NOTION_TOKEN. See README.");
      const r = await syncNotion(DATA, config, notionClient({ token: config.notionToken }), { now, graceMs: 0 });
      if (!r.ok) fail(r.error);
      console.log(`Pulled ${r.count} leads from Notion. Saved ${r.pushed} change${r.pushed === 1 ? "" : "s"} back.`);
      for (const e of r.pushErrors) console.log(`  not saved: ${e.error}`);
      return;
    }

    case "drafts": {
      const { result, page, csv } = writePage(store, config, now);
      saveStore(DATA, store);
      const hand = openHandoffs(store);
      console.log(`${result.today}: ${result.drafts.length} to text, ${hand.length} repl${hand.length === 1 ? "y" : "ies"} waiting, ${result.callList.length} to call, ${result.skipped.length} held.`);
      for (const d of result.drafts) console.log(`  [${d.id}] ${d.lead?.name || prettyPhone(d.phone)} — ${d.why}`);
      if (config.killSwitch) console.log("KILL SWITCH IS ON. Do not send anything.");
      console.log(`Open on your phone: ${page}`);
      console.log(`Spreadsheet copy:   ${csv}`);
      return;
    }

    case "sent": {
      if (!args.length) fail("usage: sent <id> [id...]");
      let ok = 0;
      for (const id of args) {
        const r = markSent(store, id, { now });
        if (r.ok) ok++;
        else console.log(`  ${id}: not logged (${r.reason}${r.detail ? " — " + r.detail : ""})`);
      }
      saveStore(DATA, store);
      console.log(`Logged ${ok} sent.`);
      return;
    }

    case "skip": {
      const id = args[0] || fail("usage: skip <id>");
      const r = skipDraft(store, id, { now, why: typeof flags.why === "string" ? flags.why : "" });
      if (!r.ok) fail(`${id}: ${r.reason}`);
      saveStore(DATA, store);
      console.log(`Skipped ${id}.`);
      return;
    }

    case "reply": {
      const phone = needPhone(args.shift());
      const text = args.join(" ");
      if (!text) fail('usage: reply <phone> "what they said"');
      const r = handleInbound(store, { from: phone, body: text }, { now, config });
      if (r.duplicate) {
        console.log("Already logged that one.");
        return;
      }
      writePage(store, config, now);
      saveStore(DATA, store);
      const who = r.leads.map((l) => l.name).filter(Boolean).join(" / ") || prettyPhone(phone);
      const c = r.classification;
      if (c.type === "OPT_OUT") {
        console.log(`${who} opted out. No more texts to ${prettyPhone(phone)}.`);
        if (r.replyDraft?.id) console.log(`Send them this once, then log it: [${r.replyDraft.id}] ${r.replyDraft.body}`);
      } else if (c.type === "HELP") {
        if (r.replyDraft?.id) console.log(`Reply with: [${r.replyDraft.id}] ${r.replyDraft.body}`);
      } else {
        console.log(`${who}: ${c.priority.toUpperCase()} — ${c.reasons.join(", ")}. Automated texts to this number are on hold until: handled ${phone}`);
      }
      return;
    }

    case "optout":
    case "consent":
    case "handled":
    case "sold":
    case "lost": {
      const phone = needPhone(args[0]);
      let a = { phone };
      if (cmd === "optout") a.why = typeof flags.why === "string" ? flags.why : "";
      if (cmd === "consent") {
        a.source = typeof flags.source === "string" ? flags.source : "";
        if (!a.source.trim()) fail('say how they agreed: consent <phone> --source "asked on call 10/20"');
      }
      if (cmd === "sold" || cmd === "lost") {
        const leads = leadsByPhone(store, phone);
        if (leads.length !== 1) fail(leads.length ? "more than one lead on that number; use the Command Center" : "no lead with that number");
        a = { leadId: leads[0].id };
      }
      const r = runAction(cmd, a, store, { now, config });
      if (!r.ok) fail(`${r.reason}${r.detail ? " — " + r.detail : ""}`);
      saveStore(DATA, store);
      console.log(r.label + ".");
      return;
    }

    case "serve": {
      const port = flags.port ? Number(flags.port) : 4777;
      const { urls } = await startServer({
        dataDir: DATA,
        config,
        port,
        lan: Boolean(flags.lan),
        nowFn: flags.now ? () => now : () => new Date(),
      });
      console.log("Command Center is running. Private: only works with this link.");
      for (const u of urls) console.log("  " + u);
      if (flags.lan) console.log("Phones on the same Wi-Fi can use the second link. Don't share it.");
      console.log("Leave this window open. Ctrl+C to stop.");
      return new Promise(() => {});
    }

    case "status": {
      const leads = Object.values(store.leads);
      const sent = store.outbound.filter((m) => m.status === "sent");
      console.log(`Leads: ${leads.length} (${leads.filter((l) => l.consent === true).length} can be texted, ${leads.filter((l) => !l.phone).length} no phone)`);
      console.log(`Opted out numbers: ${Object.keys(store.optOuts).length}`);
      console.log(`Texts logged sent: ${sent.length}. Drafts open: ${store.outbound.filter((m) => m.status === "draft").length}`);
      console.log(`Replies waiting: ${openHandoffs(store).length}`);
      console.log(`Mode: ${config.mode}${config.killSwitch ? " — KILL SWITCH ON" : ""}. Send window ${config.sendStart}-${config.sendEnd}.`);
      return;
    }

    case "send": {
      if (!flags["dry-run"])
        fail("Automatic sending is not set up yet (needs a texting provider and 10DLC registration). Use --dry-run to test the path.");
      buildDrafts(store, { now, config });
      const provider = dryRunProvider();
      for (const m of store.outbound.filter((x) => x.status === "draft")) {
        const r = await sendDraft(store, m.id, { now, config, provider });
        if (!r.ok) console.log(`  [${m.id}] held: ${r.reason}${r.detail ? " — " + r.detail : ""}`);
      }
      saveStore(DATA, store);
      return;
    }

    case "pipe": {
      // Mac Remote passes the phone message as ONE argument (never split, never a shell).
      const text = [...args].join(" ").slice(0, 300);
      let provider = null;
      if (config.mode === "auto" && !config.killSwitch && process.platform === "darwin") {
        try {
          provider = macMessagesProvider();
        } catch {}
      }
      try {
        const out = await withStoreLock(DATA, async () => {
          const s = loadStore(DATA);
          const r = await runPipe(text, s, { now, config, provider });
          if (r.changed) saveStore(DATA, s);
          return r;
        });
        console.log(out.reply);
      } catch (e) {
        console.log(e.code === "STORE_BUSY" ? "Busy saving, try again in a minute." : `Error: ${e.message}`);
        process.exitCode = 1;
      }
      return;
    }

    case "auto": {
      const state = autoState(config, { live: Boolean(flags.live) });
      for (const n of state.notes) console.log(n);
      let provider;
      if (state.live) {
        try {
          provider = macMessagesProvider();
        } catch (e) {
          fail(e.message);
        }
      } else provider = dryRunProvider(() => {}); // we print our own, deduplicated lines below
      const client = config.notionToken ? notionClient({ token: config.notionToken }) : null;
      const SYNC_EVERY_MS = 2 * 60 * 1000;
      let lastSync = -Infinity;
      const shown = new Set();
      let first = true;

      for (;;) {
        const t = flags.now ? now : new Date();
        // Bookings arrive in Notion, so pull them in (and push back saved taps) every couple of minutes.
        if (client && t.getTime() - lastSync >= SYNC_EVERY_MS) {
          lastSync = t.getTime();
          const r = await syncNotion(DATA, config, client, { now: t, graceMs: GRACE_MS });
          if (!r.ok) console.log(`Notion not reachable (${r.error}). Using the leads already saved.`);
        }
        const rep = await withStoreLock(DATA, async () => {
          const s = loadStore(DATA);
          return autoTick(s, { now: t, config, provider, persist: () => saveStore(DATA, s) });
        });
        const stamp = t.toISOString();
        for (const m of rep.sent) console.log(`${stamp} sent [${m.id}] ${m.template} to ${prettyPhone(m.to)}`);
        for (const m of rep.wouldSend)
          if (!shown.has(m.id)) {
            shown.add(m.id);
            console.log(`${stamp} would text ${prettyPhone(m.to)} (${m.template}): ${m.body}`);
          }
        for (const m of rep.failed)
          console.error(`${stamp} FAILED [${m.id}] ${m.template} to ${prettyPhone(m.to)}: ${m.detail}. Marked failed and will NOT be retried. Check whether it went out before sending it by hand.`);
        if (first) {
          const held = rep.held.map((m) => `${m.template}: ${m.reason}`);
          console.log(
            `${stamp} first pass: ${rep.sent.length + rep.wouldSend.length} ready, ${rep.held.length} held${held.length ? " (" + [...new Set(held)].join("; ") + ")" : ""}, ${rep.notAuto.length} left as drafts for you.`
          );
          first = false;
        }
        if (rep.stop) fail("Stopped after a failed send. Fix Messages, then start auto again.");
        if (flags.once) return;
        await new Promise((r) => setTimeout(r, 60 * 1000));
      }
    }

    default:
      fail(`unknown command "${cmd}". Run with no arguments for help.`);
  }
}

main().catch((e) => fail(e.message));
