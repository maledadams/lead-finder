<div align="center">

# 🧭 Lead Finder

**Self-hosted lead generation and cold outreach on Cloudflare Workers.**

It finds small businesses that need your services, scores them against your own
taste, drafts a personal email to each one, and puts them in front of you to
approve — one at a time. It runs on a schedule, on Cloudflare's free-ish tier,
with your computer switched off.

Not a scraper you run by hand, and not a mail-merge tool. A persistent pipeline
that gets better at picking leads the more you tell it why you skipped one.

<br>

[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
&nbsp;
![Tests](https://img.shields.io/badge/tests-122%20passing-brightgreen.svg)
&nbsp;
![Runs on Cloudflare Workers](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-F38020.svg?logo=cloudflare&logoColor=white)
&nbsp;
![No LLM API key](https://img.shields.io/badge/LLM%20API%20key-not%20required-success.svg)
&nbsp;
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---

## Table of contents

- [Who it is for](#who-it-is-for)
- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Profiles: several outreach operations, one deployment](#profiles-several-outreach-operations-one-deployment)
- [Making it yours](#making-it-yours)
- [The review dashboard](#the-review-dashboard)
- [The calendar](#the-calendar)
- [Settings](#settings)
- [Documentation](#documentation)
- [Metrics](#metrics)
- [What it costs to run](#what-it-costs-to-run)
- [Legal: CAN-SPAM and crawling](#legal-can-spam-and-crawling)
- [Security model](#security-model)
- [FAQ](#faq)
- [Limitations](#limitations)
- [Contributing](#contributing)

---

## Who it is for

Freelancers and small studios who sell a service to small businesses, and whose
best leads are findable on the open web: web designers, developers, brand
studios, photographers, copywriters, marketing consultants, fractional
operators.

It works best when three things are true:

1. **Your ideal customer is a small, independent business with a website** (or
   conspicuously without one).
2. **You can say why a lead is good or bad** in a sentence. The system learns
   from those sentences.
3. **You send a low volume of considered emails**, not thousands of templated
   ones. The default ceiling is 30 a day and it is a hard cap.

It is a poor fit for enterprise sales, for anything requiring intent data or
firmographics you cannot see on a website, and for high-volume sequencing.

## What it does

| Stage | What happens |
|---|---|
| **Discovery** | Finds candidate businesses on its own from four sources. No lists to buy, no seeding by hand. |
| **Deduplication** | One business is one record, no matter how many URLs, handles and shopfronts it appears under. |
| **Scoring** | Cheap deterministic rules first, then a single AI call only for candidates that already earned it. |
| **Drafting** | Writes a specific, evidence-backed email — or writes nothing, if there is nothing honest to say. |
| **Review** | You approve, edit, or skip each one. Skipping always asks why. |
| **Sending** | Sends through your own mailbox, with your real signature, under a hard daily cap. |
| **Learning** | Your skip reasons become rules that outrank the model's own judgement. |
| **Follow-through** | Tracks replies, bounces and silence, and returns bounced businesses to the pool when a better address appears. |

### Discovery: no manual seeding

Four channels, all automated:

- **OpenStreetMap** — businesses by category and metro area, including ones
  with no website at all, which are often the strongest leads.
- **Certificate Transparency logs** — every new HTTPS domain is published;
  filtered to plausible independent brands.
- **Link graph** — independent brands link to independent brands. Stockist
  pages, "brands we love", collaborations and press pages propagate taste.
- **Keyword harvesting** — mines Wikipedia and its own corpus for new search
  terms, then validates which ones actually produce leads.

## How it works

Four cron triggers. That is the whole schedule.

```
05:00 UTC  crawl    discover, fetch, extract, score, evaluate — budget-capped
06:00 UTC  crawl
07:00 UTC  crawl
11:00 UTC  queue    rank everything eligible, take the best few, draft emails
```

The pipeline is staged so expensive work only reaches candidates that have
already earned it:

```
OSM sweep + CT logs + link graph + stale pool
      ↓
dedup             D1 lookup on every known identifier      free
      ↓
fetch + extract   robots-respecting, content-hash cached   cheap
      ↓
hard filters      parked domains, corporates, empty sites  free
      ↓
rule-based score  7 dimensions from real page signals      free
      ↓
      ├── below MIN_PRESCORE_FOR_AI → stops here, no AI spend
      ↓
AI evaluation     one call, cached by page hash            the only spend
      ↓
final score → rank → daily cap → drafts → your review queue
```

Nothing is re-fetched or re-evaluated while its content hash is unchanged, so
the second run over the same corpus is nearly free.

## Quick start

Nothing in this repository is configured for anybody in particular. There are no
categories, no email copy and no scoring brief in the code — those are written
for **your** business on first run, from one sentence describing who you want to
reach, and they live in your database.

```bash
git clone https://github.com/YOUR-NAME/lead-finder && cd lead-finder
pnpm install                      # pnpm is the package manager here

# 1. Create the database, then paste the printed id into wrangler.toml
pnpm exec wrangler d1 create lead-finder

# 2. Create every table. schema.sql is complete on its own —
#    the files in migrations/ are only for upgrading an existing install.
pnpm run db:init

# 3. Secrets. None of these belong in a file you commit.
pnpm exec wrangler secret put DASHBOARD_KEY          # any long random string
pnpm exec wrangler secret put SESSION_SECRET         # any long random string
pnpm exec wrangler secret put ZOHO_CLIENT_ID         # from your Zoho API console
pnpm exec wrangler secret put ZOHO_CLIENT_SECRET     # from your Zoho API console
pnpm exec wrangler secret put CAL_BOOKING_URL        # optional: your booking link
pnpm exec wrangler secret put CAL_API_KEY            # optional: shows bookings in the dashboard

# 4. Edit wrangler.toml — only the database id and your hostname. No
#    credential lives in that file; everything above is a secret.
#    SENDER_NAME, SENDER_EMAIL and SENDER_POSTAL_ADDRESS are required:
#    the postal address is not optional, CAN-SPAM requires it in every email.

# 5. Deploy, then open your dashboard.
pnpm exec wrangler deploy
```

### First run

Opening the dashboard with an empty database shows a setup screen rather than a
queue, because a database with no profile is a fresh install rather than a fault.
It asks two things — what to call the profile, and who you want to reach:

> Independent dental and orthodontic practices in the United States. Established
> practices with several staff and their own building, not sole traders, and not
> anything owned by a dental group.

From that, a model writes the categories, the classification vocabulary, the
scoring brief, the email copy, the search terms and the OpenStreetMap tags — and
every part of it is validated before the profile exists, because a profile with
an invented map tag would fail silently at crawl time days later.

Then it crawls. There is nothing else to configure and no file to edit.

### Local development

```bash
pnpm run db:init:local          # build a local database from schema.sql
pnpm run dev:test               # a dev server with Access off and a test secret
```

Then open the printed URL with `?key=` and your `DASHBOARD_KEY`.

`pnpm test` is server-side and fast. `pnpm run test:browser` drives the real UI in
Chromium against that dev server, and is worth running before anything that
touches the dashboard: the worst bug in this project's history was an escape
consumed by a template literal, which emitted a syntax error into the page and
killed every handler while all 252 server-side tests stayed green. A rendered
string is not a working page.

```bash
pnpm exec playwright install chromium   # once
pnpm run test:seed                      # fixture data, dated relative to today
pnpm run test:browser
```

It clicks through settings, the profile switcher, pagination, search, the bounce
drawer, skip gating, the documentation editor and a real create-then-delete of a
skip category, and fails on any browser console error.

### Sending email

Sending is optional — without it the dashboard is a copy-and-paste queue. To
send through Zoho Mail:

1. Create a Zoho API client, set `ZOHO_CLIENT_ID` and `ZOHO_REGION` in
   `wrangler.toml`, and `pnpm exec wrangler secret put ZOHO_CLIENT_SECRET`.
2. Open `/api/zoho/connect` in the dashboard and authorise.

Your Zoho signature is fetched from the account and attached at send time.
Messages go as HTML by default so the signature renders as designed; set
`MAIL_FORMAT=plaintext` to send flattened text instead.

## Configuration

Everything below is set in `wrangler.toml` and needs no code change.

| Variable | Default | What it controls |
|---|---|---|
| `DAILY_QUEUE_MAX` | `30` | Most leads that can reach your queue in a day |
| `DAILY_SEND_CAP` | `30` | Hard ceiling on sends per day; no bug can exceed it |
| `MIN_SCORE_TO_QUEUE` | `68` | The recommended line — below it a lead is shown but flagged |
| `ABSOLUTE_FLOOR` | `35` | Below this a lead is never surfaced |
| `MIN_PRESCORE_FOR_AI` | `45` | The gate before any AI spend |
| `SKIP_COOLDOWN_DAYS` | `45` | How long a skipped lead stays out of the queue |
| `RE_EVAL_AFTER_DAYS` | `45` | When an unchanged lead is worth re-scoring |
| `GHOST_AFTER_DAYS` | `30` | Silence after which a lead is marked ghosted |
| `DAILY_FETCH_BUDGET` | `900` | Page fetches per day |
| `DAILY_AI_BUDGET` | `75` | AI evaluations per day |
| `DAILY_BROWSER_RENDERS` | `30` | Headless renders for JavaScript-only sites |
| `MAX_RUN_SECONDS` | `120` | Wall-clock ceiling per crawl run |
| `USER_AGENT` | — | How the crawler identifies itself. **Use a real contact URL.** |
| `REQUIRE_ACCESS` | `true` | Refuse anything that did not arrive through Cloudflare Access |
| `MAIL_FORMAT` | `html` | `html` renders your signature; `plaintext` flattens it |
| `ZOHO_BOUNCE_LABEL` | `bounce` | The mailbox label carrying delivery failure notices |
| `CAL_BOOKING_URL` | — | Your Cal.com booking link. Unset, emails invite a reply instead |
| `CAL_API_KEY` | — | Read-only Cal.com key, so the dashboard can show what is booked |

Per-profile overrides exist for the four budget lines, so one operation can be
given a larger share than another without changing the deployment default.

## Profiles: several outreach operations, one deployment

A profile is a complete outreach operation: who you are looking for, how they
are categorised, what the emails say, what the scoring brief is, and where to
look. Switching profile is switching account — the leads, the drafts, the
replies, the lessons, the keywords, the crawl frontier, the spend and every
metric belong to exactly one profile and are never mixed.

Add one from the sidebar, in a sentence, with no code:

> Medium-sized clinics and private practices in the United States: dental,
> physiotherapy, chiropractic, optometry. Established practices with several
> staff, not sole traders.

A model turns that into the categories, the classification vocabulary, the
scoring brief, the email copy, the search terms and the OpenStreetMap tags —
and every part of it is validated before the profile exists, because a profile
with an invented map tag would fail silently at crawl time days later.

Or `POST /api/profiles` with `{ "name": "...", "brief": "..." }`.

### What profiles share, and why

Four things are shared deliberately. Splitting any of them would be a mistake,
not a feature.

| Shared | Why |
|---|---|
| **Deduplication** | A business belongs to whichever profile discovered it first, and every other profile skips it. Otherwise one person receives two different pitches from the same sender — the worst thing this system could do to a sending reputation. |
| **The daily send cap** | One mailbox has one reputation. Two profiles sending thirty each is sixty cold emails a day from one address. |
| **The booking calendar** | One person has one diary. |
| **Suppressions** | An opt-out is a person's wish, not a profile's preference. |

Everything else is separate, and the test suite asserts it rather than claiming
it: `test/isolation.test.js` gives both profiles data at once and checks that
each page shows one profile's rows and none of the other's.

### Where it looks

`src/metros.js` covers **all fifty states and DC — 1,123 bounding boxes**,
grouped by state so coverage is something you can read rather than infer.

- Box size follows population: a small town is about 9 km across, a large city
  about 22 km, and longitude is scaled by `1/cos(latitude)` so a box in Anchorage
  covers the same ground as one in Miami.
- The nineteen biggest cities are split into grids — New York, Los Angeles,
  Chicago, Houston, Philadelphia and Phoenix are 3×3. One box over New York City
  would be too coarse to mean anything *and* large enough that Overpass truncates
  the answer, silently capping the whole city at whatever came back first.
- The list is walked **round-robin across states**, not alphabetically, so the
  first day of crawling already covers several states rather than spending its
  first month inside Alabama.
- Coordinates come from a public dataset of the ~1,000 largest municipalities,
  plus 42 towns geocoded through OpenStreetMap to fill out Alaska, Hawaii,
  Vermont, the Dakotas and the other states that dataset barely reaches. None
  were typed from memory, which is why no box sits in the ocean.

At the default four boxes per crawl pass and three passes a day, each profile
sweeps twelve cities a day and works through the country in about three months.
Raise `SOURCE_METROS_PER_RUN` to go faster.

Both profiles search everywhere. Their map tags barely overlap — a dental clinic
is never a pottery studio — so they compete for map squares rather than for
businesses, and coverage is worth more than the few duplicate queries it costs.

## Making it yours

There is no longer a list of files to edit. Everything that makes this system
*yours* is a row in your own database, written at setup or changed in Settings:

| What | Where it lives |
|---|---|
| Categories and their vocabulary | `profiles.niches` — generated from your brief |
| The email copy per category | `profiles.personas` — generated, editable |
| The scoring brief the model judges against | `profiles.ai_system` |
| Search terms and Wikipedia sources | `profiles.seed_keywords`, `profiles.discovery` |
| Which OpenStreetMap tags to look for | `profiles.niches[*].osm` |
| Where to crawl | the `regions` table, via Settings |
| Why you skip things | the `skip_categories` table, via Settings |

The code ships one neutral fallback of each, used only until a profile exists.
`examples/profile-medium-businesses.sql` shows what a real one looks like once
it has been generated.

What is *not* configurable, on purpose: the deterministic scoring weights and
hard filters in `src/score.js`, which are about whether a website is any good
rather than about who you want to sell to.

## The review dashboard

Seven pages, server-rendered, no build step, with zero external requests. The
profile switcher is at the top of the sidebar; every page below it shows that
profile and nothing else.

- **Today** — the day's queue. Each card shows the business, why it was
  surfaced, and the full draft. Send, edit, or skip with a reason.
- **Sent** — every email sent, searchable and filterable by date. Mark whether
  they replied, and record a bounce.
- **Skipped** — what you passed on and the reason you gave. Any of them can be
  edited and put back in the queue.
- **Bounced** — dead addresses. Enter a corrected one and requeue.
- **Calendar** — what is booked, across every profile. See below.
- **Metrics** — see below.

### Bounces are detected automatically

Set up a filter in your mail provider that applies a label — `bounce` by
default — to delivery failure notices. On every cron tick the system reads that
label, finds the address the notice is about, and marks the matching lead
bounced without you touching it.

```
Zoho filter:  subject contains "Delivery Status Notification"
              or sender is mailer-daemon
        →     apply label "bounce"
```

Set `ZOHO_BOUNCE_LABEL` in `wrangler.toml` if your label is called something
else. `POST /api/run/bounces` runs it on demand and returns what it found.

**This needs the `ZohoMail.messages.READ` scope**, which grants reading message
headers and nothing else — no scope here can modify or delete mail. If you
connected Zoho before this feature existed, visit `/api/zoho/connect` once to
re-grant; sending keeps working in the meantime and bounce sync reports
`reconnect Zoho` until you do.

Two deliberate limits. A notice naming an address you never wrote to is
recorded and skipped rather than guessed at, because marking the wrong business
bounced would clear a good address. And Zoho Mail has no outgoing webhook for
new mail, so this polls the label four times a day rather than being pushed —
for a handful of bounces a week that is indistinguishable from a push.

### A bounce puts the business back in the pool

A bounce says the address was wrong, not that the business was. Marking one
clears the stored address, records the dead one so it is never adopted again,
and returns the business to the pool. It leaves your roster immediately and
comes back on its own the next time a crawl finds a *different* address.

### Finding the address

Most independent sites keep contact details off the homepage, so the crawler
looks in the places they actually live:

- **The footer first.** A footer address is nearly always the one the business
  wants used; the one higher up the page is as likely to be a shopping cart, a
  press contact or a careers inbox. Footer addresses lead the list and win ties.
- **`mailto:` links, page text, Cloudflare-obfuscated addresses, and numeric
  HTML entities** — writing an address as `&#105;&#110;&#102;&#111;&#64;…` is a
  common way to hide it from scrapers while still showing it to a reader.
- **Addresses written to defeat scrapers**, like `hello (at) brand (dot) com`.
  Only when the page genuinely means it: a bare "at" beside a bare full stop is
  a sentence, not an address.
- **Up to two contact pages**, tried in order of how likely each is to pay off
  (`/contact`, then `/about`, `/stockists`, `/imprint` and so on). This fires
  when no address was found at all, and also when the only one found is poor —
  a homepage offering nothing but `orders@` has not really given you a way to
  reach anyone.

Addresses are then ranked rather than filtered: a likely human first, then
general inboxes a person actually reads, with automated senders — `checkout@`,
`newsletter@`, `noreply@` — refused outright.

**You can set or correct an address by hand at any time**, from any lead on any
page. It edits the business already on file rather than creating a duplicate,
and the address is checked against the block list and DNS before it is stored,
so a dead one cannot be saved.

### Dead addresses never reach you

Before a lead enters the queue, DNS is asked whether its domain can receive
mail at all — MX records, or an address record, which RFC 5321 treats as an
implicit mail exchanger. A domain that does not exist is dropped before you
ever see it, and the same check runs again immediately before every send, so
nothing routes around it.

This is a DNS lookup and nothing more. No message is sent, no SMTP session is
opened, and the business never learns anything happened. Opening an SMTP
conversation to test whether a mailbox exists would reveal more and is exactly
the behaviour this project avoids.

It fails open: if DNS is unreachable the lead is kept, because a wrong "no"
would silently empty your morning queue while a wrong "yes" costs one bounce.

### Skipping teaches it

Every skip asks for a reason, and those reasons are periodically distilled into
rules that outrank the model's own judgement on future leads. A fresh install
has no rules and will surface things you do not want for the first week or two.
That is expected. Skip them with real reasons and it converges.

## The calendar

Every draft ends with the same 15-minute booking link, so the Calendar page
shows what came of it: who booked, when, and the join link, in the reader's own
timezone. It is the one page that is not per profile, because one person has one
diary.

Read-only by design. Cal.com already has a good interface for moving a call, and
a second one here would only be somewhere else to get it wrong. Set
`CAL_BOOKING_URL` for the link in the emails and `CAL_API_KEY` for the page; with
neither set, the emails invite a reply and the page says so.

## Settings

Everything disruptive lives in one sheet, reachable from the sidebar on any
page. A form that sits beside the work invites being filled in by accident.

| Panel | What it does |
|---|---|
| **Where to crawl** | Add a city (geocoded live through OpenStreetMap), import a whole country, set priorities, or block somewhere permanently — blocks apply to the built-in list too. |
| **Skip categories** | Define the buckets the metrics page counts. Name, definition, and optional keywords. |
| **Profiles** | Create, rename, set default, per-profile daily budgets, archive, and permanent deletion. |
| **Sending** | Zoho connection, today's count against the cap, the bounce label. |

**Adding a country is a legal decision, not a geographic one.** CAN-SPAM covers
the United States. The EU is GDPR; Canada is CASL, which requires consent
*before* you send and fines per message. A non-US place is stored and listed but
**not crawled** until that is acknowledged, and the acknowledgement is recorded.

### Skip categories

Raw skip reasons are only countable while you happen to write the same sentence
twice. Categories turn them into something a trend can be read from.

Sorting is deliberately cheap: a category's **keywords are matched first**, at no
cost at all, and only what they miss goes to the model — in **one batched call**,
never one per skip. Every answer is stamped with a category version, so nothing
is ever classified twice. Editing a definition bumps that version and re-sorts
everything filed under the old meaning, so the chart never quietly starts meaning
something different from what it meant last week.

Nothing is hardcoded. The four that ship are seeded rows, editable and deletable
like any you add, and a new profile gets its own copy.

## Documentation

Pages you write in the dashboard, in markdown, stored in the database. The
sidebar slides sideways into a folder tree; folders take an icon; pages can be
shared by every profile or scoped to some of them.

Markdown is rendered **once, on save**, and the HTML is stored beside the source,
so viewing a page parses nothing. The preview button calls the same renderer as
the save, so a preview cannot show something the saved page will not.

It is safe by construction rather than by sanitiser: the source is HTML-escaped
*before* it reaches the parser, so a `<script>` in a document can only ever come
out as visible text. That alone is not enough — a markdown link can still carry
`javascript:` — so links and images are filtered to `http`, `https` and `mailto`
as well. A blocked link keeps its words and loses its destination. Both halves
are asserted in `test/docs.test.js`.

## Metrics

Daily, monthly, yearly and all-time views of:

- **Reply rate**, and what came of every send
- **Sending over time**, against bounces on one scale
- **Where leads stop** — the full funnel from discovered to client
- **Whether the score predicts a reply** — if the bars do not descend, the
  scoring is not earning its keep
- **Reply rate by niche** — where your answers actually come from
- **What the crawl spent** — AI calls, fetches, source queries, renders

Charts are inline SVG with no charting library, and every figure has a table
view so the numbers are reachable without seeing colour.

## What it costs to run

On Cloudflare's free tier this is close to free for a single user, and the
budget ceilings exist to keep it that way. The only meaningful spend is AI
evaluation, which is gated behind a deterministic pre-score, cached by page
content hash, and capped per day. A crawl over an unchanged corpus costs
essentially nothing because nothing is re-fetched or re-evaluated.

Actual usage is visible on the Metrics page, broken down by resource.

## Legal: CAN-SPAM and crawling

**This sends commercial email to people who did not ask for it.** That is legal
in the US under CAN-SPAM if you follow the rules, and illegal if you do not. In
the EU and UK, GDPR and PECR are stricter — take advice before sending there.

The system enforces two requirements and cannot be talked out of them:

- **A real physical postal address** in every message. `SENDER_POSTAL_ADDRESS`
  is not decorative. Editing it out of a draft puts it back.
- **A working opt-out.** Every message carries one, and `/api/suppress` records
  the request permanently.

Suppressions are never removed automatically. Blocked addresses and domains are
checked before every queue build and every draft.

Crawling respects `robots.txt`, caches by content hash to avoid re-fetching, and
identifies itself via `USER_AGENT` — **set that to a real URL and address so
site owners can contact you.**

## Security model

Three ways in, in order of preference:

1. **Cloudflare Access** — the intended production path. Access terminates the
   login at the edge and forwards a signed assertion.
2. **A signed session cookie** — HMAC-signed, 12 hours, with the allowlist
   re-checked on every request so revocation is immediate.
3. **A shared key** — `DASHBOARD_KEY`, compared in constant time. A key in the
   query string is swapped for a cookie and removed from the address bar.

**One assumption worth understanding before you deploy.** The Worker reads the
identity Cloudflare Access forwards without verifying the JWT signature itself.
That is safe *only* because `workers_dev = false` and the single route sits
behind an Access policy, so no request can reach the Worker without Access
having verified it first. Deploy without Access in front, or add a second
route, and that assumption breaks. `REQUIRE_ACCESS = "true"` is the backstop:
it makes the Worker refuse anything that did not arrive through Access.

The dashboard renders text scraped from strangers' websites, so it ships under
a strict Content Security Policy — `default-src 'none'`, no CDN, no web fonts,
scripts allowed only by per-request nonce. Everything is escaped on output.

Nothing that is a credential belongs in `wrangler.toml`. Use
`wrangler secret put`.

## FAQ

**Does this need an API key for an LLM?**
No third-party key. Evaluation runs on Cloudflare Workers AI using your
Cloudflare account. Drafting uses no LLM at all — emails are composed from
evidence already extracted during evaluation, which is why 30 drafts cost
nothing.

**Will it email people automatically?**
No. Nothing is sent without a human pressing a button. The cron jobs discover,
score and draft; sending is always a deliberate act.

**How many leads will it find?**
That depends entirely on your niche and how tight your scoring is. Discovery is
continuous, so the corpus grows daily; the queue is capped so the review stays
a few minutes' work rather than an afternoon.

**Can I use a mail provider other than Zoho?**
Yes, with a small change. Sending is isolated in `src/zoho.js` behind a
`sendMail` function. Anything with an HTTP send API — Postmark, Resend, SES —
is a like-for-like replacement.

**Does it work without a custom domain?**
It runs, but you lose Cloudflare Access, which is the primary authentication.
You would be relying on the shared key alone. Not recommended.

**Is the data mine?**
Everything lives in your own Cloudflare D1 database. There is no hosted service
and no third party in the loop.

**How do I know the scoring is any good?**
The Metrics page plots reply rate by score band. If higher-scoring leads do not
reply more often, the scoring is not working, and it says so plainly.

**What happens to a lead that never replies?**
After `GHOST_AFTER_DAYS` (30 by default) it is marked ghosted automatically. A
status you set by hand is never overwritten.

## Limitations

Stated plainly, because finding out later is worse:

- **It only sees what is on the public web.** No intent data, no firmographics,
  no contact enrichment.
- **Email discovery is imperfect.** Some businesses publish no address, and
  those leads simply wait.
- **The first fortnight is noisy.** Scoring needs your skip reasons to converge.
- **Reply tracking is manual.** Nothing reads your inbox; you mark replies from
  the Sent page. Ghosting is the only automatic status.
- **US-shaped by default.** The metro list, the CAN-SPAM footer and the niche
  taxonomy assume a US market. All three are replaceable.
- **One reviewer.** There is no multi-user model, no roles, no team inbox.

## Development

```bash
pnpm test          # 122 tests: pure functions and SQL shape, no network
pnpm run dev       # local Worker against a local D1
pnpm run deploy    # deploy to Cloudflare
pnpm run tail      # live logs
```

Upgrading an existing install applies the files in `migrations/` in order.
A fresh install needs only `schema.sql`, which is complete on its own.

## Contributing

Contributions to the **machinery** are welcome — the discovery sources, the
dedup index, the scoring engine, the dashboard, bounce handling, mail-provider
adapters, tests and docs. The **taste** (`NICHES`, `PERSONAS`, the AI brief in
`src/ai.js`) is meant to be rewritten per operator, so please don't send a PR
that swaps in your own niche.

Good first contributions:

- A new discovery source behind the same interface as `src/sources.js`
- A mail-provider adapter alongside `src/zoho.js` (Postmark, Resend, SES)
- A non-US metro list or CAN-SPAM-equivalent footer
- Tightening a scoring dimension with a test that shows the improvement

Before opening a PR:

- `pnpm test` is green (`node --test`, no network, no database)
- No new runtime dependencies — the Worker ships with none, and that is on
  purpose. Raise an issue first if you think one is unavoidable.
- Match the surrounding style: plain ES modules, no framework, no build step,
  output always escaped, the Content-Security-Policy left strict.
- One focused change per PR, with a short imperative commit subject.

Found a security issue? Use GitHub's **private vulnerability reporting** on this
repo rather than opening a public issue.

Full detail is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[MIT](LICENSE). Use it, change it, run it commercially — just keep the copyright
notice.

The licence covers the software only. Complying with CAN-SPAM, GDPR, PECR and
anything else that governs the email you send with it is the operator's
responsibility, not the licence's.
