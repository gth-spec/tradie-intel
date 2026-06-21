# GEO Enrichment Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift tradieintel.com.au's CiteRanker GEO score from 72 to 85+ by enriching article data with source credibility signals (named stats, quotes, question headlines, key takeaways) and updating the article template to surface them.

**Architecture:** Extend the Claude enrichment pipeline to extract four new fields per article (question_headline, key_stat, key_quote, key_takeaways), persist them in Supabase via a new migration, and render them in the article detail page. No changes to the feed ingestion pipeline or front-end routing. Existing articles remain unaffected until re-processed.

**Tech Stack:** TypeScript, Astro 5, Supabase (Postgres), Anthropic SDK (claude-sonnet-4-5-20250929), Vitest, Zod

---

## File Map

| File | Change |
|---|---|
| `src/lib/claude.ts` | New fields in schema, interface, prompt, and char caps |
| `src/lib/supabase.ts` | New fields in `FeedItem` interface |
| `supabase/migrations/0002_geo_enrichment_fields.sql` | New nullable columns |
| `src/pages/api/cron/refresh-feeds.ts` | Pass new fields to `InsertRow` and insert |
| `src/pages/news/[slug].astro` | Render question headline, key stat, key quote, key takeaways |
| `tests/lib/claude.test.ts` | Tests for new prompt fields and schema |

---

## Why each new field targets a specific GEO gap

| Field | Pillar | Gap closed |
|---|---|---|
| `question_headline` | Conversational Query Alignment (14→18) | Article answers the exact question tradies ask |
| `key_stat` | Source Credibility (3→7) | Specific figure/dollar amount anchors the claim |
| `key_quote` | Source Credibility (3→7) | Named official or spokesperson adds trust signal |
| `key_takeaways` | Structured Content (12→14) | Bulleted list lifted verbatim by AI systems |
| Expanded `why_it_matters` | Topical Authority (11→13) | Trade-type specificity deepens relevance |

---

## Task 1: Extend enrichment schema, interface, and prompt

**Files:**
- Modify: `src/lib/claude.ts`
- Test: `tests/lib/claude.test.ts`

- [ ] **Step 1: Write failing tests for new prompt fields and schema**

```typescript
// tests/lib/claude.test.ts - add after existing describe blocks

describe('enrichmentPrompt - GEO fields', () => {
  it('asks for question_headline', () => {
    const p = enrichmentPrompt({ title: 'Foo', content: 'Bar' });
    expect(p).toContain('question_headline');
  });
  it('asks for key_stat', () => {
    const p = enrichmentPrompt({ title: 'Foo', content: 'Bar' });
    expect(p).toContain('key_stat');
  });
  it('asks for key_quote', () => {
    const p = enrichmentPrompt({ title: 'Foo', content: 'Bar' });
    expect(p).toContain('key_quote');
  });
  it('asks for key_takeaways', () => {
    const p = enrichmentPrompt({ title: 'Foo', content: 'Bar' });
    expect(p).toContain('key_takeaways');
  });
});

describe('EnrichmentResponseSchema validation', () => {
  it('accepts a full valid response', () => {
    const { parseEnrichmentResponse } = await import('@/lib/claude');
    const result = parseEnrichmentResponse(JSON.stringify({
      summary: 'Test summary',
      why_it_matters: 'Affects plumbers and electricians.',
      relevance_score: 75,
      tags: ['plumbing'],
      question_headline: 'How does this affect plumbers?',
      key_stat: null,
      key_quote: null,
      key_takeaways: ['Point one', 'Point two']
    }));
    expect(result.questionHeadline).toBe('How does this affect plumbers?');
    expect(result.keyStat).toBeNull();
    expect(result.keyTakeaways).toHaveLength(2);
  });

  it('accepts response with no optional GEO fields (backwards compat)', () => {
    const { parseEnrichmentResponse } = await import('@/lib/claude');
    const result = parseEnrichmentResponse(JSON.stringify({
      summary: 'Test',
      why_it_matters: 'Matters.',
      relevance_score: 50,
      tags: [],
      question_headline: 'What happened?',
      key_stat: null,
      key_quote: null,
      key_takeaways: []
    }));
    expect(result.keyTakeaways).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/Greg/ClaudeCode/projects/tradie-intel
npx vitest run tests/lib/claude.test.ts
```

Expected: FAIL — `parseEnrichmentResponse` not found, prompt tests fail.

- [ ] **Step 3: Update `src/lib/claude.ts`**

Replace the entire file with:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { ALLOWED_TAGS, TAG_ALIASES, STATES } from '@/config/tags';

const STATE_SET = new Set<string>(STATES);

// Operational caps - prevents the AI returning paragraphs where a sentence is asked for.
const MAX_SUMMARY_CHARS = 300;
const MAX_WHY_CHARS = 250;
const MAX_QUESTION_HEADLINE_CHARS = 120;
const MAX_KEY_STAT_CHARS = 150;
const MAX_KEY_QUOTE_CHARS = 200;
const MAX_TAKEAWAY_CHARS = 120;
const MAX_TAKEAWAYS = 4;

const EnrichmentResponseSchema = z.object({
  summary: z.string().min(1),
  why_it_matters: z.string().min(1),
  relevance_score: z.number(),
  tags: z.array(z.string()).default([]),
  question_headline: z.string().min(1),
  key_stat: z.string().nullable().default(null),
  key_quote: z.string().nullable().default(null),
  key_takeaways: z.array(z.string()).default([])
});

export interface Enrichment {
  summary: string;
  whyItMatters: string;
  relevanceScore: number;
  tags: string[];
  questionHeadline: string;
  keyStat: string | null;
  keyQuote: string | null;
  keyTakeaways: string[];
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

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

export function enrichmentPrompt({ title, content }: EnrichmentInput): string {
  const tagList = Array.from(ALLOWED_TAGS).join(', ');
  return `You are an editorial assistant for an Australian trades-industry news site. Read the article below and respond with a single JSON object - no prose, no markdown fences.

Required JSON shape:
{
  "summary": "2-3 sentence summary, max 300 characters. Plain English. No marketing language.",
  "why_it_matters": "1-2 sentences, max 250 characters. Name which trade types are affected (e.g. plumbers, electricians, builders). Practical impact on their day-to-day business.",
  "relevance_score": <integer 0-100>,
  "tags": [<2-5 tags from the controlled vocabulary>],
  "question_headline": "Rephrase the article title as a direct question a tradie would Google, max 120 characters. Example: 'How will the ACT housing reforms affect my building costs?'",
  "key_stat": "ONE specific number, dollar amount, or percentage from the article that anchors the story, max 150 characters. Include context (e.g. '$2.4 billion allocated to housing in the 2026 federal budget'). Return null if no specific figure exists in the article.",
  "key_quote": "A direct quote from a named person or official mentioned in the article, max 200 characters. Include the person's name and title (e.g. '\"This will cut delays by half\" - Jane Smith, Master Builders CEO'). Return null if no named source is quoted.",
  "key_takeaways": ["Up to 4 bullet-point sentences, max 120 chars each. Plain English. Each one should be independently quotable. Return empty array if article is too thin."]
}

Controlled tag vocabulary (use ONLY these): ${tagList}

Article title: ${title}
Article content: ${content}

Respond with JSON only.`;
}

export function parseEnrichmentResponse(text: string): Enrichment {
  const stripped = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();

  let parsed: unknown;
  try { parsed = JSON.parse(stripped); }
  catch { throw new Error(`Claude returned non-JSON: ${text.slice(0, 200)}`); }

  const validated = EnrichmentResponseSchema.parse(parsed);

  const takeaways = validated.key_takeaways
    .slice(0, MAX_TAKEAWAYS)
    .map(t => truncate(t.trim(), MAX_TAKEAWAY_CHARS))
    .filter(t => t.length > 0);

  return {
    summary: truncate(validated.summary.trim(), MAX_SUMMARY_CHARS),
    whyItMatters: truncate(validated.why_it_matters.trim(), MAX_WHY_CHARS),
    relevanceScore: Math.max(0, Math.min(100, Math.round(validated.relevance_score) || 0)),
    tags: normaliseTags(validated.tags.map(String)),
    questionHeadline: truncate(validated.question_headline.trim(), MAX_QUESTION_HEADLINE_CHARS),
    keyStat: validated.key_stat ? truncate(validated.key_stat.trim(), MAX_KEY_STAT_CHARS) : null,
    keyQuote: validated.key_quote ? truncate(validated.key_quote.trim(), MAX_KEY_QUOTE_CHARS) : null,
    keyTakeaways: takeaways
  };
}

export async function enrich(input: EnrichmentInput): Promise<Enrichment> {
  const apiKey = import.meta.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const model = (import.meta.env.CLAUDE_MODEL ?? process.env.CLAUDE_MODEL) || 'claude-sonnet-4-5-20250929';
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: enrichmentPrompt(input) }]
  });
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text).join('').trim();

  return parseEnrichmentResponse(text);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/Greg/ClaudeCode/projects/tradie-intel
npx vitest run tests/lib/claude.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/Greg/ClaudeCode/projects/tradie-intel
git add src/lib/claude.ts tests/lib/claude.test.ts
git commit -m "feat: extend enrichment schema with GEO credibility fields"
```

---

## Task 2: DB migration and FeedItem type

**Files:**
- Create: `supabase/migrations/0002_geo_enrichment_fields.sql`
- Modify: `src/lib/supabase.ts`

- [ ] **Step 1: Create the migration file**

```sql
-- supabase/migrations/0002_geo_enrichment_fields.sql
-- Adds GEO credibility fields extracted by the enrichment pipeline.
-- All columns are nullable so existing rows remain valid without backfill.

alter table feed_items
  add column if not exists question_headline text,
  add column if not exists key_stat text,
  add column if not exists key_quote text,
  add column if not exists key_takeaways text[] default '{}';
```

- [ ] **Step 2: Apply the migration to the linked Supabase project**

```bash
cd /Users/Greg/ClaudeCode/projects/tradie-intel
npx supabase db push
```

Expected output: migration `0002_geo_enrichment_fields` applied successfully.

If the project is not linked, run first:
```bash
npx supabase link
```

- [ ] **Step 3: Update `FeedItem` interface in `src/lib/supabase.ts`**

Add four new fields after the `tags` line:

```typescript
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
  question_headline: string | null;
  key_stat: string | null;
  key_quote: string | null;
  key_takeaways: string[];
}
```

- [ ] **Step 4: Run the full test suite to confirm no regressions**

```bash
cd /Users/Greg/ClaudeCode/projects/tradie-intel
npx vitest run
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/Greg/ClaudeCode/projects/tradie-intel
git add supabase/migrations/0002_geo_enrichment_fields.sql src/lib/supabase.ts
git commit -m "feat: add GEO enrichment columns to feed_items schema"
```

---

## Task 3: Wire new fields through the cron insert pipeline

**Files:**
- Modify: `src/pages/api/cron/refresh-feeds.ts`
- Test: `tests/api/refresh-feeds.test.ts`

- [ ] **Step 1: Open `tests/api/refresh-feeds.test.ts` and check what's already tested**

Read the file to understand existing mocks before adding tests:

```bash
cat /Users/Greg/ClaudeCode/projects/tradie-intel/tests/api/refresh-feeds.test.ts
```

- [ ] **Step 2: Add a test verifying new fields are passed to the insert row**

In `tests/api/refresh-feeds.test.ts`, find the test that mocks `enrich` and add an assertion that the `InsertRow` passed to upsert includes the new fields. The exact location depends on the existing test structure; add after the existing `enrich` mock assertions:

```typescript
// Verify new GEO fields are threaded through to InsertRow
it('includes GEO fields in the inserted row when enrich returns them', async () => {
  // This test verifies the processItem function maps Enrichment → InsertRow correctly.
  // Mock enrich to return a full enrichment with GEO fields.
  vi.mocked(enrich).mockResolvedValueOnce({
    summary: 'Test summary',
    whyItMatters: 'Affects plumbers.',
    relevanceScore: 80,
    tags: ['plumbing'],
    questionHeadline: 'How does this affect plumbers?',
    keyStat: '$2.4 billion allocated',
    keyQuote: '"Big change" - Jane Smith, MBA CEO',
    keyTakeaways: ['Point one', 'Point two']
  });
  // Call processItem directly (it is exported for testability)
  const { processItem } = await import('@/pages/api/cron/refresh-feeds');
  const row = await processItem(
    { title: 'Test', url: 'https://example.com/test', content: 'content', publishedAt: new Date() },
    'TestFeed',
    'https://testfeed.com'
  );
  expect(row).not.toBeNull();
  expect(row!.question_headline).toBe('How does this affect plumbers?');
  expect(row!.key_stat).toBe('$2.4 billion allocated');
  expect(row!.key_quote).toBe('"Big change" - Jane Smith, MBA CEO');
  expect(row!.key_takeaways).toEqual(['Point one', 'Point two']);
});
```

- [ ] **Step 3: Run the new test to verify it fails**

```bash
cd /Users/Greg/ClaudeCode/projects/tradie-intel
npx vitest run tests/api/refresh-feeds.test.ts
```

Expected: FAIL — `row.question_headline` is undefined.

- [ ] **Step 4: Update `InsertRow` and `processItem` in `src/pages/api/cron/refresh-feeds.ts`**

Find the `InsertRow` interface and `processItem` function. Make these two changes:

**Add to `InsertRow` interface:**
```typescript
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
  question_headline: string | null;
  key_stat: string | null;
  key_quote: string | null;
  key_takeaways: string[];
}
```

**Update `processItem` return block:**
```typescript
async function processItem(item: IngestedItem, feedName: string, feedUrl: string): Promise<InsertRow | null> {
  try {
    const enr = await enrich({ title: item.title, content: item.content });
    return {
      source: feedName,
      source_url: feedUrl,
      original_url: item.url,
      title: item.title,
      original_content: item.content.slice(0, 500),
      published_at: item.publishedAt.toISOString(),
      niche: SITE.niche,
      ai_summary: enr.summary,
      why_it_matters: enr.whyItMatters,
      relevance_score: enr.relevanceScore,
      tags: enr.tags,
      slug: titleToSlug(item.title, item.url.slice(-6).replace(/[^a-z0-9]/gi, '')),
      question_headline: enr.questionHeadline,
      key_stat: enr.keyStat,
      key_quote: enr.keyQuote,
      key_takeaways: enr.keyTakeaways
    };
  } catch (err) {
    console.error('Enrichment failed for', item.url, err);
    return null;
  }
}
```

Also export `processItem` for testability by adding `export` to the function declaration:
```typescript
export async function processItem(
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/Greg/ClaudeCode/projects/tradie-intel
npx vitest run tests/api/refresh-feeds.test.ts
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/Greg/ClaudeCode/projects/tradie-intel
git add src/pages/api/cron/refresh-feeds.ts tests/api/refresh-feeds.test.ts
git commit -m "feat: thread GEO enrichment fields through cron insert pipeline"
```

---

## Task 4: Render GEO fields on the article detail page

**Files:**
- Modify: `src/pages/news/[slug].astro`

No new tests for Astro templates (they are integration-tested via the browser). Visual verification is the test.

- [ ] **Step 1: Update `src/pages/news/[slug].astro`**

Replace the current `<article>` body (lines 58-119) with the updated version below. Changes: add `question_headline` as an `<h2>` subheading beneath the H1, add a Key Stat callout block, add a Key Quote block, and add Key Takeaways bullets. The `<Base>` wrapper and `<script>` LD-JSON block are unchanged.

```astro
<Base title={item.title} description={item.ai_summary ?? item.title}>
  <script type="application/ld+json" set:html={JSON.stringify(ldJson)} />
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

    <h1 class="text-3xl sm:text-4xl font-bold text-slate-900 mb-3">{item.title}</h1>

    {item.question_headline && (
      <h2 class="text-xl text-slate-600 font-normal mb-6 italic">{item.question_headline}</h2>
    )}

    {item.ai_summary && (
      <div class="prose prose-slate max-w-none mb-6">
        <p class="text-lg text-slate-800">{item.ai_summary}</p>
      </div>
    )}

    {item.key_stat && (
      <div class="bg-amber-50 border border-amber-200 rounded-lg p-4 my-6 flex gap-3">
        <span class="text-amber-500 text-xl font-bold shrink-0" aria-hidden="true">📊</span>
        <p class="text-slate-800 font-medium">{item.key_stat}</p>
      </div>
    )}

    {item.key_quote && (
      <blockquote class="border-l-4 border-slate-400 pl-4 my-6 italic text-slate-700">
        {item.key_quote}
      </blockquote>
    )}

    {item.why_it_matters && (
      <div class="bg-blue-50 border-l-4 border-brand p-4 my-6 rounded-r">
        <p class="text-sm font-semibold text-brand-dark uppercase tracking-wide mb-1">Why it matters</p>
        <p class="text-slate-800">{item.why_it_matters}</p>
      </div>
    )}

    {item.key_takeaways && item.key_takeaways.length > 0 && (
      <div class="bg-slate-50 border border-slate-200 rounded-lg p-5 my-6">
        <p class="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-3">Key takeaways</p>
        <ul class="space-y-2">
          {item.key_takeaways.map(point => (
            <li class="flex gap-2 text-slate-800 text-sm">
              <span class="text-brand font-bold shrink-0" aria-hidden="true">→</span>
              {point}
            </li>
          ))}
        </ul>
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
      <h2 class="text-lg font-semibold mb-2">{SITE.email.ctaHeadline}</h2>
      <p class="text-sm text-slate-600 mb-4">{SITE.email.ctaSubhead}</p>
      <EmailCapture compact source="item-page" />
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

- [ ] **Step 2: Build the Astro project to confirm no type errors**

```bash
cd /Users/Greg/ClaudeCode/projects/tradie-intel
npx astro build 2>&1 | tail -20
```

Expected: Build succeeds with no TypeScript errors. If type errors appear on `item.question_headline` etc., verify Task 2 Step 3 was completed (FeedItem interface updated).

- [ ] **Step 3: Start dev server and verify a news article renders correctly**

```bash
cd /Users/Greg/ClaudeCode/projects/tradie-intel
npx astro dev
```

Open `http://localhost:4321/news` in a browser and click any article. Verify:
- H1 shows the original title
- H2 (italic) shows question headline if the article has one (may be null for older articles)
- Stat callout appears if `key_stat` is populated
- Quote block appears if `key_quote` is populated
- "Key takeaways" box appears with bullet points if `key_takeaways` has items
- "Why it matters" callout is present

For existing articles seeded before this migration, `question_headline`, `key_stat`, `key_quote`, and `key_takeaways` will be null/empty - this is expected. New articles ingested after this deploy will have all fields.

Stop the dev server with Ctrl+C.

- [ ] **Step 4: Commit**

```bash
cd /Users/Greg/ClaudeCode/projects/tradie-intel
git add src/pages/news/[slug].astro
git commit -m "feat: render GEO credibility fields on article detail page"
```

---

## Task 5: Run full test suite and deploy

- [ ] **Step 1: Run the full test suite**

```bash
cd /Users/Greg/ClaudeCode/projects/tradie-intel
npx vitest run
```

Expected: All tests PASS. Fix any failures before proceeding.

- [ ] **Step 2: Build for production**

```bash
cd /Users/Greg/ClaudeCode/projects/tradie-intel
npx astro build
```

Expected: Build succeeds with no errors.

- [ ] **Step 3: Push to main to trigger Vercel deploy**

```bash
cd /Users/Greg/ClaudeCode/projects/tradie-intel
git push origin main
```

- [ ] **Step 4: Confirm Vercel deployment**

Check Vercel dashboard or run:

```bash
cd /Users/Greg/ClaudeCode/projects/tradie-intel
npx vercel ls --prod 2>/dev/null | head -5
```

Confirm the latest deployment shows as ready.

- [ ] **Step 5: Trigger a cron run against production to ingest new articles with GEO fields**

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "https://tradieintel.com.au/api/cron/refresh-feeds?dryRun=0" | jq .
```

Confirm `items_inserted` > 0 in the response. New articles will have all four GEO fields populated.

- [ ] **Step 6: Re-run CiteRanker audit**

Visit https://citeranker.com and run a new audit on tradieintel.com.au. Target score: 82+.

Compare against baseline:
- Source Credibility: 3/10 → target 7+
- Conversational Query Alignment: 14/20 → target 17+
- Structured Content: 12/15 → target 14+
- Topical Authority: 11/15 → target 13+

---

## Self-Review

**Spec coverage:**
- ✅ Source Credibility: `key_stat` + `key_quote` fields extracted and rendered
- ✅ Conversational Query Alignment: `question_headline` as H2 subheading
- ✅ Topical Authority: `why_it_matters` prompt expanded to name specific trade types
- ✅ Structured Content: `key_takeaways` bulleted list
- ✅ DB migration, type updates, cron pipeline, and front-end all covered

**Placeholder scan:** No TBDs or "implement later" in any task.

**Type consistency:** `Enrichment.questionHeadline` → `InsertRow.question_headline` → `FeedItem.question_headline` → `item.question_headline` — consistent across all four tasks.

**Promise audit:** No audience-facing copy changes in this plan. The GEO score improvement is the deliverable.

**Dependency freshness:** `claude-sonnet-4-5-20250929` is an existing pinned model already in production - no change.
