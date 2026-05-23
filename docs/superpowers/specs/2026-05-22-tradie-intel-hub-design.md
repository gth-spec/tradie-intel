# Tradie Intel - Design Spec

**Date:** 2026-05-22
**Status:** Approved design, ready for implementation planning
**Project owner:** Gregory Hardiman (GrokoryAI)

---

## Overview

**Tradie Intel** is a daily-updated industry intelligence micro-site for Australian trades operators (plumbers, electricians, builders, HVAC contractors). The site aggregates RSS feeds from relevant industry, regulatory and news sources, enriches each item with AI-generated summaries via the Claude API, and presents them as indexable pages optimised for SEO and Generative Engine Optimisation (GEO).

The site's commercial purpose is to act as an organic lead generation funnel into GrokoryAI services. Visitors arrive via search (Google) or AI-engine citations (ChatGPT, Claude, Perplexity, Gemini), find value in the daily-filtered intel, and convert by subscribing to the email list. The list is the primary owned-audience asset; the site is the discovery surface.

Tradie Intel is the **pilot** for the niche-hub model. If it succeeds, the same architecture replicates as a second site for the allied health niche (`alliedhealthhub.com.au` or similar), sharing the Supabase data layer with a `niche` field separating the two streams.

### Success metrics (v1)

- 500+ organic visitors per month within 90 days of launch
- 5%+ email capture conversion rate on landing visitors
- Site indexed in Google within 14 days; at least one AI-engine citation within 60 days

### Domain

- Primary: `tradieintel.com.au` (registered 2026-05-22)
- Secondary: `tradieintel.au` (registered 2026-05-22) - configured as 301 redirect to primary at DNS/Vercel level

---

## Architecture

### Stack

| Layer | Technology |
|---|---|
| Frontend | Astro (SSR mode) + Tailwind |
| Hosting | Vercel (Pro plan, existing) |
| Database | Supabase (Postgres, single instance shared with future allied health site) |
| AI enrichment | Anthropic Claude API (Sonnet 4.6 default, model configurable) |
| Cron scheduling | Vercel Cron Jobs |
| Email capture | Provider TBD (candidates: Kit, Loops, Mailchimp) |
| Source control | GitHub repo, deployed via Vercel git integration |

### System diagram (logical)

```
   RSS Feeds                  Vercel Cron (daily, 06:00 AEST)
   ----------                 -------------------------------
   Master Plumbers AU  ──┐         Triggers /api/cron/refresh-feeds
   HIA                   │              │
   Fair Work AU          ├──────────►   │ Fetch new items from each feed
   State licensing       │              │ Filter against Supabase (de-dupe by URL)
   Trade news outlets    │              │
   ai.gov.au             │              ▼
                         │         Claude API enrichment
                         │              │ - 2-3 sentence summary
                         │              │ - relevance score (0-100)
                         │              │ - 2-5 tags
                         │              │ - "why it matters to tradies" 1-liner
                         │              ▼
                         │         Write to Supabase feed_items table
                         │              │
                         │              ▼
                         └──────►  Astro SSR pages query Supabase on request
                                       │
                                       ▼
                                  HTML with full content (SEO/GEO indexable)
                                  Email capture form (inline + hero)
```

### Why SSR over static

Daily-updating content with a Supabase backing store is a poor fit for static-site builds (would require a rebuild on every cron run, consuming Vercel build minutes and adding latency). SSR queries Supabase on each request, returns full HTML, and is cacheable at the edge with short TTLs. Content stays in HTML for crawlers - the primary requirement for SEO/GEO.

---

## Site structure

### Pages

| Path | Purpose | Rendering |
|---|---|---|
| `/` | Homepage - hero with email capture, latest 10-15 feed items as cards | SSR |
| `/news` | Full feed archive, paginated 20 per page | SSR |
| `/news/[slug]` | Individual item page - AI summary, "why it matters", source link, related items | SSR |
| `/about` | What this site is, who's behind it (links to GrokoryAI), why we built it | Static |
| `/privacy` | Privacy policy | Static |
| `/terms` | Terms of use | Static |

### Homepage layout (Layout B - Hero + Feed)

Approved during brainstorming. Structure:

1. **Header** - Site logo/wordmark "Tradie Intel" + thin nav (Home, News, GrokoryAI ↗)
2. **Hero block** - Prominent value prop ("Daily AI-filtered news for Australian tradies") with inline email capture form
3. **Feed section** - 10-15 most recent feed items as cards, each showing: source badge, title, AI summary (2-3 lines), "why it matters" line, tags, source link
4. **Secondary email capture** - Inline after first 5 items (catches scrollers)
5. **Footer** - GrokoryAI link, privacy, terms, contact

### Item page layout (`/news/[slug]`)

1. Breadcrumb: Home > News > [Item title]
2. **Source badge + date** at top
3. **Title** (h1)
4. **AI summary** - 2-3 sentence overview
5. **Why it matters to tradies** - 1-line plain-English impact statement
6. **Tags** as clickable chips
7. **Source link** - "Read the original at [source]" with explicit attribution
8. **Email capture** inline
9. **Related items** - 3 cards selected by: matching tag overlap first (most tags in common), falling back to same source if no tag matches exist, then to most recent items

### Visual style

To be confirmed. Default direction: clean, industrial-modern, AU-trades vernacular without being twee. Colour palette draws from the GrokoryAI brand for funnel consistency. Tailwind utility-first styling - no design system overhead for v1.

---

## Data pipeline

### Vercel cron job

- **Schedule:** Daily at 06:00 AEST (20:00 UTC previous day)
- **Endpoint:** `/api/cron/refresh-feeds`
- **Auth:** Bearer token check against `CRON_SECRET` env var on the incoming request (Vercel cron jobs include this header automatically when configured)
- **Behaviour:**
  1. Read list of feed sources from a config file (`src/config/feeds.ts`)
  2. For each feed, fetch via RSS parser
  3. For each item, check if `original_url` already exists in `feed_items` - skip if yes
  4. For each new item, call Claude API with structured enrichment prompt
  5. Write enriched row to Supabase
  6. Log results (item count, errors) for monitoring

### Feed sources (v1 starter set - specific URLs TBD before build)

Categories to include:

- **Regulatory:** Fair Work Australia, state licensing bodies (Plumbers Licensing Boards per state)
- **Industry bodies:** Master Plumbers AU, Master Electricians AU, Housing Industry Association (HIA), Master Builders AU
- **News outlets:** Australian trades publications (Plumbing Connection, Sparky's Life, etc.)
- **Government/AI policy:** ai.gov.au, business.gov.au updates relevant to small business
- **Weather/operational:** Bureau of Meteorology (severe weather alerts - relevant for outdoor work scheduling)

Specific feed URLs will be researched and locked in during implementation. Aim for **8-12 feeds at launch**, expandable via config.

### Claude API enrichment

For each new feed item, Claude is called with a structured prompt requesting JSON output:

```json
{
  "summary": "2-3 sentence summary of the item, written for an Australian tradesperson",
  "why_it_matters": "Single sentence explaining the practical impact",
  "relevance_score": 0-100,
  "tags": ["regulatory", "plumbing", "QLD"]
}
```

Items with `relevance_score < 40` are stored but flagged as low-priority (not shown on homepage). This avoids feed noise without losing data.

Model: `claude-sonnet-4-6` default. Configurable via env var so it can be swapped for `claude-haiku-4-5-20251001` if cost becomes a factor at scale.

**Tag vocabulary:** To avoid tag fragmentation (e.g. "QLD" vs "Queensland" vs "qld"), the Claude prompt includes a controlled vocabulary list of allowed tags. Tags outside the list are normalised or discarded. The vocabulary is editable in `src/config/tags.ts` and starts with: trade categories (plumbing, electrical, building, hvac), states (NSW, VIC, QLD, etc.), themes (regulatory, licensing, safety, business, AI, weather), and recency markers.

### Supabase schema

**Table: `feed_items`**

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | primary key |
| `source` | text | e.g. "Master Plumbers AU" |
| `source_url` | text | RSS feed URL it came from |
| `original_url` | text | unique - the source article URL (de-dupe key) |
| `title` | text | from RSS |
| `original_content` | text | raw description/excerpt from RSS |
| `published_at` | timestamptz | from RSS |
| `niche` | text | "trades" - allied health uses "allied-health" |
| `ai_summary` | text | Claude-generated |
| `why_it_matters` | text | Claude-generated |
| `relevance_score` | int | Claude-generated 0-100 |
| `tags` | text[] | Claude-generated |
| `slug` | text | URL-safe slug for /news/[slug] |
| `created_at` | timestamptz | default now() |

**Indexes:** `original_url` unique, `niche + published_at desc`, `niche + relevance_score desc`.

**Table: `email_subscribers`** (if not using external provider)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | primary key |
| `email` | text | unique |
| `niche` | text | which site they subscribed via |
| `subscribed_at` | timestamptz | default now() |
| `confirmed` | boolean | for double-opt-in |
| `unsubscribed_at` | timestamptz | nullable |

**Decision:** v1 uses an external email provider (Kit assumed default) and does NOT store subscribers in Supabase. The `email_subscribers` table is included in the schema reference for completeness only - it will be added later if Greg moves to self-hosted email or wants a local copy for backup.

---

## Email capture

### Mechanism

A single email field with a Subscribe button, appearing in:
- The homepage hero (primary placement)
- Inline between feed items on the homepage (secondary)
- The footer of every item page

### Provider (TBD)

To be chosen before build. Candidates:

| Provider | Pros | Cons |
|---|---|---|
| **Kit** (ConvertKit) | Built for creators, strong AU usage, automations | Monthly cost from list size 1k |
| **Loops** | Modern API, fast, dev-friendly | Less mature than Kit |
| **Mailchimp** | Free tier to 500 contacts, familiar | Older UX, deliverability declining |

Default assumption pending Greg's preference: **Kit** for compatibility with GrokoryAI's broader content strategy.

### Lead magnet (TBD)

A lead magnet will be added before launch but is not blocking the build. Spec assumes a placeholder CTA copy: "Get the daily Tradie Intel digest." If a lead magnet is locked in later (e.g. an AI policy template for trades businesses), the CTA copy updates to highlight that.

### Compliance

- Double-opt-in confirmation email required (AU Spam Act 2003 compliance)
- Unsubscribe link in every email
- Privacy policy linked at point of capture
- Stored as marketing consent record with timestamp

---

## Deployment

### Vercel project

- Separate Vercel project under existing account (Greg's Pro plan)
- GitHub repo: `gthdigitalmarketing/tradie-intel` (or similar)
- Build command: `astro build`
- Output mode: `server` (SSR via @astrojs/vercel adapter)
- Region: `syd1` (Sydney, lowest latency for AU users)

### Environment variables

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Server-only key (starts `sb_secret_`); bypasses RLS for the cron writer |
| `SUPABASE_PUBLISHABLE_KEY` | Browser/SSR key (starts `sb_publishable_`); RLS-constrained reads only |
| `ANTHROPIC_API_KEY` | Claude API key |
| `CRON_SECRET` | Shared secret for cron endpoint auth |
| `EMAIL_PROVIDER_API_KEY` | Whichever email provider is chosen |

### Domain config

- Add `tradieintel.com.au` as custom domain in Vercel
- DNS: AAAA + A records pointing to Vercel
- HTTPS auto-provisioned by Vercel
- `www.tradieintel.com.au` redirects to apex

### Analytics

Vercel Analytics enabled (free tier). Plausible or GA4 optional - deferred to v2.

---

## Future scope (out of v1)

These are deliberately deferred to keep the pilot lean:

- Allied health niche site replication
- Blog/long-form articles section
- AI tools directory
- Search functionality on the site
- User accounts / saved items
- Comments or community features
- Push/SMS notifications

Each can be evaluated post-launch based on traffic and conversion data.

---

## Open items

These are TBD but do not block design approval:

| Item | Decision needed by |
|---|---|
| Email provider choice (Kit / Loops / Mailchimp) | Before build starts |
| Lead magnet content | Before public launch (not blocking build) |
| Specific feed source URLs | During implementation |
| Visual brand styling (colours, typography specifics) | During implementation |
| GitHub repo name and visibility | Before build starts |
| GrokoryAI footer link wording | During build |

---

## Spec self-review notes

This spec has been reviewed for:

- **Placeholders:** Items marked TBD are explicit and non-blocking
- **Internal consistency:** Architecture matches feature descriptions
- **Scope:** Single implementation plan can deliver this; allied health replication is a separate future plan
- **Ambiguity:** Where choices remain (e.g. email provider), defaults are stated

Ready for user review before transition to implementation planning.
