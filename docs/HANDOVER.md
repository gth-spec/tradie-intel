# Tradie Intel - Session Handover

**Last updated:** 2026-05-23 (end of build phase)
**Next session:** picking up at deployment

> If you're a fresh Claude session reading this: this document re-creates the context you need to help Greg ship this project. Read it end-to-end before doing anything else.

---

## What this project is

**Tradie Intel** is a daily AI-filtered news micro-site for Australian trades operators (plumbers, electricians, builders, HVAC). A satellite of GrokoryAI. The site:

- Aggregates content from RSS feeds and scraped news pages
- Enriches each item with Claude (summary, "why it matters", relevance score, tags)
- Stores items in Supabase with controlled-vocabulary tagging
- Serves SSR pages from Supabase with full HTML for SEO/GEO crawlers
- Captures email subscribers as the primary CTA (digest is v2, copy is honest about that)

**Domain:** tradieintel.com.au (primary) + tradieintel.au (redirect) - both registered at VentraIP.
**Purpose:** SEO/GEO content + lead generation funnel into GrokoryAI services.

---

## Current state

**Build is complete.** All 28 implementation tasks done (25 original + 6.5 feed verification + 6.6 Firecrawl + 6.7 Apify fallback).

| Metric | Value |
|---|---|
| Commits on main | 28 (all pushed to GitHub) |
| Tests passing | 58 / 58 across 9 test files |
| TypeScript | Clean (`npx tsc --noEmit` passes) |
| Build | Clean (`npm run build` produces working Vercel SSR output) |
| Repo | https://github.com/gth-spec/tradie-intel (public) |

**Deploy progress (2026-05-23):**
- ✅ Vercel project created, linked to GitHub repo (Astro preset confirmed)
- ✅ DNS configured on **Cloudflare** (not VentraIP as originally planned): `tradieintel.com.au` → `76.76.21.21` (Vercel, DNS only) + `tradieintel.au` → 301 → `https://tradieintel.com.au`
- ✅ Email provider chosen: **Kit** (API key in local `.env`)
- ⏳ Env vars not yet entered in Vercel dashboard
- ⏳ `EMAIL_LIST_ID` still outstanding (need to create the Kit list/form first)
- ⏳ Firecrawl API key not yet obtained
- ⏳ Apify token not yet obtained
- ⏳ Not yet deployed (no live URL)
- ⏳ First cron run not executed (Supabase `feed_items` table is empty)
- ⏳ Lead magnet content not produced (CTA copy is placeholder "we'll email you when the digest launches")

**🔐 SECURITY:** Anthropic, Supabase, Firecrawl, and Apify API keys were visible in chat on 2026-05-23. **Rotate all of them before go-live.** Update local `.env` and Vercel env vars with the new values.

---

## Architecture (quick reference)

```
Daily Vercel cron (06:00 AEST) hits /api/cron/refresh-feeds
  ↓
For each source in src/config/feeds.ts where enabled = true:
  if source.type === 'rss'    → src/lib/rss.ts (rss-parser)
  if source.type === 'scrape' → src/lib/scrape.ts (Firecrawl)
                                if Firecrawl returns 0 or throws:
                                  → src/lib/scrape-apify.ts (Apify fallback)
  ↓
For each new item (deduped by niche+original_url):
  src/lib/claude.ts (Claude enrichment: summary, why_it_matters, score 0-100, tags)
  ↓
Upsert into Supabase `feed_items` table (niche='trades')
  ↓
Astro SSR pages query Supabase on each request:
  /            → homepage (15 latest items, hero email capture)
  /news        → archive (paginated 20/page)
  /news/[slug] → individual item with summary, source link, related items
  /about, /privacy, /terms → static
  /api/subscribe → POST email captures (honeypot + consent capture)
  /sitemap.xml, /feed.xml, /robots.txt → SEO plumbing
```

**Stack:** Astro 5 SSR + Vercel + Supabase + Anthropic Claude + Firecrawl + Apify + Tailwind 4

---

## Key file map

```
tradie-intel/
├── docs/
│   ├── HANDOVER.md                                # this file
│   └── superpowers/
│       ├── specs/2026-05-22-tradie-intel-hub-design.md      # the spec
│       └── plans/2026-05-22-tradie-intel-implementation.md  # the build plan (mostly executed)
│
├── src/
│   ├── config/
│   │   ├── site.ts          # brand strings, CTA copy, niche
│   │   ├── feeds.ts         # FEEDS array - 1 RSS + 8 scrape sources, with type='rss'|'scrape'
│   │   └── tags.ts          # controlled vocabulary (trade categories, AU states, themes)
│   ├── lib/
│   │   ├── supabase.ts      # adminClient() + publicClient() factories
│   │   ├── rss.ts           # RSS fetch+parse
│   │   ├── scrape.ts        # Firecrawl scrape adapter (primary)
│   │   ├── scrape-apify.ts  # Apify fallback (only when Firecrawl returns 0 or throws)
│   │   ├── claude.ts        # enrichment with Zod schema + length caps (300/150 chars)
│   │   ├── email.ts         # EmailProvider abstraction (memory/kit/loops/mailchimp)
│   │   ├── related.ts       # related-items selection (tag overlap → same source → recency)
│   │   └── slug.ts          # title → URL-safe slug with diacritics stripped
│   ├── layouts/Base.astro   # HTML shell, SEO meta, OG, JSON-LD wiring
│   ├── components/          # Header, Footer, Hero, EmailCapture, FeedCard, SourceBadge
│   └── pages/
│       ├── index.astro      # homepage SSR
│       ├── news/index.astro # archive SSR with ?page=N
│       ├── news/[slug].astro# item SSR with related items
│       ├── about|privacy|terms.astro
│       ├── sitemap.xml.ts   # dynamic sitemap from Supabase
│       ├── feed.xml.ts      # site's own RSS feed
│       └── api/
│           ├── subscribe.ts                # POST email capture (honeypot+consent)
│           └── cron/refresh-feeds.ts       # the daily cron (hardened: 30-item cap, 14-day age, dry-run)
│
├── supabase/
│   ├── config.toml
│   └── migrations/0001_initial_schema.sql  # feed_items table - already applied to remote
│
├── scripts/verify-feeds.mjs                # one-shot RSS source verification
├── tests/                                  # 58 tests across 9 files
├── .env                                    # gitignored, populated with real values
├── .env.example                            # template
├── astro.config.mjs                        # Astro+Vercel+Tailwind4 Vite plugin
├── vercel.json                             # cron schedule: "0 20 * * *" (06:00 AEST)
└── README.md
```

---

## Important context Greg has agreed to

- **Email digest is v2.** CTA copy says "we'll email you when the daily digest launches" - honest framing. Greg will build the actual digest sender post-launch once subscribers justify it.
- **Lean v1.** No blog, no tools directory, no secondary CTA. Just feeds + email capture. Stay disciplined when adding things.
- **Hybrid sourcing.** Pivot decision made when 7 of 8 RSS sources verified broken. Firecrawl is primary scrape, Apify is fallback only.
- **Email provider deferred.** `EMAIL_PROVIDER=memory` in dev. Greg leans Kit. Lock in before public launch.
- **Public GitHub repo** under `gth-spec` (his personal GH org).
- **Australian English, no em-dashes.** Use " - " with spaces. Implementer subagents have already caught and respected this; keep doing it.
- **Australian audience.** Use "Gregory" (not "Greg") in audience-facing content if any byline ever needed; phonetically aligns with "Grokory".

---

## Critical decisions and why

| Decision | Rationale |
|---|---|
| Astro SSR (not static) | Daily-updating content from Supabase. Static rebuild on every cron run would waste build minutes. SSR keeps content in HTML for SEO. |
| Tailwind 4 + Vite plugin | `@astrojs/tailwind` is deprecated. Plan was updated mid-build. |
| `@astrojs/vercel` v9 (no `/serverless` subpath) | v9 collapsed subpath exports. Fix landed in commit `3b4aaaf`. |
| Supabase publishable/secret naming | Supabase changed `anon`/`service_role` → `publishable`/`secret` in late 2025. Plan and code use new names. |
| `gen_random_uuid()` not `uuid_generate_v4()` | Modern Supabase puts uuid-ossp functions in `extensions` schema; `gen_random_uuid` is built-in Postgres 13+. |
| Schema uniqueness on `(niche, original_url)` and `(niche, slug)` | Supports future allied-health hub sharing the same table. |
| Cron has 30-item cap, 14-day age cutoff, AbortSignal timeout | Prevent runaway Claude spend on long backfills and noisy feeds. |
| Apify is fallback only | Greg on free tier ($5/month). Apify only invoked when Firecrawl returns 0 or throws. Counted in cron summary as `apify_fallback_calls`. |
| Single source of truth for `ScrapedItem` type | Exported from `scrape.ts`, imported by `scrape-apify.ts`. Both adapters return identical shape. |

---

## What's queued for next session (deploy phase)

In order:

### 1. Rotate exposed API keys
**Do this first.** Keys for Anthropic, Supabase, Firecrawl, Apify were visible in chat on 2026-05-23. Regenerate each, update local `.env`, then put the new values into Vercel env vars in step 4.

### 2. Get the missing API keys
- **Firecrawl:** sign up at https://firecrawl.dev (free tier: 500 scrapes/month, ~210/month usage well within)
- **Apify:** sign up at https://apify.com (free tier: $5/month credit - only used when Firecrawl fails)

### 3. Finish Kit setup
Email provider is locked in as **Kit**. API key is in local `.env`. Outstanding:
- Create the Kit list/form for Tradie Intel subscribers (one form per niche site)
- Copy the form ID to `EMAIL_LIST_ID` in `.env` and (next step) Vercel
- Confirm `EMAIL_PROVIDER=kit` in `.env` (currently still `memory` from dev)

### 4. Enter env vars in Vercel dashboard
Vercel project is already created and connected to the GitHub repo. Outstanding:
- Vercel project settings → Environment Variables → add every key from `.env.example` with the rotated values
- Required: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `CRON_SECRET`, `EMAIL_PROVIDER=kit`, `EMAIL_PROVIDER_API_KEY`, `EMAIL_LIST_ID`, `FIRECRAWL_API_KEY`, `APIFY_TOKEN`
- Trigger a deploy from the dashboard (or push any commit to main)

### 5. Confirm domain wiring
DNS is on **Cloudflare** (not VentraIP as originally planned):
- `tradieintel.com.au` → `A 76.76.21.21` (Vercel IP, DNS-only proxy mode)
- `tradieintel.au` → 301 redirect to `https://tradieintel.com.au`

After deploy, verify:
```bash
curl -sI https://tradieintel.com.au | head -5      # 200, Vercel headers
curl -sI https://tradieintel.au | head -5          # 301 redirect
```

### 6. Trigger first cron run
After deploy stabilises, manually trigger:
```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://tradieintel.com.au/api/cron/refresh-feeds
```
Expected JSON response with `items_inserted` > 0 if at least one source returned items. Currently only **Master Plumbers AU** (RSS) is confirmed working, plus 8 scrape sources that need real-world testing on the deployed Vercel runtime.

### 7. Real-provider email smoke test
With Kit configured live, subscribe a test email via the deployed site. Confirm:
- 200 response from `/api/subscribe`
- Email appears in Kit dashboard with consent metadata (source, referrer, utm)
- Double-opt-in confirmation arrives in inbox

### 8. SEO submission
- Verify `tradieintel.com.au` in Google Search Console
- Submit `https://tradieintel.com.au/sitemap.xml`
- Confirm `robots.txt` references sitemap correctly

---

## Things to watch for

- **Scrape source quality.** 8 scrape URLs were curated based on what trades sites in AU typically have working news pages. Firecrawl may struggle with some (anti-bot, heavy JS). Apify fallback should catch most of those. Watch the first few cron runs' `apify_fallback_calls` count - if it's hitting many sources per run, Apify free tier may exhaust faster than estimated.
- **Claude enrichment cost.** Each item = one Claude API call. Cap is 30 items/run/source × 9 enabled sources = 270 calls/day max. At Sonnet rates that's modest but not zero. If costs surprise, swap `CLAUDE_MODEL` env var to a Haiku model.
- **RSS source rot.** Only 1 of 8 originally-listed RSS feeds works. As sites change CMS / URLs the scrape sources will rot too. Build verification into the cron summary already; consider a weekly heartbeat email when too many sources return 0.
- **Email provider TBD.** Don't ship public marketing until Greg picks one and the smoke test passes.

---

## Useful commands

```bash
# from /Users/Greg/ClaudeCode/projects/tradie-intel
npm install              # only needed on fresh clone
npm run dev              # local dev at http://localhost:4321
npm test                 # 58 tests, ~1s
npm run build            # SSR build
npx tsc --noEmit         # type check

# Verify a feed URL works (RSS only)
node scripts/verify-feeds.mjs

# Manually trigger the cron locally (requires .env)
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:4321/api/cron/refresh-feeds

# Dry-run the cron without writing to Supabase
curl -H "Authorization: Bearer $CRON_SECRET" 'http://localhost:4321/api/cron/refresh-feeds?dryRun=1'

# Supabase CLI (already linked)
supabase db push              # apply pending migrations
supabase migration list       # see migration history
```

---

## Anti-patterns to avoid

- Don't ship anything that promises a "daily email" until the digest sender is built. CTA copy currently says "we'll email you when the digest launches" - keep that promise honest.
- Don't add a secondary CTA ("Book a 15-min audit") to v1 - explicitly out of scope per the spec.
- Don't reintroduce em-dashes in any copy. Use " - " with spaces.
- Don't bypass the spec/code review cycle on substantive code changes - it caught real issues earlier (deprecated import, em-dash usage, missing schema uniqueness).
- Don't refactor `scrape.ts` and `scrape-apify.ts` to share the Claude extraction prompt yet. They were deliberately kept separate to let each adapter drift independently if needed. Only refactor when a third adapter appears.

---

## Open questions for Greg

1. **GitHub org migration?** Currently the repo is at `gth-spec/tradie-intel`. Want it moved to a `grokoryai` org at some point for brand consistency? Easy transfer in GH UI.
2. **Lead magnet content?** Spec lists this as TBD-before-launch. The CTA can stay generic ("get notified") but a real lead magnet (e.g. customised AI policy template for trades) will lift conversion meaningfully.
3. **OG image.** Currently a placeholder. Worth a real 1200x630 PNG before any social sharing.
4. **Allied health hub.** Spec mentions this as the v2 replication. Anything specific to capture now while context is fresh, or defer?

---

## Files changed in the most recent session (2026-05-23)

- `src/lib/scrape-apify.ts` (new) - Apify fallback adapter
- `tests/lib/scrape-apify.test.ts` (new) - 10 tests for the adapter
- `src/pages/api/cron/refresh-feeds.ts` - wired Apify fallback into scrape dispatch
- `src/env.d.ts` - added `APIFY_TOKEN` type
- `.env.example` - documented `APIFY_TOKEN`, refined `FIRECRAWL_API_KEY` comment
- `docs/HANDOVER.md` (new) - this document

Commits: `b4718c0`, `0402402`, `5096542` (all pushed).
