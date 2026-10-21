# Phone Agent

> **AI assistants:** read [AGENTS.md](AGENTS.md) before pushing. Owner's rule: always keep a way back to the old version.

Drafts-first text follow-up for Jamal's Woburn Toyota leads.

It reads your CDK lead export and works out who is due for a text today: a missed appointment, a test drive yesterday, a new lead, or a follow-up date that came up. It writes each message and checks every rule.

Everything lands in the **Command Center**, a private page in the same look as your booking site. Each card opens Messages with the text already filled in, and you send it yourself. One tap logs what happened:

- Sent, Skip, Handled
- Sold, Lost, Showed, No-show
- OK to text, Opt out

Undo covers the last tap.

Automatic sending uses the same engine and the same gate. It stays off until you switch it on, and then it only covers confirmations and reminders (see **Automatic confirmations and reminders on your Mac**).

Zero dependencies. Plain Node 18+. Nothing hosted, no accounts, $0.

## Setup (once)

1. Install Node 18 or newer.
   - Mac: nodejs.org
   - Tablet (Termux): `pkg install nodejs`
2. Get this folder onto the machine (`git clone` or download the zip).
3. **Connect your Notion Lead Pipeline (recommended).** This takes about 5 minutes.
   1. Go to notion.so/my-integrations and create a new integration named `Phone Agent`.
      - Type: Internal.
      - Capabilities: **Read content** and **Update content**.
      - This is a second integration. The booking page's `Lead Capture` key can only add pages, so it can't be used here.
   2. Copy its secret (starts with `ntn_`).
   3. In Notion, open **🚗 Lead Pipeline — Woburn Toyota** → `···` → **Connections** → add `Phone Agent`.
   4. Create `data/config.json` with your secret:

      ```json
      { "notionToken": "ntn_your_secret_here" }
      ```

   5. Run `node src/cli.js sync`. It should say how many leads it pulled.

   No Notion? Export leads from CDK to CSV and run `node src/cli.js import leads.csv` instead.

## Daily routine (about 5 minutes)

```
node src/cli.js import ~/Downloads/leads.csv   # fresh export, if you have one
node src/cli.js serve                           # opens the Command Center
```

`serve` prints a private link. Open it in the browser on the same device and leave the window running.

1. **Waiting on you** is on top. Buying signals (price, payment, trade, "call me") glow gold, and "read first" items glow red. Call the gold ones first, then tap **Handled**.
2. **Text these**: tap *Open in Messages*, hit send, come back, tap **Sent**.
3. **Call instead**: due today but no permission to text. Ask on the call, then tap **OK to text**.
4. Wrong tap? Hit **Undo** in the bottom bar.

When a customer texts you back, log it. STOP is saved before anything else happens:

```
node src/cli.js reply 617-555-0101 "how much would my payment be?"
```

### Who can see it

Only you. The Command Center runs on your own device, and nothing is uploaded or published.
- It only answers on this device (`127.0.0.1`), and only to the private link printed at start, which turns into a cookie.
- Other websites can't press its buttons.
- The page never caches or leaks the link.

`serve --lan` lets your phone open it while it runs on your Mac or tablet on the same Wi-Fi. That still needs the private link.

No server? `node src/cli.js drafts` writes the same page to `out/today.html`. There you tick Sent and copy the one command it builds (`node src/cli.js sent <ids>`).

## How it follows your Notion sequence

It drafts the same touches you track in **Touches Sent**. When you tap **Sent**, it writes the touch back to Notion along with **Last Contact**.

| Touch | When it's due |
|---|---|
| `confirm` | Any upcoming appointment that hasn't been confirmed. Sending it moves **New Request** to **Accepted**. |
| `reminder-night` | The day before. Skipped if the confirm went out that same day. |
| `reminder-2h` | Within 3 hours of the appointment time. |
| `noshow-3h` | 3 hours after a **No Show** (tap No-show, or set the stage in Notion). |
| `nosale-1d` / `3d` / `7d` / `30d` | Days after a **Showed** visit. A missed step is skipped, never stacked. |
| `sold-review`, `sold-6mo` | After you mark **Sold** here. Old sales aren't guessed at. The review text waits until `reviewUrl` is in `data/config.json`. |
| `cdk-intro` → `cdk-bump` → `cdk-last` | For **CDK Lead** stage. The bump comes 3 days after the last text, the final one 4 days after that. |
| Follow-Up date | When it arrives, unless Last Contact is already on or after it. Sending it moves Follow-Up 7 days ahead. |

Taps on Sold, Lost, Showed and No-show set **Stage** in Notion. Opt-outs and permission you record here are added as one line in **Notes**, so Notion keeps the record.

Each change waits 75 seconds before it's sent, longer than the 60-second Undo, so an undone tap never reaches Notion. If Notion is unreachable, changes stay queued and the page says so.

**Who can be texted.** The booking page tells every customer "By sending, you're OK with me texting you about this visit." That covers the confirm, both reminders, the no-show text and the day-after text. Everything else needs one of these:
- the "Also OK to text me after my visit" box ticked on the booking page
- `OK to text follow-ups` in the lead's Notes
- an **OK to text** tap after they agree on a call

Walk-ins and CDK leads with none of these land on **Call instead**. This is a design choice, not legal advice; adjust it with your dealership if needed.

## Rules it enforces

Every text passes through one gate (`src/guardrails.js`). Nothing else decides whether a number gets texted.

- **Consent**: a lead is texted only with permission on file, from an export column that says yes or from `consent <phone> --source "..."`. A blank cell is not a yes. Leads without consent who are due land on **Call instead**.
- **STOP** applies to the number, not the person, so a whole household is covered.
  - Only a clear opt-out counts as STOP. "Stopping by at 3" does not.
  - Anything ambiguous goes to you marked urgent.
  - START never resumes texting on its own; you confirm by hand.
  - Each opt-out gets exactly one confirmation text.
- **One follow-up text per number per day**, counted in Woburn time. Appointment texts (confirm, reminders) get their own cap of 2, so a same-day booking can be confirmed and reminded. A routine follow-up waits 2 days after any earlier text.
- **Quiet hours**: send window is Mon–Sat, 9 AM to 8 PM. This is a guess; confirm it and change it in `data/config.json`.
- **No prices in any text.** No template has a price slot. A denylist also blocks `$`, payments, APR, discounts, trade values, and "approved". If a CRM field contains price words, that draft is held and you write it yourself.
- **Every text says it's Jamal at Woburn Toyota** and ends with "Reply STOP to opt out."
- **When someone replies, automated texts to that number hold** until you run `handled`.
- **Sold, delivered, lost, and dead leads are skipped**, and so are leads with an appointment today or later.
- **Kill switch**: `KILL_SWITCH=true node src/cli.js drafts` produces nothing.

## Automatic confirmations and reminders on your Mac

**This ships OFF.** Nothing is texted automatically until you turn it on, and it only ever sends three kinds of text: the booking confirmation, the night-before reminder, and the 2-hour reminder, to people who booked and were told on the booking page that you'd text them about the visit. Follow-ups, no-show texts, CDK sequences and everything else stay drafts that you send yourself.

**Not tested on a Mac yet.** This was built on Linux and has never been run against a real Messages app. Two things are unknown until you try it: whether the SMS route still works on your version of macOS (including the newest), and whether the Mac has to be awake or unlocked while it sends. Your first live test decides both.

### How it works

`auto` builds today's drafts, keeps only the three allowed templates (`autoTemplates` in `data/config.json`), and hands each one to the Messages app on your Mac. Messages relays it as a normal SMS from your iPhone, so it comes from your number and uses your own plan. It costs $0.

- Every text goes through the same gate as always, checked again at the moment of sending: permission, STOP, hours, no prices, daily limits, and your kill switch.
- If a Notion token is set, `auto` pulls new bookings from Notion every 2 minutes, and writes each text back (Touches Sent, Last Contact) exactly as the **Sent** tap does.
- It waits about 5 seconds between texts.
- The message and phone number reach AppleScript as arguments, never inside the script, so nothing in a name or template can change what the script does.

### Two switches, both required

1. `"mode": "auto"` in `data/config.json`
2. `--live` on the command

With only one of them, or with `KILL_SWITCH=true`, `auto` runs as a dry run: it prints what it would text and texts no one.

### What the Mac and iPhone need

- Messages is signed in to your Apple ID. `auto` launches it if it isn't running.
- iPhone: Settings → Messages → Text Message Forwarding → turn on for this Mac. The iPhone has to be on and connected.
- The Mac stays on while it runs (leave `auto` running in a window).
- First run only: macOS will ask to let Terminal (or whatever runs `node`) control Messages. If you missed it: System Settings → Privacy & Security → Automation.

### First run, in this order

1. **Dry run:** `node src/cli.js auto --once`. It lists the texts it would send. Nothing is sent.
2. **One real text to yourself, in a separate data folder so no customer can be texted.** Make a one-row export with your own number, an appointment date in the future and `OK to Text` = Y, for example:

   ```
   Customer Name,Cell Phone,Vehicle of Interest,Status,Appt Date,OK to Text
   Test Me,(your number),RAV4 Hybrid,Appointment Set,10/30/2026,Y
   ```

   Then, with `PHONE_AGENT_DATA=~/pa-test/data` in front of each command: `import` that file, put `{ "mode": "auto" }` in `~/pa-test/data/config.json`, and run `node src/cli.js auto --once --live` during sending hours (Mon–Sat, 9 AM–8 PM).
3. **Check what arrived on your phone.** It should be a green SMS bubble, not a blue iMessage. If it didn't arrive, or came as iMessage, stop. The one place to change is `APPLESCRIPT_LINES` in `src/providers/macMessages.js`.
4. Only after that, switch to your real data folder.

### If something goes wrong

- Any error from Messages stops the run and marks that text **failed**. It is never retried automatically, because Messages can't confirm delivery and a retry could text a customer twice. Check Messages, then tap **Sent** or **Skip** in the Command Center.
- A text that was cut off mid-send is held the same way (`UNKNOWN_OUTCOME`), never re-sent.
- Messages can't report delivery, and iMessage can quietly take over from SMS, so "sent" here means Messages accepted it.
- `serve` and `auto` use the same data file. A tap and an automatic send in the same second could collide. Rare, but if you notice something missing, stop `auto`, then re-run `sync`.

Whether Woburn Toyota is fine with this is still your call (see **Not built yet**). None of this is legal advice. Confirm texting rules with the dealership before turning on automatic sending.

## CDK export columns

Header matching ignores case and punctuation. Unknown columns are listed and ignored. Nothing is ever deleted on re-import, and a blank cell never erases what was there.

| Reads | Headers it recognizes (first match wins) |
|---|---|
| name | Customer Name, Name, First Name + Last Name |
| phone | Cell Phone, Mobile, Phone, Primary Phone, Home Phone |
| vehicle | Vehicle of Interest, Vehicle, Model |
| stage | Status, Stage, Lead Status |
| new-lead date | Lead Date, Created, Date Created |
| follow-up date | Next Follow Up, Follow Up Date, Next Contact, Due Date |
| appointment | Appt Date, Appointment, plus Showed (Y/N) |
| test drive | Test Drive Date, Demo Date |
| consent | OK to Text, SMS Consent, Text Consent, Opt In |

`examples/cdk-export-sample.csv` is fake data showing the shape. To see a full day:

```
PHONE_AGENT_DATA=/tmp/pa/data PHONE_AGENT_OUT=/tmp/pa/out node src/cli.js import examples/cdk-export-sample.csv
PHONE_AGENT_DATA=/tmp/pa/data PHONE_AGENT_OUT=/tmp/pa/out node src/cli.js drafts --now 2026-10-21T10:00:00-04:00
```

## All commands

```
serve [--lan] [--port N]    the Command Center (one-tap; pulls Notion when opened)
sync                        pull Notion now and save any waiting taps
drafts                      build today's page as a file, plus a CSV
sent <id> [id...]           log texts you sent
sold <phone> / lost <phone> stop follow-ups for a lead
reply <phone> <text>        log a text a customer sent you
import <file.csv>           load or refresh leads
consent <phone> --source "how they agreed"
optout <phone>              record a do-not-text you got by call or email
handled <phone>             you answered; follow-ups may resume
skip <id> [--why "..."]     drop a draft
status                      counts and settings
send --dry-run              run drafts through the automatic path; prints, sends nothing
auto [--once] [--live]      confirmations and reminders via Messages on your Mac; a dry run unless mode is "auto" AND --live
```

## Where things live

```
src/guardrails.js   the one send gate
src/keywords.js     reads inbound texts (STOP, HELP, buying signals)
src/templates.js    the messages, plus strict rendering and segment math
src/priceBlock.js   price/finance denylist
src/drafts.js       who is due today, one per number, idempotent
src/inbound.js      handles replies: dedup, STOP first, handoff to you
src/send.js         log a manual send, or the automatic path
src/auto.js         the `auto` pass: allowlisted texts only, two switches, never double-sends
src/providers/macMessages.js   sends through Messages on a Mac (osascript, arguments only)
src/leads.js        CSV import and merge
src/notion.js       Notion pull, write-back queue, and the 75-second grace period
src/page.js         the Command Center page (booking-site look)
src/server.js       private local server for one-tap actions
src/actions.js      every tap: sent, skip, handled, sold, lost, showed, no-show, consent, opt out
data/               your leads and log (store.json + one backup). Gitignored.
out/                today's page and CSV. Gitignored.
```

Customer data never goes in git: `data/`, `out/` and every `*.csv` except the example are ignored.

**This repo is currently public.** The code holds no customer data. Still, before anything sensitive could end up here, set it to private: GitHub → Settings → Danger Zone → Change visibility.

## Not built yet (decisions only you can make)

1. **Merge the booking-page branch.** `jamal-booking-site` branch `claude/booking-text-loop` records texting permission with every booking and adds the optional follow-ups checkbox. It changes the live site, so it waits for your review.
2. **Dealership policy.** Confirm Woburn Toyota is fine with you texting customers from a system like this, and whether the sender is you or the dealership.
3. **Automatic sending.** The free Mac route is built but untested (see **Automatic confirmations and reminders on your Mac**), and `mode` stays `"drafts"` until you switch it on. Texting through Twilio or Telnyx instead would need US carrier registration (10DLC: brand + campaign). Check current fees and timelines on the provider's own pages.
4. **Sending hours.** Confirm the 9 AM–8 PM, Mon–Sat window.

None of this is legal advice. Confirm texting rules with the dealership before turning on automatic sending.

## Tests

```
npm test
```

70 tests. They cover:
- STOP edge cases, START/HELP, and buying signals
- price blocking and template rules
- quiet hours across DST, the daily limit at midnight, and shared phone numbers
- duplicate webhooks, and provider timeouts never double-texting
- a full CLI day on the sample export
- the Command Center's lock (no key, wrong host, or a cross-site tap are all refused), and undo
- a booking run end to end against a fake Notion: confirm → Sent → write-back (merging touches, keeping links in Notes) → reminders → STOP, plus Undo never reaching Notion
- the Mac sender: message and number passed as arguments (a hostile message can't change the script), refuses to run off a Mac, bad numbers never reach osascript, the pause between texts
- the automatic pass: ships off, both switches needed, kill switch, STOP, quiet hours, only the three allowed templates, never a double send, a failed send stops the run and is never retried
