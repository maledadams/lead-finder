# lead finder

A persistent prospecting system for founder-led creative businesses in the US.
Runs entirely on Cloudflare. Your Mac can be off.

---

## Discovery: fully automated, no manual seeding

**You never have to find brands yourself.** Four channels, all automated, all
legitimate, all running with your laptop off.

| Channel | What it finds | Cost |
|---|---|---|
| **OpenStreetMap** (Overpass) | Physical creative businesses by city and category, each with a **verified US street address**. Rotates through 26 metros. | Free, no key |
| **Certificate Transparency** (crt.sh) | Online-only brands, by keyword in the domain. A new certificate means a newly-launched business, so this catches brands as they appear. | Free, no key |
| **Link-graph expansion** | The quality channel. Indie brands link to indie brands — stockists, "brands we love", collaborators, press. Finds abstractly-named brands ("Moth & Moon") that keyword matching structurally misses. | Free |
| **Re-evaluation** | Known businesses whose signals changed. Compounds as the pool grows. | Free |

### Where the keywords come from

Not from me guessing. That was tried and it failed measurably: invented terms
like `wheelthrown`, `cutecore`, `handpoured` and `gyaru` return **zero**
certificates, while plain roots like `lolita` (2983), `emo` (491), `kawaii`
(90), `harajuku` (68) and `decora` (64) are productive. A hand-written list
looks right and finds nothing.

So the vocabulary is harvested and then measured — see [`src/keywords.js`](src/keywords.js):

1. **Harvest** — Wikipedia enumerates fashion subcultures, aesthetics and
   garments in exactly the categories you care about. Free, keyless, and the
   API exists to be queried. A run pulls ~1000 candidate terms.
2. **Mine** — terms that recur on businesses already scored well, compared
   against low scorers so ordinary retail words do not survive. This is the
   self-improving half: the corpus teaches the crawler what your good leads
   look like.
3. **Validate** — every candidate is tested against real crt.sh yield before
   it is ever used. Terms returning nothing are marked `DEAD` and never
   queried again. A first batch killed 12 of 14, including a person's name
   scraped out of a citation list.
4. **Prune** — terms that return domains but never produce a lead are retired
   after a few runs, and ambiguous common words (`camp` returns 4548
   certificates, all campgrounds) are rejected before they cost a query.

Categories beat article links, decisively. `Category:Punk fashion` yields
`bondagepants`, `bovverboot`, `devilock`, `combatboot` — terms no corporation
puts in a domain. Article links yield citations: `Lolita fashion` gave
`lewiscarroll` and `sumireuesaka`.

Inspect and steer it at `GET /api/keywords`; re-harvest with
`POST /api/run/harvest`; validate in bulk with `POST /api/run/validate?limit=40`.

### The niches you named

All covered in the classifier, which decides *which persona writes the email*
([`src/config.js`](src/config.js)): **emo, goth**, nu goth, pastel goth, punk,
grunge, scene · **cutecore, cute**, kawaii, pastel, coquette, fairycore,
dollette, sanrio · **Japanese-inspired** — harajuku, lolita (gothic/sweet/
classic), jirai kei, visual kei, fairy kei, mori kei, dolly kei, yami kawaii,
menhera, gyaru, decora, shironuri, jfashion · y2k, vintage, deadstock,
upcycled, reworked, corsetry.

Harvesting adds to this automatically — a recent run brought in `goblincore`,
`kinderwhore`, `softgrunge`, `darkacademia`, `kogal`, `angelicpretty` (a real
Lolita label) and `laforet` (the Harajuku mall).

Seeding still exists in the dashboard, but it is optional — for when you spot
something yourself and want it in the pipeline.

### Why not Google Maps, Apify, or Crawlee

You asked about all three. The short version:

- **Scraping Google Maps** is JS-rendered (Workers has no browser) and against
  Google's terms. Out of scope under this project's own safety rules.
- **Google Places API** is legitimate and its free tier would cover this
  volume, but it needs a billing account with a card on file — not "$0, no
  paid APIs". OSM's Overpass gives the same axis, free and keyless. If you
  ever want Places, it drops into `src/osm.js` as another source.
- **Crawlee**, the open-source engine Apify runs on, is good software that
  does not fit: it is a Node library needing a filesystem, long-running
  processes and a real Chromium binary, so it would need a machine that stays
  on. Its anti-blocking features — fingerprint spoofing, proxy and session
  rotation — are detection evasion. And none of it produces a social login
  that will not get banned.

The way past that was not a better scraper. It was to stop trying to take this
data from platforms that forbid it, and take it from sources that exist to be
queried.

### Honest limits

- **Instagram, TikTok and Etsy still cannot be crawled.** Nothing here changes
  that. What the system does instead is find the same businesses through their
  websites, then pick their social handles up off those pages.
- **OSM coverage is uneven** — dense in cities, thin in small towns, and a shop
  with no `website` tag is invisible.
- **crt.sh and Overpass are volunteer infrastructure.** They rate-limit and
  return 406/504 unpredictably; the same query was observed failing twice then
  succeeding. Overpass calls fall back across three mirrors and every failure
  is treated as normal.
- **Yield is noisy by design.** A sweep returns chains and off-target retail
  alongside real finds. That is what the staged pipeline is for — it discards
  most candidates for almost no cost.

---

## Setup

```bash
npm install

# 1. Create the database, then paste the printed id into wrangler.toml
npm run db:create

# 2. Create the tables
npm run db:init

# 3. Set the dashboard password (any long random string)
npx wrangler secret put DASHBOARD_KEY

# 4. Deploy
npm run deploy
```

Then open `https://lead-finder.<your-subdomain>.workers.dev/?key=YOUR_KEY`.

**Before sending anything**, fill in the real values in `wrangler.toml`:
`SENDER_NAME`, `SENDER_EMAIL`, `SENDER_POSTAL_ADDRESS`, and `USER_AGENT`.
The postal address is a legal requirement — see CAN-SPAM below.

### Local development

```bash
echo "DASHBOARD_KEY=$(openssl rand -base64 24 | tr -d /+= )" > .dev.vars
npm run db:init:local
npm run dev
npm test
```

---

## How it runs

Two cron triggers. That is the whole schedule.

```
06:00 UTC  crawl   discover, fetch, extract, score, evaluate — budget-capped
11:00 UTC  queue   rank everything qualified, take the top 30 max, draft
```

The pipeline is staged so that expensive work only happens to candidates that
already earned it:

```
OSM sweep + CT sweep + link graph + stale pool
      ↓
dedup            D1 lookup                       free
      ↓
fetch + extract  robots-respecting, hash-cached  cheap
      ↓
hard filters     parked, corporate, empty        free
      ↓
rule-based score 7 dimensions from real signals  free
      ↓
      ├── below MIN_PRESCORE_FOR_AI → stops here, no AI spend
      ↓
AI evaluation    one call, cached by page hash   the only spend
      ↓
final score → rank → top 30 max → drafts
```

Roughly 90% of what matters is extracted mechanically — platform, prices,
product counts, press, wholesale, paid apps, mobile viewport, image weight,
copyright year, emails, socials. The model is only asked the questions rules
genuinely cannot answer: does this brand have real aesthetic personality, and
would you actually want to make something for them.

---

## The parts that matter

### Entity deduplication

The non-negotiable one. Every identifier ever seen becomes a key row pointing
at an entity. A new candidate is resolved by looking up all its keys at once.

Keys come in two tiers, and the distinction is load-bearing:

- **Strong** (exact domain, Instagram, TikTok, Etsy, email) — an exact match is
  proof, and merges unconditionally.
- **Weak** (slug similarity, name) — a hint, not proof. Accepted only when
  nothing contradicts it. Two entities with *different* known domains are
  never merged on a name resemblance.

Slugs are emitted as variants rather than aggressively stripped, so
`cute-brand.com` and `@cutebrandco` meet on `cutebrand`, while `moonstudio.com`
and `moonbakery.com` never collide.

Verified: seeding one business through four separate doors produces **one**
entity; three different businesses produce three.

### 30 is a ceiling, never a target

There is no code path in [`src/queue.js`](src/queue.js) that lowers the
threshold to fill space, and there should never be one. If eleven businesses
clear the bar, the queue has eleven rows. If none do, the dashboard says so
plainly rather than padding.

### The two opportunity engines

Website quality and system opportunity are scored **separately**, and `need`
takes the better of the two. A beautiful site with orders taken by DM still
scores as a strong lead. A prospect is only rejected when both are absent.

### Evidence-based personalization

Enforced mechanically, not just asked for in the prompt:

- Claims about speed or mobile are stripped unless we actually measured a
  supporting signal.
- A compliment whose stated evidence does not overlap the real page text is
  discarded.
- **If there is no evidence-backed thing to admire, no draft is produced.**
  The lead waits for better information. An invented compliment is worse than
  silence.

### Drafts cost zero AI

The specifics that make an email personal are extracted during evaluation and
already evidence-checked. Composing from them is deterministic, so 30 drafts
add nothing to your AI spend, and the voice stays consistent. Seven niche
personas, each with its own register and CTA; the CTA switches when the
opportunity is a system rather than a website.

### Cost control

Hard daily caps on fetches and AI calls, enforced by a circuit breaker before
every expensive operation. The database doubles as a compute cache: unchanged
pages are never re-analysed, and AI results are keyed to the page's content
hash. The dashboard shows both budgets as live meters.

Defaults are deliberately low — 300 fetches and 40 AI calls a day. Raise them
only after watching real usage.

---

## CAN-SPAM

You are sending commercial email to US recipients. This is not optional:

- Every draft carries a physical postal address and an opt-out line. Set
  `SENDER_POSTAL_ADDRESS` to a real address or the footer will say so loudly.
- `POST /api/suppress` with `{"key": "someone@example.com"}` records a
  permanent opt-out. Nothing removes suppressions automatically.
- Wire that endpoint to whatever receives your replies so unsubscribes are
  honored without you remembering to.

**Sending is deliberately not automated.** Cloudflare Email Routing receives
and forwards; it does not send. Any From address you use must have SPF and
DKIM configured for the actual sending path, or your mail fails alignment and
lands in spam. The dashboard gives you copy-ready drafts and a "mark sent"
button; you send them from a real mailbox you control. That is the honest
$0 answer.

---

## API

All endpoints require `?key=` or `Authorization: Bearer`. Fails closed if
`DASHBOARD_KEY` is unset.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Dashboard |
| GET | `/health` | Unauthenticated liveness check |
| GET | `/api/queue?day=` | Today's ranked queue |
| GET | `/api/entity?id=` | One entity, its identity keys and snapshots |
| GET | `/api/stats` | Counts, budgets, frontier |
| POST | `/api/seed` | `{"seeds": ["brand.com", "@handle", ...]}` |
| POST | `/api/run/crawl` | Trigger a crawl now |
| POST | `/api/run/queue` | Rebuild the queue (`?dry=1` to preview) |
| POST | `/api/outreach/:id/sent` | Mark sent — makes the lead permanently non-new |
| POST | `/api/outreach/:id/skip` | Skip; lead returns to the pool |
| POST | `/api/suppress` | Permanent opt-out |

---

## Tuning

In `wrangler.toml`:

| Var | Default | What it does |
|---|---|---|
| `MIN_SCORE_TO_QUEUE` | 68 | The quality bar. Raise it if the queue feels thin on quality, not if it feels short. |
| `MIN_PRESCORE_FOR_AI` | 45 | How selective the AI gate is. The main cost lever. |
| `DAILY_FETCH_BUDGET` | 300 | Pages per day. |
| `DAILY_AI_BUDGET` | 40 | Model calls per day. |
| `DAILY_QUEUE_MAX` | 30 | The ceiling. |
| `RE_EVAL_AFTER_DAYS` | 45 | How long before a known business is looked at again. |
| `SOURCE_METROS_PER_RUN` | 2 | OSM metros swept per crawl. |
| `SOURCE_KEYWORDS_PER_RUN` | 3 | CT keywords swept per crawl. |
| `FRONTIER_LOW_WATER` | 150 | Sources only run when pending work drops below this. |

Scoring weights live in [`src/config.js`](src/config.js) — `fit` and
`creative` and `money` are weighted equally at 20 each, deliberately. A
terrible website belonging to someone who cannot afford the work is still a
bad lead, and that is the failure mode most lead scorers fall into.

---

## What is verified, and what is not

**Verified locally:** 45 unit tests pass; the Worker boots; auth fails closed;
the schema applies; dedup produces one entity from four doors and three from
three; a full crawl runs end to end from an
**empty database with zero human input** — 283 real businesses discovered from
two metros, chains filtered, link-graph expanded, budgets accounted; the
dashboard renders; `wrangler deploy --dry-run` bundles cleanly.

**Known calibration work:** the CT keyword list is partly unvalidated — several
compound terms ("wheelthrown", "cutecore", "handpoured") return zero
certificates and should be pruned; simple nouns ("apothecary", "mercantile",
"letterpress") work. Run a sweep and check `source_cursor.total_found` to see
which earn their place.

**Not yet verified, because it needs a real deployment:**

- **Workers AI.** The model id in `src/config.js` and the `NEURONS_PER_EVAL`
  estimate are marked in-code as needing verification. Check model
  availability and your actual included Neuron allocation in your own
  dashboard before trusting either. The pipeline degrades gracefully if the
  model call fails — it falls back to rule-based scoring only.
- **Real-world scoring calibration.** The thresholds are reasoned defaults, not
  empirical ones. Seed twenty brands you genuinely love, run a crawl, and see
  where they land. If brands you love score below 68, the weights are wrong,
  not the brands.
- **Cloudflare consumption at steady state.** Estimate it from the dashboard's
  budget meters after a week of real running rather than from a projection.
