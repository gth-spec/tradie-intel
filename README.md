# Tradie Intel

Daily AI-enriched trades industry intelligence hub at https://tradieintel.com.au.

## Stack

Astro 5 (SSR) · Vercel · Supabase · Anthropic Claude · Firecrawl · Tailwind 4 · Vitest

## Local setup

1. `cp .env.example .env` and fill in values.
2. `npm install`
3. Supabase: link the project once with `supabase link --project-ref <ref>`, then `supabase db push` to apply migrations.
4. `npm run dev` - serves at http://localhost:4321
5. `npm test` - run test suite.

## Architecture

### Hybrid content pipeline (daily, 06:00 AEST)

Vercel Cron hits `/api/cron/refresh-feeds`. The handler iterates enabled sources in `src/config/feeds.ts`, dispatches each by `type`:

- **`type: 'rss'`** → `src/lib/rss.ts` parses the feed with `rss-parser`.
- **`type: 'scrape'`** → `src/lib/scrape.ts` fetches the page via Firecrawl, then Claude extracts article items from the returned markdown.

Both adapters normalise to a common shape. New items are deduped against existing `original_url`s in Supabase, filtered by age (≤14 days), capped at 30 per run, enriched via `src/lib/claude.ts` (summary + why-it-matters + relevance score + controlled tags), and upserted to the `feed_items` table.

### Site pages

Astro SSR. Pages read from Supabase on each request. All content is in HTML for SEO and GEO indexability.

- `/` - hero + 15 latest items + inline email capture
- `/news` - paginated archive (20/page)
- `/news/[slug]` - individual item with JSON-LD Article schema + related items
- `/about`, `/privacy`, `/terms` - static pages
- `/sitemap.xml`, `/feed.xml` - SEO endpoints
- `/api/subscribe` - email capture POST endpoint (honeypot + consent + UTM capture)
- `/api/cron/refresh-feeds` - cron entry point (Bearer-token auth)

### Email capture

POST `/api/subscribe` routes through `src/lib/email.ts` provider abstraction. Configure via `EMAIL_PROVIDER` env var (`memory` for dev; `kit` / `loops` / `mailchimp` for prod).

Subscriber metadata (consent flag, timestamp, source, referrer, UTMs) is passed as custom fields to the chosen provider so consent records live in the email tool, not Supabase.

## Manually trigger cron locally

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:4321/api/cron/refresh-feeds
# Dry run (skips inserts but still calls Claude - watch the spend):
curl -H "Authorization: Bearer $CRON_SECRET" "http://localhost:4321/api/cron/refresh-feeds?dryRun=1"
```

## Deploy

Push to the connected GitHub repo. Vercel auto-builds. Configure all env vars from `.env.example` in the Vercel dashboard before first deploy.

## Adding a new source

Edit `src/config/feeds.ts`. Set `enabled: true` and provide a valid URL. For RSS, set `type: 'rss'`. For a page that doesn't have RSS, set `type: 'scrape'` (requires `FIRECRAWL_API_KEY`).

Verify before enabling:

```bash
node scripts/verify-feeds.mjs   # checks RSS sources only
```

## Email digest sender

Not yet built. The site captures emails for the "early list" - the daily email digest is a future v2 task. CTA copy across the site reflects this honestly; do not promise daily emails until the sender ships.

## Spec and plan

- Design spec: `docs/superpowers/specs/2026-05-22-tradie-intel-hub-design.md`
- Implementation plan: `docs/superpowers/plans/2026-05-22-tradie-intel-implementation.md`
