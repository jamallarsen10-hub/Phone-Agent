# Phone Agent

Drafts-first text follow-up for Jamal's Woburn Toyota leads.

It reads your CDK lead export and works out who is due for a text today: a missed appointment, a test drive yesterday, a new lead, or a follow-up date that came up. It writes each message and checks every rule.

Everything lands in the **Command Center**, a private page in the same look as your booking site. Each card opens Messages with the text already filled in, and you send it yourself. One tap logs what happened:

- Sent, Skip, Handled
- Sold, Lost, Showed, No-show
- OK to text, Opt out

Undo covers the last tap.

Automatic sending uses the same engine and the same gate. It stays off until a texting provider and 10DLC registration are in place (see **Not built yet**).

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
3. **Provider and 10DLC.** Automatic sending needs one provider (Twilio or Telnyx) plus US carrier registration (brand + campaign). Check current fees and timelines on the provider's own pages. Until then, `mode` stays `"drafts"`.
4. **Sending hours.** Confirm the 9 AM–8 PM, Mon–Sat window.

None of this is legal advice. Confirm texting rules with the dealership before turning on automatic sending.

## Tests

```
npm test
```

56 tests. They cover:
- STOP edge cases, START/HELP, and buying signals
- price blocking and template rules
- quiet hours across DST, the daily limit at midnight, and shared phone numbers
- duplicate webhooks, and provider timeouts never double-texting
- a full CLI day on the sample export
- the Command Center's lock (no key, wrong host, or a cross-site tap are all refused), and undo
- a booking run end to end against a fake Notion: confirm → Sent → write-back (merging touches, keeping links in Notes) → reminders → STOP, plus Undo never reaching Notion
