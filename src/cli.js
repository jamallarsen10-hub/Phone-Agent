#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { loadStore, saveStore, leadsByPhone, openHandoffs } from "./store.js";
import { importLeads } from "./leads.js";
import { buildDrafts } from "./drafts.js";
import { renderPage } from "./page.js";
import { handleInbound, clearHandoffs } from "./inbound.js";
import { markSent, skipDraft, sendDraft, dryRunProvider } from "./send.js";
import { toE164, prettyPhone } from "./phone.js";
import { toCSV } from "./csv.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = resolve(process.env.PHONE_AGENT_DATA || join(ROOT, "data"));
const OUT = resolve(process.env.PHONE_AGENT_OUT || join(ROOT, "out"));

const HELP = `Phone Agent — drafts-first text follow-up

Daily:
  drafts                     Build today's list -> out/today.html (open it on your phone)
  sent <id> [id...]          Log texts you sent (the page builds this command for you)
  reply <phone> <text>       Log a text a customer sent you (STOP, questions, anything)

Setup and fixes:
  import <export.csv>        Load or refresh leads from a CDK export (never deletes)
  consent <phone> --source "how they said yes"   Record permission to text
  optout <phone>             Record a do-not-text you got another way (call, email)
  handled <phone>            You answered their reply; follow-ups may resume
  skip <id> [--why "..."]    Drop a draft you will not send
  status                     Counts, opt-outs, open replies
  send --dry-run             Run drafts through the automatic path without sending

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

    case "optout": {
      const phone = needPhone(args[0]);
      if (!store.optOuts[phone]) {
        store.optOuts[phone] = { at: now.toISOString(), via: "manual", text: typeof flags.why === "string" ? flags.why : "" };
      }
      for (const m of store.outbound) if (m.phone === phone && m.status === "draft") m.status = "expired";
      saveStore(DATA, store);
      console.log(`${prettyPhone(phone)} is opted out. It will not get another text.`);
      return;
    }

    case "consent": {
      const phone = needPhone(args[0]);
      const source = typeof flags.source === "string" ? flags.source.trim() : "";
      if (!source) fail('say how they agreed: consent <phone> --source "asked on call 10/20"');
      if (store.optOuts[phone])
        fail(`${prettyPhone(phone)} sent STOP. Only the customer can opt back in, by texting START; confirm with them, then remove the opt-out by hand in data/store.json.`);
      const leads = leadsByPhone(store, phone);
      if (!leads.length) fail(`no lead with ${prettyPhone(phone)}. Import it first.`);
      for (const l of leads) {
        l.consent = true;
        l.consentSource = source;
        l.consentAt = now.toISOString();
      }
      saveStore(DATA, store);
      console.log(`Permission to text recorded for ${leads.map((l) => l.name || "unnamed").join(", ")}.`);
      return;
    }

    case "handled": {
      const phone = needPhone(args[0]);
      const n = clearHandoffs(store, phone, { now });
      saveStore(DATA, store);
      console.log(n ? `Cleared ${n} repl${n === 1 ? "y" : "ies"} for ${prettyPhone(phone)}.` : "Nothing open for that number.");
      return;
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

    default:
      fail(`unknown command "${cmd}". Run with no arguments for help.`);
  }
}

main().catch((e) => fail(e.message));
