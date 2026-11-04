import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  listSlugs, loadListing, saveListing, blankListing, listingPath, parsePrice, money,
  checkReady, startPriceChange, markSigned, signatureStatus, markLive,
} from "./listing.js";
import { packetHtml, addendumHtml, packetText } from "./packet.js";

/** Writes the packet to out/listings/<name>/ (gitignored). Returns the paths. */
export function writePacket(l, outDir, { now = new Date() } = {}) {
  const dir = join(outDir, "listings", l.slug);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = {
    packet: join(dir, "packet.html"),
    addendum: join(dir, "addendum.html"),
    text: join(dir, "messages.txt"),
  };
  writeFileSync(files.packet, packetHtml(l, { now }), { mode: 0o600 });
  writeFileSync(files.addendum, addendumHtml(l, { now }), { mode: 0o600 });
  writeFileSync(files.text, packetText(l) + "\n", { mode: 0o600 });
  return files;
}

function showStatus(l) {
  const pc = l.pendingChange;
  const lines = [`${l.slug}: ${l.address || "(no address)"} — listed at ${money(l.currentPrice)}`];
  if (!pc) lines.push("  No price change in progress.");
  else if (pc.liveAt) lines.push(`  Last change: ${money(pc.from)} -> ${money(pc.to)}, live ${pc.liveAt.slice(0, 10)}.`);
  else {
    const st = signatureStatus(l);
    lines.push(`  Change to ${money(pc.to)} (${pc.pct}%): ${st.signed.length} of ${st.signed.length + st.waiting.length} signed.`);
    Object.keys(pc.signatures).forEach((n, i) => lines.push(`    ${i + 1}. ${n}: ${pc.signatures[n] ? "signed " + pc.signatures[n].slice(0, 10) : "waiting"}`));
  }
  return lines.join("\n");
}

export function runListing(args, flags, { dataDir, outDir, now, fail }) {
  const sub = args.shift();
  const str = (k) => (typeof flags[k] === "string" ? flags[k] : "");

  try {
    if (!sub || sub === "list") {
      const slugs = listSlugs(dataDir);
      if (!slugs.length) return console.log('No listings yet. Start one: listing new <name> --address "123 Main St" --price 389000');
      for (const s of slugs) console.log(showStatus(loadListing(dataDir, s)));
      return;
    }

    const slug = args.shift() || fail(`usage: listing ${sub} <name>`);

    switch (sub) {
      case "new": {
        const path = listingPath(dataDir, slug);
        if (existsSync(path)) fail(`${slug} already exists: ${path}`);
        const price = flags.price ? parsePrice(flags.price) : null;
        if (flags.price && !price) fail(`--price "${flags.price}" is not a price`);
        saveListing(dataDir, blankListing(slug, { address: str("address"), price }));
        console.log(`Created ${path}`);
        console.log("Fill in sellers, agents, comps and offers there. It never leaves this machine (data/ is not committed).");
        console.log("Format: see examples/listing-sample.json");
        return;
      }

      case "status":
        return console.log(showStatus(loadListing(dataDir, slug)));

      case "price": {
        const l = loadListing(dataDir, slug);
        const { blocking } = checkReady(l);
        if (blocking.length) fail(`listing file is missing: ${blocking.join(", ")}`);
        const to = args[0] || fail(`usage: listing price ${slug} <new price> [--reason "..."]`);
        const { change, warnings } = startPriceChange(l, { to, reason: str("reason"), now, replace: Boolean(flags.replace), force: Boolean(flags.force) });
        saveListing(dataDir, l);
        const files = writePacket(l, outDir, { now });
        console.log(`Price change ready: ${money(change.from)} -> ${money(change.to)} (${change.pct}%).`);
        warnings.forEach((w) => console.log("Check: " + w));
        const { missing } = checkReady(l);
        if (missing.length) console.log(`Missing (packet still works): ${missing.join("; ")}`);
        console.log(`Open on your phone: ${files.packet}`);
        console.log(`Form to sign:       ${files.addendum}`);
        console.log(`Plain text:         ${files.text}`);
        console.log(`Nothing was sent. Each seller signs, then: listing signed ${slug} <#>`);
        return;
      }

      case "packet": {
        const l = loadListing(dataDir, slug);
        if (!l.pendingChange) fail(`no price change on ${slug}. Start one: listing price ${slug} <new price>`);
        const files = writePacket(l, outDir, { now });
        return console.log(`Rebuilt: ${files.packet}`);
      }

      case "signed": {
        const l = loadListing(dataDir, slug);
        const r = markSigned(l, args.join(" "), { now, undo: Boolean(flags.undo) });
        saveListing(dataDir, l);
        writePacket(l, outDir, { now });
        console.log(`${r.name}: ${flags.undo ? "signature removed" : "signed"}. ${r.signed.length} of ${r.signed.length + r.waiting.length} done.`);
        if (r.allSigned) console.log(`Everyone signed. Send the form to your broker, update MLS, then: listing live ${slug}`);
        else console.log(`Waiting on: ${r.waiting.join(", ")}`);
        return;
      }

      case "live": {
        const l = loadListing(dataDir, slug);
        const pc = markLive(l, { now, force: Boolean(flags.force) });
        saveListing(dataDir, l);
        const files = writePacket(l, outDir, { now });
        console.log(`Recorded: ${l.slug} now listed at ${money(pc.to)}.`);
        const n = l.offers.filter((o) => o.email).length;
        if (n) console.log(`${n} buyer follow-up${n === 1 ? "" : "s"} ready to send: ${files.packet}`);
        return;
      }

      default:
        fail(`unknown listing command "${sub}". Run with no arguments for help.`);
    }
  } catch (e) {
    fail(e.message);
  }
}
