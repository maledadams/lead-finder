# Lead Finder — self-hosted lead generation and cold outreach on Cloudflare Workers

**Lead Finder is an open-source prospecting system that finds small businesses
that need your services, scores them against your own taste, drafts a personal
email to each one, and puts them in front of you to approve — one at a time.**
It runs entirely on Cloudflare's free-ish tier, on a schedule, with your
computer switched off.

It is not a scraper you run by hand, and not a mail-merge tool. It is a
persistent pipeline that gets better at picking leads the more you tell it why
you skipped one.

---

## Table of contents

- [Who it is for](#who-it-is-for)
- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Making it yours](#making-it-yours-the-part-that-is-not-configuration)
- [The review dashboard](#the-review-dashboard)
- [Metrics](#metrics)
- [What it costs to run](#what-it-costs-to-run)
- [Legal: CAN-SPAM and crawling](#legal-can-spam-and-crawling)
- [Security model](#security-model)
- [FAQ](#faq)
- [Limitations](#limitations)

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

**Prerequisites:** a Cloudflare account, Node 18+, and a domain on Cloudflare if
you want the dashboard protected properly (strongly recommended).

```bash
git clone <your-fork-url> lead-finder
cd lead-finder
npm install

# 1. Create the database, then paste the printed id into wrangler.toml
npx wrangler d1 create lead-finder

# 2. Create every table. schema.sql is complete on its own —
#    the files in migrations/ are only for upgrading an existing install.
npm run db:init

# 3. Secrets. None of these belong in a file you commit.
npx wrangler secret put DASHBOARD_KEY          # any long random string
npx wrangler secret put SESSION_SECRET         # any long random string
npx wrangler secret put ALLOWED_EMAILS         # who may sign in, comma-separated
npx wrangler secret put SENDER_NAME
npx wrangler secret put SENDER_EMAIL
npx wrangler secret put SENDER_POSTAL_ADDRESS  # a real address — legally required
npx wrangler secret put CF_ACCOUNT_ID          # for browser rendering

# 4. Edit wrangler.toml: set your route pattern and your USER_AGENT.

# 5. Deploy
npm run deploy
```

**Then put Cloudflare Access in front of the route.** The shipped config sets
`REQUIRE_ACCESS = "true"`, which makes the Worker refuse any request that did
not come through Access. See [Security model](#security-model) for why this
matters more than it looks.

### Local development

```bash
cat > .dev.vars <<'EOF'
DASHBOARD_KEY=any-long-random-string
REQUIRE_ACCESS=false
ALLOWED_EMAILS=you@example.com
EOF

npm run db:init:local
npm run dev      # http://localhost:8787
npm test         # 116 tests, no network, no database needed
```

`.dev.vars` is gitignored and overrides `wrangler.toml` locally, which is how
local development keeps working while production requires Access.

### Sending email

Sending is optional — without it the dashboard is a copy-and-paste queue. To
send through Zoho Mail:

1. Create a Zoho API client, set `ZOHO_CLIENT_ID` and `ZOHO_REGION` in
   `wrangler.toml`, and `npx wrangler secret put ZOHO_CLIENT_SECRET`.
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

## Making it yours: the part that is not configuration

The machinery is business-agnostic. The **taste** is not, and it lives in seven
places that have to be rewritten rather than set. This is the real work of
adopting this project, and it is a few hours, not a few minutes.

| File | What to replace |
|---|---|
| `src/config.js` → `NICHES` | The taxonomy of business types you sell to |
| `src/outreach.js` → `PERSONAS` | The actual sales copy per niche: opener, what you do, what you offer |
| `src/outreach.js` → `PLAIN_ENGLISH` | How a technical finding is said to a non-technical reader |
| `src/outreach.js` → `BENEFIT` | The same finding said as the upside it implies |
| `src/ai.js` → `SYSTEM` | The brief the model scores against: who you want, who you do not, what disqualifies a lead outright |
| `src/score.js` | Deterministic weights and hard vetoes |
| `src/keywords.js` | The bootstrap keyword list discovery starts from |
| `src/osm.js` | The metro list, if you sell locally |

Everything else — the crawl budget, the dedup index, the queue, the dashboard,
the metrics, the send path, bounce handling — works unchanged.

## The review dashboard

Five pages, server-rendered, no build step, roughly 7 KB gzipped with zero
external requests.

- **Today** — the day's queue. Each card shows the business, why it was
  surfaced, and the full draft. Send, edit, or skip with a reason.
- **Sent** — every email sent, searchable and filterable by date. Mark whether
  they replied, and record a bounce.
- **Skipped** — what you passed on and the reason you gave. Any of them can be
  edited and put back in the queue.
- **Bounced** — dead addresses. Enter a corrected one and requeue.
- **Metrics** — see below.

### Bounces put the business back in the pool

A bounce says the address was wrong, not that the business was. Marking one
clears the stored address, records the dead one so it is never adopted again,
and returns the business to the pool. It leaves your roster immediately and
comes back on its own the next time a crawl finds a *different* address.

### Skipping teaches it

Every skip asks for a reason, and those reasons are periodically distilled into
rules that outrank the model's own judgement on future leads. A fresh install
has no rules and will surface things you do not want for the first week or two.
That is expected. Skip them with real reasons and it converges.

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
npm test          # 116 tests: pure functions and SQL shape, no network
npm run dev       # local Worker against a local D1
npm run deploy    # deploy to Cloudflare
npm run tail      # live logs
```

Upgrading an existing install applies the files in `migrations/` in order.
A fresh install needs only `schema.sql`, which is complete on its own.

## Licence

[MIT](LICENSE). Use it, change it, run it commercially — just keep the copyright
notice.

The licence covers the software only. Complying with CAN-SPAM, GDPR, PECR and
anything else that governs the email you send with it is the operator's
responsibility, not the licence's.
