# Contributing to Lead Finder

Thanks for wanting to help. This is a small, dependency-free project and the bar
for changes is deliberately narrow, so please read this before opening a PR.

## Machinery, not taste

The codebase splits cleanly in two:

- **Machinery** — discovery, dedup, fetching, scoring engine, the queue, the
  dashboard, metrics, sending, bounce handling. This is business-agnostic and
  contributions here are welcome.
- **Taste** — `NICHES` in `src/config.js`, `PERSONAS` / `PLAIN_ENGLISH` /
  `BENEFIT` in `src/outreach.js`, the `SYSTEM` brief in `src/ai.js`, the weights
  in `src/score.js`, the metro list in `src/osm.js`. Every operator rewrites
  these for their own business. **Don't send a PR that replaces them with
  yours.** A PR that makes them *easier to swap* is fine.

## Good contributions

- A new discovery source behind the same interface as `src/sources.js`.
- A mail-provider adapter alongside `src/zoho.js` — anything with an HTTP send
  API (Postmark, Resend, SES) is a like-for-like fit behind `sendMail`.
- Non-US support: an alternative metro list, or a CAN-SPAM-equivalent footer for
  another jurisdiction.
- Tightening a scoring dimension, with a test that demonstrates the improvement.
- Documentation fixes and clarifications.

## Development

```bash
npm install
npm run db:init:local
npm run dev       # local Worker at http://localhost:8787
npm test          # node --test — no network, no database
```

See the [Quick start](README.md#quick-start) in the README for a full deploy.

## Ground rules for a PR

- **Tests pass.** `npm test` must be green. Non-trivial logic needs a test that
  fails before your change and passes after.
- **No new runtime dependencies.** The deployed Worker has zero. If you believe
  one is unavoidable, open an issue to discuss it before writing code.
- **Match the existing style.** Plain ES modules, no framework, no build step.
  All output is escaped; the Content-Security-Policy stays strict
  (`default-src 'none'`, no CDN, no web fonts, nonce-only scripts).
- **One focused change per PR.** Short imperative commit subjects
  ("Add Resend adapter", not "changes").
- **Keep the guarantees.** The daily send cap, the postal-address requirement
  and the opt-out path are load-bearing — don't weaken them.

## Reporting bugs

Open an issue with what you expected, what happened, and the smallest set of
steps to reproduce.

## Reporting security issues

Please use GitHub's **private vulnerability reporting** (Security tab → Report a
vulnerability) rather than a public issue.

## Licence

By contributing you agree that your contribution is licensed under the
[MIT Licence](LICENSE). There is no CLA.
