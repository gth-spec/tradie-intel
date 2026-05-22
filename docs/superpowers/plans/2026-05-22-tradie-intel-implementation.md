# Tradie Intel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy the Tradie Intel niche hub - an Astro SSR site at tradieintel.com.au that displays AI-enriched daily RSS feed content for Australian trades operators, with email capture as the primary conversion CTA.

**Architecture:** Astro in SSR mode (Vercel adapter) reads from a Supabase `feed_items` table. A daily Vercel cron job hits an internal API route which fetches RSS feeds, enriches new items via the Claude API (summary, "why it matters", relevance score, tags), and writes to Supabase. Email capture posts to a thin provider-abstraction so Kit/Loops/Mailchimp can be swapped without rewriting site code.

**Tech Stack:** Astro 5 + TypeScript + Tailwind CSS, `@astrojs/vercel` adapter (SSR), Supabase JS client, Anthropic SDK (`@anthropic-ai/sdk`), `rss-parser`, Vitest for tests.

**Spec:** `docs/superpowers/specs/2026-05-22-tradie-intel-hub-design.md`

---

## File Structure

```
tradie-intel/
├── astro.config.mjs              # Astro + Vercel SSR adapter + Tailwind
├── package.json                  # deps + scripts
├── tsconfig.json                 # strict TS
├── tailwind.config.mjs           # Tailwind config
├── vitest.config.ts              # test config
├── vercel.json                   # cron schedule
├── .env.example                  # env template
├── .gitignore
├── README.md                     # setup + run instructions
├── public/                       # static assets
│   └── favicon.svg
├── supabase/
│   └── migrations/
│       └── 0001_initial_schema.sql
├── src/
│   ├── env.d.ts                  # Astro env types
│   ├── config/
│   │   ├── site.ts               # site name, URL, brand
│   │   ├── feeds.ts              # RSS feed source list
│   │   └── tags.ts               # controlled tag vocabulary
│   ├── lib/
│   │   ├── supabase.ts           # Supabase client + FeedItem type
│   │   ├── slug.ts               # title -> URL-safe slug
│   │   ├── rss.ts                # RSS fetch + parse (rss-parser)
│   │   ├── claude.ts             # Claude enrichment service
│   │   ├── email.ts              # email provider abstraction
│   │   └── related.ts            # related items selection logic
│   ├── layouts/
│   │   └── Base.astro            # html shell, meta, header/footer
│   ├── components/
│   │   ├── Header.astro
│   │   ├── Footer.astro
│   │   ├── Hero.astro            # email capture hero
│   │   ├── EmailCapture.astro    # inline form
│   │   ├── FeedCard.astro        # feed item card
│   │   └── SourceBadge.astro     # source label chip
│   ├── pages/
│   │   ├── index.astro           # homepage (Layout B)
│   │   ├── about.astro
│   │   ├── privacy.astro
│   │   ├── terms.astro
│   │   ├── news/
│   │   │   ├── index.astro       # archive (paginated)
│   │   │   └── [slug].astro      # item page
│   │   └── api/
│   │       ├── subscribe.ts      # POST email capture
│   │       └── cron/
│   │           └── refresh-feeds.ts  # GET cron handler
│   └── styles/
│       └── global.css            # Tailwind directives + tokens
└── tests/
    ├── lib/
    │   ├── slug.test.ts
    │   ├── rss.test.ts
    │   ├── claude.test.ts
    │   ├── email.test.ts
    │   └── related.test.ts
    └── api/
        ├── subscribe.test.ts
        └── refresh-feeds.test.ts
```

**Design notes:**
- `lib/email.ts` defines an `EmailProvider` interface with one implementation per provider. v1 ships with `KitProvider`; the test suite includes a `MemoryProvider` for isolation. Switching providers is a one-line change in the API route.
- `lib/claude.ts` returns a typed `Enrichment` object. Tag normalisation lives here and references `config/tags.ts`.
- `lib/related.ts` is its own file because the selection logic (tag overlap → same source → most recent) is non-trivial and worth isolating for tests.
- Pages are kept thin - they call lib functions and render. Business logic stays in `lib/`.

---

## Task 1: Initialise Astro project

**Files:**
- Create: `package.json`, `tsconfig.json`, `astro.config.mjs`, `tailwind.config.mjs`, `.gitignore`, `src/env.d.ts`, `public/favicon.svg`, `src/styles/global.css`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "tradie-intel",
  "type": "module",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "@astrojs/tailwind": "^5.1.0",
    "@astrojs/vercel": "^7.8.0",
    "@supabase/supabase-js": "^2.45.0",
    "astro": "^5.0.0",
    "rss-parser": "^3.13.0",
    "tailwindcss": "^3.4.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run from `/Users/Greg/ClaudeCode/projects/tradie-intel/`:

```bash
npm install
```

Expected: dependencies installed without errors. `node_modules/` and `package-lock.json` created.

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "extends": "astro/tsconfigs/strict",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    },
    "types": ["vitest/globals"]
  }
}
```

- [ ] **Step 4: Create `astro.config.mjs`**

```javascript
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel/serverless';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://tradieintel.com.au',
  output: 'server',
  adapter: vercel({
    webAnalytics: { enabled: true }
  }),
  integrations: [tailwind()],
  build: { format: 'directory' }
});
```

- [ ] **Step 5: Create `tailwind.config.mjs`**

```javascript
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#1e40af',
          light: '#3b82f6',
          dark: '#1e3a8a'
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif']
      }
    }
  },
  plugins: []
};
```

- [ ] **Step 6: Create `src/styles/global.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  html { scroll-behavior: smooth; }
  body { @apply text-slate-900 antialiased; }
}
```

- [ ] **Step 7: Create `src/env.d.ts`**

```typescript
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly SUPABASE_URL: string;
  readonly SUPABASE_SERVICE_KEY: string;
  readonly SUPABASE_ANON_KEY: string;
  readonly ANTHROPIC_API_KEY: string;
  readonly CRON_SECRET: string;
  readonly EMAIL_PROVIDER: 'kit' | 'loops' | 'mailchimp' | 'memory';
  readonly EMAIL_PROVIDER_API_KEY: string;
  readonly EMAIL_LIST_ID: string;
  readonly CLAUDE_MODEL: string;
}
interface ImportMeta { readonly env: ImportMetaEnv; }
```

- [ ] **Step 8: Create `.gitignore`**

```
node_modules/
dist/
.env
.env.local
.vercel/
.astro/
coverage/
*.log
.DS_Store
```

- [ ] **Step 9: Create `.env.example`**

```
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
SUPABASE_ANON_KEY=
ANTHROPIC_API_KEY=
CRON_SECRET=
EMAIL_PROVIDER=kit
EMAIL_PROVIDER_API_KEY=
EMAIL_LIST_ID=
CLAUDE_MODEL=claude-sonnet-4-5-20250929
```

- [ ] **Step 10: Create `public/favicon.svg`** (placeholder, replace later)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1e40af"/><text x="16" y="22" font-family="Arial" font-size="18" font-weight="bold" text-anchor="middle" fill="white">T</text></svg>
```

- [ ] **Step 11: Verify dev server starts**

Run:
```bash
npm run dev
```
Expected: Astro dev server starts on `http://localhost:4321`. Stop with Ctrl+C.

- [ ] **Step 12: Commit**

```bash
git add .
git commit -m "feat: initialise Astro project with Vercel SSR + Tailwind"
```

---

## Task 2: Set up Vitest

**Files:**
- Create: `vitest.config.ts`, `tests/lib/.gitkeep`

- [ ] **Step 1: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: { reporter: ['text', 'html'] }
  },
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname }
  }
});
```

- [ ] **Step 2: Verify test runner works**

Create `tests/sanity.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';

describe('sanity', () => {
  it('runs tests', () => {
    expect(1 + 1).toBe(2);
  });
});
```

Run:
```bash
npm test
```
Expected: 1 passing test.

- [ ] **Step 3: Delete sanity test, commit**

```bash
rm tests/sanity.test.ts
git add .
git commit -m "feat: configure Vitest test runner"
```

---

## Task 3: Site config files

**Files:**
- Create: `src/config/site.ts`, `src/config/feeds.ts`, `src/config/tags.ts`

- [ ] **Step 1: Create `src/config/site.ts`**

```typescript
export const SITE = {
  name: 'Tradie Intel',
  description: 'Daily AI-filtered news for Australian tradies.',
  url: 'https://tradieintel.com.au',
  niche: 'trades' as const,
  parent: {
    name: 'GrokoryAI',
    url: 'https://grokoryai.com'
  },
  email: {
    capturePlaceholder: 'your@email.com',
    ctaButton: 'Subscribe',
    ctaHeadline: 'Stay ahead in trades',
    ctaSubhead: 'Daily AI-filtered news for plumbers, electricians and builders.'
  }
};
```

- [ ] **Step 2: Create `src/config/tags.ts`**

```typescript
// Controlled tag vocabulary. Tags outside this list are normalised or dropped.

export const TRADE_CATEGORIES = ['plumbing', 'electrical', 'building', 'hvac', 'carpentry', 'painting', 'roofing'] as const;
export const STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'ACT'] as const;
export const THEMES = ['regulatory', 'licensing', 'safety', 'business', 'ai', 'weather', 'wages', 'tax', 'training'] as const;

export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  ...TRADE_CATEGORIES,
  ...STATES,
  ...THEMES
]);

// Normalisation map - common synonyms to canonical tag
export const TAG_ALIASES: Record<string, string> = {
  'queensland': 'QLD',
  'new south wales': 'NSW',
  'victoria': 'VIC',
  'western australia': 'WA',
  'south australia': 'SA',
  'tasmania': 'TAS',
  'plumber': 'plumbing',
  'plumbers': 'plumbing',
  'electrician': 'electrical',
  'electricians': 'electrical',
  'builder': 'building',
  'builders': 'building',
  'compliance': 'regulatory'
};
```

- [ ] **Step 3: Create `src/config/feeds.ts`**

```typescript
// RSS feed sources. Specific URLs TBD - using placeholders for v1 scaffold.
// Replace with verified working RSS URLs before first cron run.

export interface FeedSource {
  name: string;
  url: string;
  category: 'regulatory' | 'industry' | 'news' | 'government' | 'weather';
  enabled: boolean;
}

export const FEEDS: FeedSource[] = [
  { name: 'Fair Work Australia',           url: 'https://www.fairwork.gov.au/about-us/news-and-media-releases.rss',          category: 'regulatory', enabled: true },
  { name: 'Master Plumbers AU',            url: 'https://www.masterplumbers.com.au/feed',                                     category: 'industry',   enabled: true },
  { name: 'Master Electricians AU',        url: 'https://www.masterelectricians.com.au/feed',                                 category: 'industry',   enabled: true },
  { name: 'Housing Industry Association',  url: 'https://hia.com.au/our-industry/newsroom/feed',                              category: 'industry',   enabled: true },
  { name: 'Master Builders AU',            url: 'https://masterbuilders.com.au/news/feed',                                    category: 'industry',   enabled: true },
  { name: 'ai.gov.au',                     url: 'https://www.ai.gov.au/news.rss',                                             category: 'government', enabled: true },
  { name: 'Business.gov.au',               url: 'https://business.gov.au/news/feed',                                          category: 'government', enabled: true },
  { name: 'BOM Severe Weather AU',         url: 'http://www.bom.gov.au/fwo/IDZ00056.warnings_national.xml',                   category: 'weather',    enabled: true }
];

// Note: each URL must be verified working before deploy. Use `enabled: false` to disable a feed without removing it.
```

- [ ] **Step 4: Commit**

```bash
git add src/config/
git commit -m "feat: add site, feeds, and tag vocabulary config"
```

---

## Task 4: Supabase schema migration

**Files:**
- Create: `supabase/migrations/0001_initial_schema.sql`

- [ ] **Step 1: Create migration file**

```sql
-- Initial schema for Tradie Intel and future allied health hub.
-- The `niche` column lets both sites share this table.

create extension if not exists "uuid-ossp";

create table feed_items (
  id uuid primary key default uuid_generate_v4(),
  source text not null,
  source_url text not null,
  original_url text not null,
  title text not null,
  original_content text,
  published_at timestamptz not null,
  niche text not null check (niche in ('trades', 'allied-health')),
  ai_summary text,
  why_it_matters text,
  relevance_score int check (relevance_score between 0 and 100),
  tags text[] default '{}',
  slug text not null,
  created_at timestamptz not null default now(),
  unique (original_url)
);

create index feed_items_niche_published_idx on feed_items (niche, published_at desc);
create index feed_items_niche_relevance_idx on feed_items (niche, relevance_score desc);
create index feed_items_niche_slug_idx on feed_items (niche, slug);
create index feed_items_tags_gin on feed_items using gin (tags);

-- RLS: public can read trades items only; service role bypasses RLS for writes.
alter table feed_items enable row level security;

create policy "public read trades items"
  on feed_items for select
  using (niche = 'trades');
```

- [ ] **Step 2: Apply migration manually**

Greg must run this in the Supabase SQL editor (project setup is manual). Document the step:

Create `supabase/README.md`:
```markdown
# Supabase setup

1. Create a new Supabase project (free tier OK for v1).
2. In the SQL editor, paste and run `migrations/0001_initial_schema.sql`.
3. Copy `Project URL` to `SUPABASE_URL` in `.env`.
4. Copy `service_role` key to `SUPABASE_SERVICE_KEY` in `.env`.
5. Copy `anon` key to `SUPABASE_ANON_KEY` in `.env`.
```

- [ ] **Step 3: Commit**

```bash
git add supabase/
git commit -m "feat: add Supabase initial schema + setup docs"
```

---

## Task 5: Supabase client + FeedItem type

**Files:**
- Create: `src/lib/supabase.ts`

- [ ] **Step 1: Create `src/lib/supabase.ts`**

```typescript
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface FeedItem {
  id: string;
  source: string;
  source_url: string;
  original_url: string;
  title: string;
  original_content: string | null;
  published_at: string;
  niche: 'trades' | 'allied-health';
  ai_summary: string | null;
  why_it_matters: string | null;
  relevance_score: number | null;
  tags: string[];
  slug: string;
  created_at: string;
}

let _adminClient: SupabaseClient | null = null;
let _publicClient: SupabaseClient | null = null;

/** Server-only client with service role - writes allowed. */
export function adminClient(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      import.meta.env.SUPABASE_URL,
      import.meta.env.SUPABASE_SERVICE_KEY
    );
  }
  return _adminClient;
}

/** Public client with anon key - reads only via RLS. */
export function publicClient(): SupabaseClient {
  if (!_publicClient) {
    _publicClient = createClient(
      import.meta.env.SUPABASE_URL,
      import.meta.env.SUPABASE_ANON_KEY
    );
  }
  return _publicClient;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/supabase.ts
git commit -m "feat: add Supabase client wrappers and FeedItem type"
```

---

## Task 6: Slug utility (TDD)

**Files:**
- Create: `tests/lib/slug.test.ts`, `src/lib/slug.ts`

- [ ] **Step 1: Write failing test**

`tests/lib/slug.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { titleToSlug } from '@/lib/slug';

describe('titleToSlug', () => {
  it('lowercases and hyphenates', () => {
    expect(titleToSlug('New Licensing Rules')).toBe('new-licensing-rules');
  });
  it('strips punctuation', () => {
    expect(titleToSlug("Plumber's Guide: 2026 Update")).toBe('plumbers-guide-2026-update');
  });
  it('collapses whitespace', () => {
    expect(titleToSlug('A    B   C')).toBe('a-b-c');
  });
  it('truncates long slugs to 80 chars', () => {
    const long = 'word '.repeat(50);
    expect(titleToSlug(long).length).toBeLessThanOrEqual(80);
  });
  it('handles non-ASCII', () => {
    expect(titleToSlug('Café résumé')).toBe('cafe-resume');
  });
  it('appends a short hash when given a duplicate suffix', () => {
    expect(titleToSlug('Test', 'abc123')).toBe('test-abc123');
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
npm test -- tests/lib/slug.test.ts
```
Expected: failure - `@/lib/slug` not found.

- [ ] **Step 3: Implement slug.ts**

`src/lib/slug.ts`:
```typescript
const MAX_LEN = 80;

export function titleToSlug(title: string, suffix?: string): string {
  let s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')      // strip punctuation
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim()
    .replace(/\s/g, '-');              // spaces to hyphens

  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN).replace(/-[^-]*$/, '');
  if (suffix) s = `${s}-${suffix}`;
  return s;
}
```

- [ ] **Step 4: Verify tests pass**

```bash
npm test -- tests/lib/slug.test.ts
```
Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/lib/slug.test.ts src/lib/slug.ts
git commit -m "feat: add slug generation utility (TDD)"
```

---

## Task 7: RSS fetcher (TDD)

**Files:**
- Create: `tests/lib/rss.test.ts`, `src/lib/rss.ts`

- [ ] **Step 1: Write failing test**

`tests/lib/rss.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { parseFeedXml } from '@/lib/rss';

const SAMPLE_RSS = `<?xml version="1.0"?>
<rss version="2.0">
<channel>
  <title>Sample Feed</title>
  <item>
    <title>Story One</title>
    <link>https://example.com/one</link>
    <pubDate>Mon, 22 May 2026 06:00:00 +1000</pubDate>
    <description>Summary one</description>
  </item>
  <item>
    <title>Story Two</title>
    <link>https://example.com/two</link>
    <pubDate>Mon, 22 May 2026 07:00:00 +1000</pubDate>
    <description>Summary two</description>
  </item>
</channel>
</rss>`;

describe('parseFeedXml', () => {
  it('returns array of items with normalised fields', async () => {
    const items = await parseFeedXml(SAMPLE_RSS);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: 'Story One',
      url: 'https://example.com/one',
      content: 'Summary one'
    });
    expect(items[0].publishedAt).toBeInstanceOf(Date);
  });

  it('handles missing description', async () => {
    const xml = SAMPLE_RSS.replace(/<description>[^<]+<\/description>/g, '');
    const items = await parseFeedXml(xml);
    expect(items[0].content).toBe('');
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
npm test -- tests/lib/rss.test.ts
```
Expected: failure.

- [ ] **Step 3: Implement rss.ts**

`src/lib/rss.ts`:
```typescript
import Parser from 'rss-parser';

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'TradieIntel/1.0 (+https://tradieintel.com.au)' }
});

export interface RssItem {
  title: string;
  url: string;
  content: string;
  publishedAt: Date;
}

export async function parseFeedXml(xml: string): Promise<RssItem[]> {
  const feed = await parser.parseString(xml);
  return (feed.items ?? [])
    .filter(i => i.title && i.link)
    .map(i => ({
      title: i.title!.trim(),
      url: i.link!.trim(),
      content: (i.contentSnippet ?? i.content ?? '').trim(),
      publishedAt: i.isoDate ? new Date(i.isoDate) : new Date()
    }));
}

export async function fetchFeed(url: string): Promise<RssItem[]> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'TradieIntel/1.0 (+https://tradieintel.com.au)' }
  });
  if (!res.ok) throw new Error(`Feed ${url} returned HTTP ${res.status}`);
  const xml = await res.text();
  return parseFeedXml(xml);
}
```

- [ ] **Step 4: Verify tests pass**

```bash
npm test -- tests/lib/rss.test.ts
```
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/lib/rss.test.ts src/lib/rss.ts
git commit -m "feat: add RSS fetcher and XML parser (TDD)"
```

---

## Task 8: Claude enrichment service (TDD)

**Files:**
- Create: `tests/lib/claude.test.ts`, `src/lib/claude.ts`

- [ ] **Step 1: Write failing test**

`tests/lib/claude.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { normaliseTags, enrichmentPrompt } from '@/lib/claude';

describe('normaliseTags', () => {
  it('lowercases trade categories', () => {
    expect(normaliseTags(['Plumbing', 'electrical'])).toEqual(['plumbing', 'electrical']);
  });
  it('preserves uppercase state codes', () => {
    expect(normaliseTags(['QLD', 'nsw'])).toEqual(['QLD', 'NSW']);
  });
  it('maps known aliases to canonical form', () => {
    expect(normaliseTags(['Queensland', 'plumber'])).toEqual(['QLD', 'plumbing']);
  });
  it('drops unknown tags', () => {
    expect(normaliseTags(['plumbing', 'random-garbage'])).toEqual(['plumbing']);
  });
  it('de-dupes', () => {
    expect(normaliseTags(['QLD', 'qld', 'Queensland'])).toEqual(['QLD']);
  });
});

describe('enrichmentPrompt', () => {
  it('includes the title and content', () => {
    const p = enrichmentPrompt({ title: 'Foo', content: 'Bar' });
    expect(p).toContain('Foo');
    expect(p).toContain('Bar');
  });
  it('lists allowed tags', () => {
    const p = enrichmentPrompt({ title: 'x', content: 'y' });
    expect(p).toContain('plumbing');
    expect(p).toContain('QLD');
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
npm test -- tests/lib/claude.test.ts
```
Expected: failure.

- [ ] **Step 3: Implement claude.ts**

`src/lib/claude.ts`:
```typescript
import Anthropic from '@anthropic-ai/sdk';
import { ALLOWED_TAGS, TAG_ALIASES, STATES } from '@/config/tags';

const STATE_SET = new Set<string>(STATES);

export interface Enrichment {
  summary: string;
  whyItMatters: string;
  relevanceScore: number;
  tags: string[];
}

export interface EnrichmentInput {
  title: string;
  content: string;
}

export function normaliseTags(raw: string[]): string[] {
  const out = new Set<string>();
  for (const t of raw) {
    const lower = t.trim().toLowerCase();
    const canonical = TAG_ALIASES[lower] ?? lower;
    const final = STATE_SET.has(canonical.toUpperCase()) ? canonical.toUpperCase() : canonical;
    if (ALLOWED_TAGS.has(final)) out.add(final);
  }
  return Array.from(out);
}

export function enrichmentPrompt({ title, content }: EnrichmentInput): string {
  const tagList = Array.from(ALLOWED_TAGS).join(', ');
  return `You are an editorial assistant for an Australian trades-industry news site. Read the article below and respond with a single JSON object - no prose, no markdown fences.

Required JSON shape:
{
  "summary": "2-3 sentence summary written for an Australian tradesperson. Plain English. No marketing language.",
  "why_it_matters": "ONE sentence explaining the practical impact on a trades operator's day-to-day business.",
  "relevance_score": <integer 0-100>,
  "tags": [<2-5 tags from the controlled vocabulary>]
}

Controlled tag vocabulary (use ONLY these): ${tagList}

Article title: ${title}
Article content: ${content}

Respond with JSON only.`;
}

export async function enrich(input: EnrichmentInput): Promise<Enrichment> {
  const client = new Anthropic({ apiKey: import.meta.env.ANTHROPIC_API_KEY });
  const model = import.meta.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: enrichmentPrompt(input) }]
  });
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text).join('').trim();

  const parsed = JSON.parse(text);
  return {
    summary: String(parsed.summary ?? '').trim(),
    whyItMatters: String(parsed.why_it_matters ?? '').trim(),
    relevanceScore: Math.max(0, Math.min(100, Number(parsed.relevance_score) || 0)),
    tags: normaliseTags(Array.isArray(parsed.tags) ? parsed.tags.map(String) : [])
  };
}
```

- [ ] **Step 4: Verify tests pass**

```bash
npm test -- tests/lib/claude.test.ts
```
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/lib/claude.test.ts src/lib/claude.ts
git commit -m "feat: add Claude enrichment with tag normalisation (TDD)"
```

---

## Task 9: Email provider abstraction (TDD)

**Files:**
- Create: `tests/lib/email.test.ts`, `src/lib/email.ts`

- [ ] **Step 1: Write failing test**

`tests/lib/email.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryProvider, isValidEmail } from '@/lib/email';

describe('isValidEmail', () => {
  it('accepts valid emails', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('a.b+c@sub.example.com.au')).toBe(true);
  });
  it('rejects obvious junk', () => {
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('@nodomain')).toBe(false);
    expect(isValidEmail('no@tld')).toBe(false);
  });
});

describe('MemoryProvider', () => {
  let provider: MemoryProvider;
  beforeEach(() => { provider = new MemoryProvider(); });

  it('stores a subscriber', async () => {
    await provider.subscribe('a@b.com');
    expect(provider.list()).toEqual(['a@b.com']);
  });

  it('de-dupes', async () => {
    await provider.subscribe('a@b.com');
    await provider.subscribe('a@b.com');
    expect(provider.list()).toEqual(['a@b.com']);
  });

  it('rejects invalid emails', async () => {
    await expect(provider.subscribe('garbage')).rejects.toThrow(/invalid email/i);
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
npm test -- tests/lib/email.test.ts
```
Expected: failure.

- [ ] **Step 3: Implement email.ts**

`src/lib/email.ts`:
```typescript
export interface EmailProvider {
  subscribe(email: string, source?: string): Promise<void>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(s: string): boolean {
  return typeof s === 'string' && EMAIL_RE.test(s.trim());
}

export class MemoryProvider implements EmailProvider {
  private set = new Set<string>();
  async subscribe(email: string): Promise<void> {
    const trimmed = email.trim().toLowerCase();
    if (!isValidEmail(trimmed)) throw new Error('Invalid email');
    this.set.add(trimmed);
  }
  list(): string[] { return Array.from(this.set); }
}

export class KitProvider implements EmailProvider {
  constructor(
    private apiKey: string,
    private formId: string
  ) {}
  async subscribe(email: string, source = 'tradie-intel'): Promise<void> {
    if (!isValidEmail(email)) throw new Error('Invalid email');
    const res = await fetch(`https://api.kit.com/v4/forms/${this.formId}/subscribers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kit-Api-Key': this.apiKey
      },
      body: JSON.stringify({ email_address: email, referrer: source })
    });
    if (!res.ok) throw new Error(`Kit API error: ${res.status} ${await res.text()}`);
  }
}

export class LoopsProvider implements EmailProvider {
  constructor(private apiKey: string, private listId: string) {}
  async subscribe(email: string, source = 'tradie-intel'): Promise<void> {
    if (!isValidEmail(email)) throw new Error('Invalid email');
    const res = await fetch('https://app.loops.so/api/v1/contacts/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({ email, mailingLists: { [this.listId]: true }, source })
    });
    if (!res.ok) throw new Error(`Loops API error: ${res.status} ${await res.text()}`);
  }
}

export class MailchimpProvider implements EmailProvider {
  constructor(private apiKey: string, private listId: string) {}
  async subscribe(email: string): Promise<void> {
    if (!isValidEmail(email)) throw new Error('Invalid email');
    const dc = this.apiKey.split('-')[1];
    if (!dc) throw new Error('Invalid Mailchimp API key (no datacenter suffix)');
    const res = await fetch(`https://${dc}.api.mailchimp.com/3.0/lists/${this.listId}/members`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({ email_address: email, status: 'pending' })
    });
    if (!res.ok && res.status !== 400) {
      throw new Error(`Mailchimp API error: ${res.status} ${await res.text()}`);
    }
  }
}

export function getProvider(): EmailProvider {
  const which = import.meta.env.EMAIL_PROVIDER;
  const apiKey = import.meta.env.EMAIL_PROVIDER_API_KEY;
  const listId = import.meta.env.EMAIL_LIST_ID;
  switch (which) {
    case 'kit':       return new KitProvider(apiKey, listId);
    case 'loops':     return new LoopsProvider(apiKey, listId);
    case 'mailchimp': return new MailchimpProvider(apiKey, listId);
    case 'memory':    return new MemoryProvider();
    default: throw new Error(`Unknown EMAIL_PROVIDER: ${which}`);
  }
}
```

- [ ] **Step 4: Verify tests pass**

```bash
npm test -- tests/lib/email.test.ts
```
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/lib/email.test.ts src/lib/email.ts
git commit -m "feat: add email provider abstraction with Kit/Loops/Mailchimp/Memory (TDD)"
```

---

## Task 10: Related items selection (TDD)

**Files:**
- Create: `tests/lib/related.test.ts`, `src/lib/related.ts`

- [ ] **Step 1: Write failing test**

`tests/lib/related.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { selectRelated } from '@/lib/related';
import type { FeedItem } from '@/lib/supabase';

function item(o: Partial<FeedItem>): FeedItem {
  return {
    id: 'x', source: 'src', source_url: 'u', original_url: 'u', title: 't',
    original_content: null, published_at: new Date().toISOString(),
    niche: 'trades', ai_summary: null, why_it_matters: null,
    relevance_score: 50, tags: [], slug: 's', created_at: new Date().toISOString(),
    ...o
  };
}

describe('selectRelated', () => {
  const current = item({ id: 'c', tags: ['plumbing', 'QLD'], source: 'src-a' });

  it('prefers items with most tag overlap', () => {
    const candidates = [
      item({ id: '1', tags: ['electrical'] }),                  // 0 overlap
      item({ id: '2', tags: ['plumbing'] }),                    // 1 overlap
      item({ id: '3', tags: ['plumbing', 'QLD'] })              // 2 overlap
    ];
    expect(selectRelated(current, candidates, 2).map(i => i.id)).toEqual(['3', '2']);
  });

  it('falls back to same source when no tag overlap', () => {
    const candidates = [
      item({ id: '1', tags: ['random'], source: 'src-b' }),
      item({ id: '2', tags: ['random'], source: 'src-a' })
    ];
    expect(selectRelated(current, candidates, 1).map(i => i.id)).toEqual(['2']);
  });

  it('falls back to most recent if nothing matches', () => {
    const candidates = [
      item({ id: '1', tags: ['x'], source: 'other', published_at: '2026-01-01T00:00:00Z' }),
      item({ id: '2', tags: ['y'], source: 'other', published_at: '2026-05-01T00:00:00Z' })
    ];
    expect(selectRelated(current, candidates, 1).map(i => i.id)).toEqual(['2']);
  });

  it('never returns the current item', () => {
    const candidates = [current, item({ id: 'other', tags: ['plumbing'] })];
    expect(selectRelated(current, candidates, 5).map(i => i.id)).not.toContain('c');
  });

  it('respects the limit', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => item({ id: `${i}`, tags: ['plumbing'] }));
    expect(selectRelated(current, candidates, 3)).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
npm test -- tests/lib/related.test.ts
```
Expected: failure.

- [ ] **Step 3: Implement related.ts**

`src/lib/related.ts`:
```typescript
import type { FeedItem } from '@/lib/supabase';

export function selectRelated(current: FeedItem, candidates: FeedItem[], limit: number): FeedItem[] {
  const others = candidates.filter(c => c.id !== current.id);
  const currentTags = new Set(current.tags);

  const scored = others.map(c => {
    const overlap = c.tags.filter(t => currentTags.has(t)).length;
    const sameSource = c.source === current.source ? 1 : 0;
    const ts = new Date(c.published_at).getTime();
    return { item: c, overlap, sameSource, ts };
  });

  scored.sort((a, b) => {
    if (b.overlap !== a.overlap) return b.overlap - a.overlap;
    if (b.sameSource !== a.sameSource) return b.sameSource - a.sameSource;
    return b.ts - a.ts;
  });

  return scored.slice(0, limit).map(s => s.item);
}
```

- [ ] **Step 4: Verify tests pass**

```bash
npm test -- tests/lib/related.test.ts
```
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/lib/related.test.ts src/lib/related.ts
git commit -m "feat: add related items selection logic (TDD)"
```

---

## Task 11: /api/subscribe endpoint (TDD)

**Files:**
- Create: `tests/api/subscribe.test.ts`, `src/pages/api/subscribe.ts`

- [ ] **Step 1: Write failing test**

`tests/api/subscribe.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { handleSubscribe } from '@/pages/api/subscribe';
import { MemoryProvider } from '@/lib/email';

describe('handleSubscribe', () => {
  it('returns 200 on valid email', async () => {
    const provider = new MemoryProvider();
    const req = new Request('http://x/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com' })
    });
    const res = await handleSubscribe(req, provider);
    expect(res.status).toBe(200);
    expect(provider.list()).toEqual(['a@b.com']);
  });

  it('returns 400 on invalid email', async () => {
    const provider = new MemoryProvider();
    const req = new Request('http://x/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'garbage' })
    });
    const res = await handleSubscribe(req, provider);
    expect(res.status).toBe(400);
  });

  it('returns 405 on non-POST', async () => {
    const provider = new MemoryProvider();
    const req = new Request('http://x/api/subscribe', { method: 'GET' });
    const res = await handleSubscribe(req, provider);
    expect(res.status).toBe(405);
  });

  it('returns 400 on missing email field', async () => {
    const provider = new MemoryProvider();
    const req = new Request('http://x/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const res = await handleSubscribe(req, provider);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
npm test -- tests/api/subscribe.test.ts
```
Expected: failure.

- [ ] **Step 3: Implement subscribe.ts**

`src/pages/api/subscribe.ts`:
```typescript
import type { APIRoute } from 'astro';
import { getProvider, type EmailProvider } from '@/lib/email';

export const prerender = false;

export async function handleSubscribe(req: Request, provider: EmailProvider): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let body: any;
  try { body = await req.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email) return new Response(JSON.stringify({ error: 'email required' }), { status: 400 });
  try {
    await provider.subscribe(email);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    if (/invalid email/i.test(err?.message ?? '')) {
      return new Response(JSON.stringify({ error: 'invalid email' }), { status: 400 });
    }
    return new Response(JSON.stringify({ error: 'subscribe failed' }), { status: 500 });
  }
}

export const POST: APIRoute = async ({ request }) => handleSubscribe(request, getProvider());
export const GET: APIRoute = async ({ request }) => handleSubscribe(request, getProvider());
```

- [ ] **Step 4: Verify tests pass**

```bash
npm test -- tests/api/subscribe.test.ts
```
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/api/subscribe.test.ts src/pages/api/subscribe.ts
git commit -m "feat: add /api/subscribe endpoint with provider injection (TDD)"
```

---

## Task 12: /api/cron/refresh-feeds endpoint (TDD)

**Files:**
- Create: `tests/api/refresh-feeds.test.ts`, `src/pages/api/cron/refresh-feeds.ts`

- [ ] **Step 1: Write failing test**

`tests/api/refresh-feeds.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { authoriseCron, dedupeAgainstExisting } from '@/pages/api/cron/refresh-feeds';

describe('authoriseCron', () => {
  it('accepts matching bearer token', () => {
    const req = new Request('http://x', { headers: { Authorization: 'Bearer s3cret' } });
    expect(authoriseCron(req, 's3cret')).toBe(true);
  });
  it('rejects missing header', () => {
    const req = new Request('http://x');
    expect(authoriseCron(req, 's3cret')).toBe(false);
  });
  it('rejects wrong token', () => {
    const req = new Request('http://x', { headers: { Authorization: 'Bearer nope' } });
    expect(authoriseCron(req, 's3cret')).toBe(false);
  });
});

describe('dedupeAgainstExisting', () => {
  it('filters out items whose URL already exists', () => {
    const existing = new Set(['https://a', 'https://b']);
    const candidates = [
      { url: 'https://a', title: 'A', content: '', publishedAt: new Date() },
      { url: 'https://c', title: 'C', content: '', publishedAt: new Date() }
    ];
    const result = dedupeAgainstExisting(candidates, existing);
    expect(result.map(r => r.url)).toEqual(['https://c']);
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
npm test -- tests/api/refresh-feeds.test.ts
```
Expected: failure.

- [ ] **Step 3: Implement refresh-feeds.ts**

`src/pages/api/cron/refresh-feeds.ts`:
```typescript
import type { APIRoute } from 'astro';
import { FEEDS } from '@/config/feeds';
import { fetchFeed, type RssItem } from '@/lib/rss';
import { enrich } from '@/lib/claude';
import { adminClient } from '@/lib/supabase';
import { titleToSlug } from '@/lib/slug';
import { SITE } from '@/config/site';

export const prerender = false;

export function authoriseCron(req: Request, secret: string): boolean {
  const auth = req.headers.get('authorization') ?? '';
  return auth === `Bearer ${secret}`;
}

export function dedupeAgainstExisting<T extends { url: string }>(items: T[], existing: Set<string>): T[] {
  return items.filter(i => !existing.has(i.url));
}

async function getExistingUrls(): Promise<Set<string>> {
  const supa = adminClient();
  const { data, error } = await supa
    .from('feed_items')
    .select('original_url')
    .eq('niche', SITE.niche);
  if (error) throw error;
  return new Set((data ?? []).map((r: any) => r.original_url));
}

interface InsertRow {
  source: string;
  source_url: string;
  original_url: string;
  title: string;
  original_content: string;
  published_at: string;
  niche: string;
  ai_summary: string;
  why_it_matters: string;
  relevance_score: number;
  tags: string[];
  slug: string;
}

async function processItem(item: RssItem, feedName: string, feedUrl: string): Promise<InsertRow | null> {
  try {
    const enr = await enrich({ title: item.title, content: item.content });
    return {
      source: feedName,
      source_url: feedUrl,
      original_url: item.url,
      title: item.title,
      original_content: item.content,
      published_at: item.publishedAt.toISOString(),
      niche: SITE.niche,
      ai_summary: enr.summary,
      why_it_matters: enr.whyItMatters,
      relevance_score: enr.relevanceScore,
      tags: enr.tags,
      slug: titleToSlug(item.title, item.url.slice(-6).replace(/[^a-z0-9]/gi, ''))
    };
  } catch (err) {
    console.error('Enrichment failed for', item.url, err);
    return null;
  }
}

export const GET: APIRoute = async ({ request }) => {
  if (!authoriseCron(request, import.meta.env.CRON_SECRET)) {
    return new Response('Unauthorised', { status: 401 });
  }

  const existing = await getExistingUrls();
  const supa = adminClient();
  const summary = { feeds: 0, fetched: 0, new_items: 0, enriched: 0, errors: 0 };

  for (const feed of FEEDS.filter(f => f.enabled)) {
    summary.feeds++;
    try {
      const items = await fetchFeed(feed.url);
      summary.fetched += items.length;
      const fresh = dedupeAgainstExisting(items, existing);
      summary.new_items += fresh.length;

      for (const item of fresh) {
        const row = await processItem(item, feed.name, feed.url);
        if (!row) { summary.errors++; continue; }
        const { error } = await supa.from('feed_items').insert(row);
        if (error) { summary.errors++; console.error('Insert failed', error); }
        else { summary.enriched++; existing.add(item.url); }
      }
    } catch (err) {
      summary.errors++;
      console.error('Feed failed:', feed.name, err);
    }
  }

  return new Response(JSON.stringify(summary), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
};
```

- [ ] **Step 4: Verify tests pass**

```bash
npm test -- tests/api/refresh-feeds.test.ts
```
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/api/refresh-feeds.test.ts src/pages/api/cron/refresh-feeds.ts
git commit -m "feat: add /api/cron/refresh-feeds with auth and dedupe (TDD)"
```

---

## Task 13: Base layout

**Files:**
- Create: `src/layouts/Base.astro`

- [ ] **Step 1: Create Base layout**

```astro
---
import { SITE } from '@/config/site';
import Header from '@/components/Header.astro';
import Footer from '@/components/Footer.astro';
import '@/styles/global.css';

interface Props {
  title?: string;
  description?: string;
  canonical?: string;
}
const { title, description = SITE.description, canonical } = Astro.props;
const fullTitle = title ? `${title} | ${SITE.name}` : `${SITE.name} - ${SITE.description}`;
const canonicalUrl = canonical ?? new URL(Astro.url.pathname, SITE.url).href;
---
<!DOCTYPE html>
<html lang="en-AU">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>{fullTitle}</title>
    <meta name="description" content={description} />
    <link rel="canonical" href={canonicalUrl} />
    <meta property="og:title" content={fullTitle} />
    <meta property="og:description" content={description} />
    <meta property="og:url" content={canonicalUrl} />
    <meta property="og:site_name" content={SITE.name} />
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary" />
  </head>
  <body class="min-h-screen flex flex-col bg-slate-50">
    <Header />
    <main class="flex-1"><slot /></main>
    <Footer />
  </body>
</html>
```

- [ ] **Step 2: Commit (will fail to render until Header/Footer exist - intentional, next task adds them)**

```bash
git add src/layouts/Base.astro
git commit -m "feat: add Base layout with SEO meta"
```

---

## Task 14: Header and Footer components

**Files:**
- Create: `src/components/Header.astro`, `src/components/Footer.astro`

- [ ] **Step 1: Create Header.astro**

```astro
---
import { SITE } from '@/config/site';
---
<header class="bg-white border-b border-slate-200">
  <div class="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
    <a href="/" class="text-xl font-bold text-brand">{SITE.name}</a>
    <nav class="flex items-center gap-6 text-sm">
      <a href="/" class="text-slate-700 hover:text-brand">Home</a>
      <a href="/news" class="text-slate-700 hover:text-brand">News</a>
      <a href={SITE.parent.url} class="text-slate-700 hover:text-brand" rel="noopener">
        {SITE.parent.name} <span aria-hidden="true">↗</span>
      </a>
    </nav>
  </div>
</header>
```

- [ ] **Step 2: Create Footer.astro**

```astro
---
import { SITE } from '@/config/site';
const year = new Date().getFullYear();
---
<footer class="bg-slate-900 text-slate-300 mt-16">
  <div class="max-w-5xl mx-auto px-4 py-8 text-sm flex flex-col sm:flex-row justify-between gap-4">
    <div>
      <div class="font-semibold text-white">{SITE.name}</div>
      <div class="text-slate-400 mt-1">{SITE.description}</div>
    </div>
    <nav class="flex flex-col sm:flex-row gap-2 sm:gap-6">
      <a href="/about" class="hover:text-white">About</a>
      <a href="/privacy" class="hover:text-white">Privacy</a>
      <a href="/terms" class="hover:text-white">Terms</a>
      <a href={SITE.parent.url} class="hover:text-white" rel="noopener">
        Built by {SITE.parent.name} ↗
      </a>
    </nav>
  </div>
  <div class="border-t border-slate-800 text-center text-xs text-slate-500 py-3">
    © {year} {SITE.parent.name}. All rights reserved.
  </div>
</footer>
```

- [ ] **Step 3: Commit**

```bash
git add src/components/Header.astro src/components/Footer.astro
git commit -m "feat: add Header and Footer components"
```

---

## Task 15: EmailCapture + Hero components

**Files:**
- Create: `src/components/EmailCapture.astro`, `src/components/Hero.astro`

- [ ] **Step 1: Create EmailCapture.astro**

```astro
---
import { SITE } from '@/config/site';
interface Props { compact?: boolean; }
const { compact = false } = Astro.props;
---
<form
  data-subscribe
  class:list={[
    'flex flex-col sm:flex-row gap-2',
    compact ? 'max-w-md' : 'max-w-xl'
  ]}
>
  <input
    type="email"
    name="email"
    required
    placeholder={SITE.email.capturePlaceholder}
    class="flex-1 px-4 py-2 rounded-md border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-light"
  />
  <button
    type="submit"
    class="px-5 py-2 rounded-md bg-brand text-white font-semibold hover:bg-brand-dark transition-colors"
  >
    {SITE.email.ctaButton}
  </button>
</form>
<p data-subscribe-msg class="mt-2 text-sm text-slate-600 hidden"></p>

<script>
  document.querySelectorAll('form[data-subscribe]').forEach(form => {
    const f = form as HTMLFormElement;
    const msg = f.parentElement?.querySelector('[data-subscribe-msg]') as HTMLElement;
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = new FormData(f);
      const email = data.get('email') as string;
      msg.classList.remove('hidden');
      msg.textContent = 'Subscribing...';
      try {
        const res = await fetch('/api/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        const json = await res.json();
        if (res.ok) {
          msg.textContent = "You're in. Check your inbox to confirm.";
          f.reset();
        } else {
          msg.textContent = json?.error === 'invalid email'
            ? 'That email looks wrong - try again.'
            : 'Something went wrong. Try again later.';
        }
      } catch {
        msg.textContent = 'Network error - try again.';
      }
    });
  });
</script>
```

- [ ] **Step 2: Create Hero.astro**

```astro
---
import { SITE } from '@/config/site';
import EmailCapture from './EmailCapture.astro';
---
<section class="bg-gradient-to-br from-brand-dark to-brand text-white">
  <div class="max-w-5xl mx-auto px-4 py-12 sm:py-16">
    <h1 class="text-3xl sm:text-4xl font-bold tracking-tight">{SITE.email.ctaHeadline}</h1>
    <p class="mt-3 text-lg text-blue-100">{SITE.email.ctaSubhead}</p>
    <div class="mt-6"><EmailCapture /></div>
    <p class="mt-3 text-xs text-blue-200">
      One email per day. Unsubscribe anytime. We never share your address.
    </p>
  </div>
</section>
```

- [ ] **Step 3: Commit**

```bash
git add src/components/EmailCapture.astro src/components/Hero.astro
git commit -m "feat: add EmailCapture and Hero components"
```

---

## Task 16: SourceBadge + FeedCard components

**Files:**
- Create: `src/components/SourceBadge.astro`, `src/components/FeedCard.astro`

- [ ] **Step 1: Create SourceBadge.astro**

```astro
---
interface Props { source: string; }
const { source } = Astro.props;
---
<span class="inline-block text-xs font-medium uppercase tracking-wide text-brand bg-blue-50 px-2 py-1 rounded">
  {source}
</span>
```

- [ ] **Step 2: Create FeedCard.astro**

```astro
---
import type { FeedItem } from '@/lib/supabase';
import SourceBadge from './SourceBadge.astro';
interface Props { item: FeedItem; }
const { item } = Astro.props;
const formattedDate = new Date(item.published_at).toLocaleDateString('en-AU', {
  day: 'numeric', month: 'short', year: 'numeric'
});
---
<article class="bg-white border border-slate-200 rounded-lg p-5 hover:shadow-md transition-shadow">
  <div class="flex items-center gap-2 mb-2 text-sm text-slate-500">
    <SourceBadge source={item.source} />
    <span>·</span>
    <time datetime={item.published_at}>{formattedDate}</time>
  </div>
  <h3 class="text-lg font-semibold text-slate-900 mb-2">
    <a href={`/news/${item.slug}`} class="hover:text-brand">{item.title}</a>
  </h3>
  {item.ai_summary && <p class="text-slate-700 mb-3">{item.ai_summary}</p>}
  {item.why_it_matters && (
    <p class="text-sm text-slate-600 border-l-2 border-brand pl-3 mb-3">
      <span class="font-semibold">Why it matters:</span> {item.why_it_matters}
    </p>
  )}
  {item.tags.length > 0 && (
    <div class="flex flex-wrap gap-1.5 mt-3">
      {item.tags.map(tag => (
        <span class="text-xs text-slate-600 bg-slate-100 px-2 py-0.5 rounded">{tag}</span>
      ))}
    </div>
  )}
</article>
```

- [ ] **Step 3: Commit**

```bash
git add src/components/SourceBadge.astro src/components/FeedCard.astro
git commit -m "feat: add SourceBadge and FeedCard components"
```

---

## Task 17: Homepage

**Files:**
- Create: `src/pages/index.astro`

- [ ] **Step 1: Create homepage**

```astro
---
import Base from '@/layouts/Base.astro';
import Hero from '@/components/Hero.astro';
import FeedCard from '@/components/FeedCard.astro';
import EmailCapture from '@/components/EmailCapture.astro';
import { publicClient } from '@/lib/supabase';
import { SITE } from '@/config/site';
import type { FeedItem } from '@/lib/supabase';

export const prerender = false;

const supa = publicClient();
const { data, error } = await supa
  .from('feed_items')
  .select('*')
  .eq('niche', SITE.niche)
  .gte('relevance_score', 40)
  .order('published_at', { ascending: false })
  .limit(15);

const items = (data ?? []) as FeedItem[];
---
<Base>
  <Hero />
  <section class="max-w-5xl mx-auto px-4 py-12">
    {error && (
      <div class="bg-amber-50 border border-amber-200 text-amber-900 p-4 rounded mb-6">
        Unable to load feed right now. Try refreshing in a minute.
      </div>
    )}
    {items.length === 0 && !error && (
      <div class="text-center py-12 text-slate-500">
        No items yet - check back tomorrow morning.
      </div>
    )}
    <div class="grid gap-4">
      {items.slice(0, 5).map(item => <FeedCard item={item} />)}
    </div>
    {items.length > 5 && (
      <>
        <div class="bg-blue-50 border border-blue-200 rounded-lg p-6 my-8">
          <h3 class="text-lg font-semibold mb-2">Get this in your inbox</h3>
          <p class="text-slate-700 mb-4 text-sm">Daily summary, no fluff. One email per morning.</p>
          <EmailCapture compact />
        </div>
        <div class="grid gap-4">
          {items.slice(5).map(item => <FeedCard item={item} />)}
        </div>
      </>
    )}
    <div class="mt-8 text-center">
      <a href="/news" class="text-brand font-medium hover:underline">View all news →</a>
    </div>
  </section>
</Base>
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/index.astro
git commit -m "feat: add homepage with hero, feed, inline capture"
```

---

## Task 18: /news archive page

**Files:**
- Create: `src/pages/news/index.astro`

- [ ] **Step 1: Create archive page**

```astro
---
import Base from '@/layouts/Base.astro';
import FeedCard from '@/components/FeedCard.astro';
import { publicClient } from '@/lib/supabase';
import { SITE } from '@/config/site';
import type { FeedItem } from '@/lib/supabase';

export const prerender = false;

const url = new URL(Astro.request.url);
const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
const PAGE_SIZE = 20;
const from = (page - 1) * PAGE_SIZE;
const to = from + PAGE_SIZE - 1;

const supa = publicClient();
const { data, count } = await supa
  .from('feed_items')
  .select('*', { count: 'exact' })
  .eq('niche', SITE.niche)
  .order('published_at', { ascending: false })
  .range(from, to);

const items = (data ?? []) as FeedItem[];
const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
---
<Base title="News Archive" description="All Tradie Intel news items, latest first.">
  <section class="max-w-5xl mx-auto px-4 py-12">
    <h1 class="text-3xl font-bold mb-8">News Archive</h1>
    <div class="grid gap-4">
      {items.map(item => <FeedCard item={item} />)}
    </div>
    <nav class="flex justify-between items-center mt-8" aria-label="Pagination">
      {page > 1
        ? <a href={`/news?page=${page - 1}`} class="text-brand hover:underline">← Newer</a>
        : <span />}
      <span class="text-sm text-slate-500">Page {page} of {totalPages}</span>
      {page < totalPages
        ? <a href={`/news?page=${page + 1}`} class="text-brand hover:underline">Older →</a>
        : <span />}
    </nav>
  </section>
</Base>
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/news/index.astro
git commit -m "feat: add /news archive with pagination"
```

---

## Task 19: /news/[slug] item page

**Files:**
- Create: `src/pages/news/[slug].astro`

- [ ] **Step 1: Create item page**

```astro
---
import Base from '@/layouts/Base.astro';
import FeedCard from '@/components/FeedCard.astro';
import EmailCapture from '@/components/EmailCapture.astro';
import SourceBadge from '@/components/SourceBadge.astro';
import { publicClient } from '@/lib/supabase';
import { SITE } from '@/config/site';
import { selectRelated } from '@/lib/related';
import type { FeedItem } from '@/lib/supabase';

export const prerender = false;

const { slug } = Astro.params;
if (!slug) return Astro.redirect('/news');

const supa = publicClient();
const { data: itemData } = await supa
  .from('feed_items')
  .select('*')
  .eq('niche', SITE.niche)
  .eq('slug', slug)
  .maybeSingle();

if (!itemData) return new Response('Not found', { status: 404 });
const item = itemData as FeedItem;

const { data: candidates } = await supa
  .from('feed_items')
  .select('*')
  .eq('niche', SITE.niche)
  .neq('id', item.id)
  .order('published_at', { ascending: false })
  .limit(50);

const related = selectRelated(item, (candidates ?? []) as FeedItem[], 3);
const formattedDate = new Date(item.published_at).toLocaleDateString('en-AU', {
  day: 'numeric', month: 'long', year: 'numeric'
});
---
<Base title={item.title} description={item.ai_summary ?? item.title}>
  <article class="max-w-3xl mx-auto px-4 py-12">
    <nav class="text-sm text-slate-500 mb-4" aria-label="Breadcrumb">
      <a href="/" class="hover:text-brand">Home</a>
      <span class="mx-1">›</span>
      <a href="/news" class="hover:text-brand">News</a>
    </nav>

    <div class="flex items-center gap-2 mb-4 text-sm text-slate-500">
      <SourceBadge source={item.source} />
      <span>·</span>
      <time datetime={item.published_at}>{formattedDate}</time>
    </div>

    <h1 class="text-3xl sm:text-4xl font-bold text-slate-900 mb-6">{item.title}</h1>

    {item.ai_summary && (
      <div class="prose prose-slate max-w-none mb-6">
        <p class="text-lg text-slate-800">{item.ai_summary}</p>
      </div>
    )}

    {item.why_it_matters && (
      <div class="bg-blue-50 border-l-4 border-brand p-4 my-6 rounded-r">
        <p class="text-sm font-semibold text-brand-dark uppercase tracking-wide mb-1">Why it matters</p>
        <p class="text-slate-800">{item.why_it_matters}</p>
      </div>
    )}

    {item.tags.length > 0 && (
      <div class="flex flex-wrap gap-1.5 mb-6">
        {item.tags.map(tag => (
          <span class="text-xs text-slate-600 bg-slate-100 px-2 py-1 rounded">{tag}</span>
        ))}
      </div>
    )}

    <div class="border-t border-slate-200 pt-6 mb-8">
      <a
        href={item.original_url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        class="inline-flex items-center gap-2 text-brand font-medium hover:underline"
      >
        Read the original at {item.source} <span aria-hidden="true">↗</span>
      </a>
    </div>

    <aside class="bg-slate-50 border border-slate-200 rounded-lg p-6 mb-12">
      <h2 class="text-lg font-semibold mb-2">Get daily trades intel by email</h2>
      <p class="text-sm text-slate-600 mb-4">One summary email per morning. Unsubscribe anytime.</p>
      <EmailCapture compact />
    </aside>

    {related.length > 0 && (
      <section>
        <h2 class="text-xl font-semibold mb-4">Related</h2>
        <div class="grid gap-4">
          {related.map(r => <FeedCard item={r} />)}
        </div>
      </section>
    )}
  </article>
</Base>
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/news/[slug].astro
git commit -m "feat: add /news/[slug] item page with related items"
```

---

## Task 20: Static pages (about, privacy, terms)

**Files:**
- Create: `src/pages/about.astro`, `src/pages/privacy.astro`, `src/pages/terms.astro`

- [ ] **Step 1: Create about.astro**

```astro
---
import Base from '@/layouts/Base.astro';
import { SITE } from '@/config/site';
---
<Base title="About" description="What Tradie Intel is, who built it, and why.">
  <article class="max-w-3xl mx-auto px-4 py-12 prose prose-slate">
    <h1>About Tradie Intel</h1>
    <p>
      Tradie Intel is a daily digest of news, regulatory updates, and industry signals
      that matter to Australian trades operators - plumbers, electricians, builders
      and contractors who don't have time to chase 20 different sources.
    </p>
    <p>
      Each morning, an automated pipeline fetches stories from industry bodies,
      regulatory authorities and trade publications, runs them through an AI summariser
      and tags the items by trade, state, and theme. The result is one place to skim
      what changed - in plain English.
    </p>
    <h2>Who's behind it</h2>
    <p>
      Tradie Intel is built and maintained by <a href={SITE.parent.url} rel="noopener">{SITE.parent.name}</a>,
      an Australian AI consultancy and product studio working with trades and allied health businesses.
    </p>
    <h2>Get in touch</h2>
    <p>
      Feedback, suggestions, or a feed source we should add - email
      <a href="mailto:hello@tradieintel.com.au">hello@tradieintel.com.au</a>.
    </p>
  </article>
</Base>
```

- [ ] **Step 2: Create privacy.astro**

```astro
---
import Base from '@/layouts/Base.astro';
---
<Base title="Privacy Policy" description="How Tradie Intel handles your data.">
  <article class="max-w-3xl mx-auto px-4 py-12 prose prose-slate">
    <h1>Privacy Policy</h1>
    <p>Last updated: 22 May 2026.</p>
    <p>
      Tradie Intel is operated by GTH Digital Marketing (trading as GrokoryAI),
      an Australian business. This policy explains what data we collect, why, and
      what we do with it.
    </p>
    <h2>What we collect</h2>
    <ul>
      <li><strong>Your email address</strong> - if you subscribe to the daily digest.</li>
      <li><strong>Standard server logs</strong> - IP, user agent, page accessed - for security and analytics. Retained 30 days.</li>
      <li><strong>Analytics</strong> - aggregated, anonymised page view counts via Vercel Analytics.</li>
    </ul>
    <h2>What we do with it</h2>
    <ul>
      <li>Email addresses are used only to send the Tradie Intel digest. We do not sell or share lists.</li>
      <li>You can unsubscribe at any time using the link in every email.</li>
    </ul>
    <h2>Your rights</h2>
    <p>
      Under the Australian Privacy Act, you can request a copy of any personal data we hold
      about you, or request its deletion. Email <a href="mailto:privacy@tradieintel.com.au">privacy@tradieintel.com.au</a>.
    </p>
  </article>
</Base>
```

- [ ] **Step 3: Create terms.astro**

```astro
---
import Base from '@/layouts/Base.astro';
---
<Base title="Terms of Use" description="Terms governing your use of Tradie Intel.">
  <article class="max-w-3xl mx-auto px-4 py-12 prose prose-slate">
    <h1>Terms of Use</h1>
    <p>Last updated: 22 May 2026.</p>
    <h2>The content</h2>
    <p>
      Tradie Intel publishes summaries of publicly available news, regulatory updates
      and industry information. Summaries are generated by AI and may contain errors.
      Always verify against the original source before acting on anything you read here.
      Nothing on this site is legal, financial, or professional advice.
    </p>
    <h2>Source attribution</h2>
    <p>
      Each item links to its original source. We aim to add reasonable value through
      summarisation and tagging without substituting for the original publisher's content.
      If you believe an item misrepresents your work or should be removed, email
      <a href="mailto:hello@tradieintel.com.au">hello@tradieintel.com.au</a>.
    </p>
    <h2>Liability</h2>
    <p>
      The site is provided "as is". GTH Digital Marketing (GrokoryAI) accepts no
      liability for decisions made based on content here.
    </p>
  </article>
</Base>
```

- [ ] **Step 4: Commit**

```bash
git add src/pages/about.astro src/pages/privacy.astro src/pages/terms.astro
git commit -m "feat: add about, privacy, terms static pages"
```

---

## Task 21: Vercel cron config + README

**Files:**
- Create: `vercel.json`, `README.md`

- [ ] **Step 1: Create vercel.json**

```json
{
  "crons": [
    {
      "path": "/api/cron/refresh-feeds",
      "schedule": "0 20 * * *"
    }
  ]
}
```

Note: `0 20 * * *` UTC = 06:00 AEST (UTC+10) the following morning. Adjust to `0 19 * * *` during AEDT (UTC+11) daylight saving if absolute consistency matters; v1 accepts the one-hour summer shift.

- [ ] **Step 2: Create README.md**

```markdown
# Tradie Intel

Daily AI-enriched trades industry news hub at https://tradieintel.com.au.

## Stack

Astro 5 (SSR) · Vercel · Supabase · Claude API · Tailwind · Vitest

## Local setup

1. `cp .env.example .env` and fill in values.
2. `npm install`
3. Set up Supabase: see `supabase/README.md`.
4. `npm run dev` - serves at http://localhost:4321
5. `npm test` - run test suite.

## Architecture

- **Daily cron** (`/api/cron/refresh-feeds`) - Vercel triggers at 06:00 AEST, fetches RSS feeds in `src/config/feeds.ts`, enriches new items via Claude (`src/lib/claude.ts`), writes to Supabase.
- **Site pages** - Astro SSR pages read from Supabase on request. SEO/GEO-friendly because content is in HTML.
- **Email capture** - POST `/api/subscribe` routes through `src/lib/email.ts` provider abstraction. Configure via `EMAIL_PROVIDER` env var.

## Manually trigger cron locally

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:4321/api/cron/refresh-feeds
```

## Deploy

Push to the connected GitHub repo. Vercel auto-builds. Configure all env vars from `.env.example` in the Vercel dashboard.

## Adding a new feed source

Edit `src/config/feeds.ts`. Set `enabled: true` and provide a valid RSS URL. Run the cron once manually to verify.

## Spec and plan

- Design spec: `docs/superpowers/specs/2026-05-22-tradie-intel-hub-design.md`
- Implementation plan: `docs/superpowers/plans/2026-05-22-tradie-intel-implementation.md`
```

- [ ] **Step 3: Commit**

```bash
git add vercel.json README.md
git commit -m "feat: add Vercel cron config and README"
```

---

## Task 22: Local smoke test

**Files:** none

- [ ] **Step 1: Verify all tests pass**

```bash
npm test
```
Expected: all tests across `tests/lib/` and `tests/api/` pass.

- [ ] **Step 2: Verify build succeeds**

```bash
npm run build
```
Expected: build completes without errors. `.vercel/output/` is created.

- [ ] **Step 3: Verify dev server serves pages**

In one terminal:
```bash
npm run dev
```

In another, check each page returns 200:
```bash
curl -sI http://localhost:4321/ | head -1
curl -sI http://localhost:4321/news | head -1
curl -sI http://localhost:4321/about | head -1
curl -sI http://localhost:4321/privacy | head -1
curl -sI http://localhost:4321/terms | head -1
```
Expected: each returns `HTTP/1.1 200 OK`. (`/news/[slug]` won't return 200 without data in the DB - expected.)

- [ ] **Step 4: Test email capture endpoint locally**

```bash
curl -X POST http://localhost:4321/api/subscribe \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com"}'
```
Expected (with `EMAIL_PROVIDER=memory` in `.env`): `{"ok":true}` and 200 status.

- [ ] **Step 5: Stop dev server, commit any final tweaks**

If everything passes, no commit needed. Otherwise fix and commit before moving on.

---

## Task 23: Deploy to Vercel

**Files:** none (Vercel handles via GitHub integration)

- [ ] **Step 1: Create GitHub repo**

Greg runs (or via gh):
```bash
gh repo create gthdigitalmarketing/tradie-intel --private --source . --remote origin --push
```

- [ ] **Step 2: Connect Vercel to repo**

Manual via Vercel dashboard:
1. New Project → Import from GitHub → select `tradie-intel`
2. Framework preset: Astro (auto-detected)
3. Add env vars from `.env.example` with real values
4. Deploy

- [ ] **Step 3: Add custom domains**

In Vercel project settings:
1. Add `tradieintel.com.au` as primary
2. Add `tradieintel.au` redirecting to primary
3. Update DNS at the registrar (VentraIP) per Vercel's instructions:
   - `A` record on apex pointing to Vercel's IP
   - `CNAME` on `www` pointing to `cname.vercel-dns.com`

- [ ] **Step 4: Verify production**

```bash
curl -sI https://tradieintel.com.au | head -5
curl -sI https://tradieintel.au | head -5
```
Expected: `tradieintel.com.au` returns 200; `tradieintel.au` returns 301 redirect to `.com.au`.

- [ ] **Step 5: Manually trigger first cron run**

In Vercel dashboard, find the cron job and trigger manually. Check logs for the JSON summary response. Expected output structure:

```json
{"feeds": 8, "fetched": <N>, "new_items": <N>, "enriched": <N>, "errors": 0}
```

If errors > 0, check Vercel function logs and `supabase/feed_items` for partial inserts. Likely causes: invalid feed URL (update `src/config/feeds.ts`), Claude API key not set, Supabase service key not set.

- [ ] **Step 6: Verify homepage shows real items**

Visit https://tradieintel.com.au - the homepage should now show the cron job's enriched items. Click an item slug to verify the item page renders.

- [ ] **Step 7: Final commit**

If any config tweaks were made (e.g. fixed a feed URL), commit and push:
```bash
git add -A
git commit -m "chore: fix feed URLs after first prod cron run"
git push
```

---

## Done

The site is live, the cron is running, and email capture is working. v1 complete.

## Post-launch checklist (out of scope for this plan)

- Submit to Google Search Console
- Submit sitemap (add `src/pages/sitemap.xml.ts` in a follow-up)
- Decide and configure final email provider (currently Kit assumed default - swap `EMAIL_PROVIDER` env var to change)
- Lock in lead magnet and update `SITE.email.ctaSubhead`
- Visual brand polish (typography, real favicon, OG image)
- Add allied health niche site (separate Vercel project, reuses Supabase via `niche='allied-health'` filter)
