# Digest Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a weekly digest email pipeline that selects top articles from Supabase, creates a Loops broadcast draft, emails a preview to an AgentMail QA inbox for human approval, and schedules the broadcast on approval.

**Architecture:** A Vercel cron job (`/api/cron/send-digest`, Tuesday 07:00 AEST) selects the top 5 articles by relevance score, assembles inline-styled HTML, creates a Loops broadcast draft, then sends a preview + signed approve link to `tradieintel-qa@agentmail.to`. Greg clicks the approve link in his email, the `/api/digest/approve` endpoint validates the JWT, schedules the broadcast (now + 15 min), and returns an HTML confirmation page. All state is tracked in a `digest_runs` Supabase table.

**Tech Stack:** Astro SSR, Supabase (Postgres), Loops broadcast API, AgentMail API, `node:crypto` for HMAC token signing (no new deps), Vitest for tests.

**Spec:** `docs/superpowers/specs/2026-05-26-digest-builder-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `supabase/migrations/0003_digest_runs.sql` | Create | `digest_runs` table DDL + RLS |
| `src/lib/digest.ts` | Create | All digest logic: types, article selection, HTML builder, JWT, Loops API, AgentMail API, cleanup |
| `src/pages/api/cron/send-digest.ts` | Create | Cron handler - orchestrates the full digest pipeline |
| `src/pages/api/digest/approve.ts` | Create | Approve endpoint - JWT validation, Loops schedule, HTML confirmation |
| `src/env.d.ts` | Modify | Add `AGENTMAIL_API_KEY` |
| `.env.example` | Modify | Document `AGENTMAIL_API_KEY` |
| `vercel.json` | Modify | Add `send-digest` cron entry |
| `tests/lib/digest.test.ts` | Create | Unit tests for all `digest.ts` exports |
| `tests/pages/api/digest/approve.test.ts` | Create | Tests for approval endpoint |

**Note on `send-digest.ts` tests:** The cron handler imports from `digest.ts` and follows the same auth + dry-run pattern as `refresh-feeds.ts`. Unit tests for the handler's exported helper functions live in `tests/lib/digest.test.ts`. Integration-style tests for the handler itself are covered by the dry-run smoke test in Task 10.

---

## Task 1: Supabase Migration

**Files:**
- Create: `supabase/migrations/0003_digest_runs.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- Tracks each digest run: draft → approved → sent lifecycle.
-- RLS: service role (admin) writes only; no public read.

create table digest_runs (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  status       text not null check (status in ('draft', 'approved', 'sent', 'skipped', 'expired')),
  broadcast_id text,
  article_ids  uuid[] not null default '{}',
  approved_at  timestamptz,
  sent_at      timestamptz,
  metadata     jsonb
);

alter table digest_runs enable row level security;

-- No public read policy - this table is internal only.
-- The service role key used by the cron and approve endpoint bypasses RLS.

create index digest_runs_status_created_idx on digest_runs (status, created_at desc);
```

- [ ] **Step 2: Apply the migration to remote Supabase**

From the project root:
```bash
cd /Users/Greg/ClaudeCode/projects/tradie-intel
supabase db push
```

Expected output: `Applying migration 0003_digest_runs.sql...` with no errors.

If `supabase db push` fails with auth error, use the Supabase dashboard SQL Editor as a fallback: paste the migration SQL and run it there.

- [ ] **Step 3: Verify the table exists**

```bash
supabase db diff
```

Expected: no pending migrations listed (meaning 0003 is applied).

---

## Task 2: Env Config

**Files:**
- Modify: `src/env.d.ts`
- Modify: `.env.example`
- Modify: `vercel.json`

- [ ] **Step 1: Add `AGENTMAIL_API_KEY` to `src/env.d.ts`**

Add one line to the `ImportMetaEnv` interface, after the existing `APIFY_TOKEN` line:

```typescript
  readonly AGENTMAIL_API_KEY: string;
```

Full interface after edit:
```typescript
interface ImportMetaEnv {
  readonly SUPABASE_URL: string;
  readonly SUPABASE_SECRET_KEY: string;
  readonly SUPABASE_PUBLISHABLE_KEY: string;
  readonly ANTHROPIC_API_KEY: string;
  readonly CRON_SECRET: string;
  readonly EMAIL_PROVIDER: 'kit' | 'loops' | 'mailchimp' | 'memory';
  readonly EMAIL_PROVIDER_API_KEY: string;
  readonly EMAIL_LIST_ID: string;
  readonly CLAUDE_MODEL: string;
  readonly FIRECRAWL_API_KEY: string;
  readonly APIFY_TOKEN: string;
  readonly AGENTMAIL_API_KEY: string;
}
interface ImportMeta { readonly env: ImportMetaEnv; }
```

- [ ] **Step 2: Add `AGENTMAIL_API_KEY` to `.env.example`**

Append to the end of `.env.example`:

```
# AgentMail - QA inbox for digest approval flow.
# API key is in ~/.zshrc as AGENTMAIL_API_KEY. Add to Vercel env vars before first live run.
AGENTMAIL_API_KEY=
```

- [ ] **Step 3: Add `send-digest` cron to `vercel.json`**

Replace the full file content:

```json
{
  "crons": [
    {
      "path": "/api/cron/refresh-feeds",
      "schedule": "0 20 * * *"
    },
    {
      "path": "/api/cron/send-digest",
      "schedule": "0 21 * * 1"
    }
  ]
}
```

`0 21 * * 1` = UTC 21:00 on Monday = AEST 07:00 Tuesday. The 1-hour gap after `refresh-feeds` (UTC 20:00 daily) ensures Tuesday's content is ingested before article selection runs.

- [ ] **Step 4: Verify TypeScript still compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0003_digest_runs.sql src/env.d.ts .env.example vercel.json
git commit -m "feat: add digest_runs migration and env config for digest builder"
```

---

## Task 3: Token Utilities

**Files:**
- Create: `src/lib/digest.ts` (initial scaffold + token functions)
- Create: `tests/lib/digest.test.ts` (initial token tests)

These HMAC-SHA256 tokens use `node:crypto` - no new dependencies. Format: `base64url(payload_json).base64url(hmac_signature)`.

- [ ] **Step 1: Write failing tests for `signApproveToken` and `verifyApproveToken`**

Create `tests/lib/digest.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Token utilities ──────────────────────────────────────────────────────────

describe('signApproveToken / verifyApproveToken', () => {
  const SECRET = 'test-secret-32-chars-minimum-abc';
  const RUN_ID = '550e8400-e29b-41d4-a716-446655440000';
  const BROADCAST_ID = 'loops-broadcast-abc123';

  it('round-trips: sign then verify returns original payload', async () => {
    const { signApproveToken, verifyApproveToken } = await import('@/lib/digest');
    const token = signApproveToken(RUN_ID, BROADCAST_ID, SECRET);
    const payload = verifyApproveToken(token, SECRET);
    expect(payload.run_id).toBe(RUN_ID);
    expect(payload.broadcast_id).toBe(BROADCAST_ID);
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('throws on tampered payload', async () => {
    const { signApproveToken, verifyApproveToken } = await import('@/lib/digest');
    const token = signApproveToken(RUN_ID, BROADCAST_ID, SECRET);
    const [payload, sig] = token.split('.');
    const tampered = `${payload}x.${sig}`;
    expect(() => verifyApproveToken(tampered, SECRET)).toThrow('Invalid token signature');
  });

  it('throws on wrong secret', async () => {
    const { signApproveToken, verifyApproveToken } = await import('@/lib/digest');
    const token = signApproveToken(RUN_ID, BROADCAST_ID, SECRET);
    expect(() => verifyApproveToken(token, 'wrong-secret')).toThrow('Invalid token signature');
  });

  it('throws on expired token', async () => {
    const { signApproveToken, verifyApproveToken } = await import('@/lib/digest');
    vi.useFakeTimers();
    const token = signApproveToken(RUN_ID, BROADCAST_ID, SECRET);
    // Advance time by 8 days to expire the 7-day token
    vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000);
    expect(() => verifyApproveToken(token, SECRET)).toThrow('Token expired');
    vi.useRealTimers();
  });

  it('throws on malformed token (missing dot separator)', async () => {
    const { verifyApproveToken } = await import('@/lib/digest');
    expect(() => verifyApproveToken('nodothere', SECRET)).toThrow('Invalid token format');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/Greg/ClaudeCode/projects/tradie-intel
npx vitest run tests/lib/digest.test.ts
```

Expected: `FAIL` - `Cannot find module '@/lib/digest'`

- [ ] **Step 3: Create `src/lib/digest.ts` with token utilities**

```typescript
import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DigestItem {
  id: string;
  title: string;
  ai_summary: string;
  why_it_matters: string;
  original_url: string;
  source: string;
  published_at: string;
  relevance_score: number;
}

export interface DigestRun {
  id: string;
  created_at: string;
  status: 'draft' | 'approved' | 'sent' | 'skipped' | 'expired';
  broadcast_id: string | null;
  article_ids: string[];
  approved_at: string | null;
  sent_at: string | null;
  metadata: Record<string, unknown> | null;
}

export interface ApproveTokenPayload {
  run_id: string;
  broadcast_id: string;
  exp: number;
}

export interface SelectArticlesResult {
  articles: DigestItem[];
  lookbackDays: number;
}

export interface DateRange {
  start: Date;
  end: Date;
}

// ── Token utilities ───────────────────────────────────────────────────────────

export function signApproveToken(runId: string, broadcastId: string, secret: string): string {
  const payload: ApproveTokenPayload = {
    run_id: runId,
    broadcast_id: broadcastId,
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

export function verifyApproveToken(token: string, secret: string): ApproveTokenPayload {
  const dotIdx = token.indexOf('.');
  if (dotIdx === -1) throw new Error('Invalid token format');
  const payloadB64 = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const expected = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  if (sig !== expected) throw new Error('Invalid token signature');
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as ApproveTokenPayload;
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');
  return payload;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run tests/lib/digest.test.ts
```

Expected: `5 tests passed` in the token describe block.

- [ ] **Step 5: Commit**

```bash
git add src/lib/digest.ts tests/lib/digest.test.ts
git commit -m "feat: add digest.ts scaffold with HMAC token utilities"
```

---

## Task 4: Article Selection

**Files:**
- Modify: `src/lib/digest.ts` (add `selectArticles`, `getLastDigestArticleIds`, `hasRecentDigestRun`)
- Modify: `tests/lib/digest.test.ts` (add article selection tests)

- [ ] **Step 1: Add article selection tests to `tests/lib/digest.test.ts`**

Append to the file:

```typescript
// ── Article selection ────────────────────────────────────────────────────────

function makeItem(overrides: Partial<DigestItem> = {}): DigestItem {
  return {
    id: overrides.id ?? 'uuid-1',
    title: overrides.title ?? 'Test Article',
    ai_summary: overrides.ai_summary ?? 'A test summary.',
    why_it_matters: overrides.why_it_matters ?? 'Matters to plumbers.',
    original_url: overrides.original_url ?? 'https://example.com/article',
    source: overrides.source ?? 'Test Source',
    published_at: overrides.published_at ?? new Date().toISOString(),
    relevance_score: overrides.relevance_score ?? 80,
    ...overrides
  };
}

function makeSupabaseMock(rows: DigestItem[]) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: rows, error: null }),
      in: vi.fn().mockReturnThis()
    })
  } as unknown as SupabaseClient;
}

describe('selectArticles', () => {
  it('returns top 5 articles when 5+ qualify in 7 days', async () => {
    vi.resetModules();
    const { selectArticles } = await import('@/lib/digest');
    const items = Array.from({ length: 8 }, (_, i) => makeItem({ id: `uuid-${i}`, relevance_score: 90 - i }));
    const supa = makeSupabaseMock(items);
    const result = await selectArticles({ supabase: supa });
    expect(result.articles).toHaveLength(5);
    expect(result.lookbackDays).toBe(7);
  });

  it('falls back to 14-day lookback when fewer than 3 qualify in 7 days', async () => {
    vi.resetModules();
    const { selectArticles } = await import('@/lib/digest');
    let callCount = 0;
    const supa = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        not: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockImplementation(() => {
          callCount++;
          // First call (7-day): return 1 item. Second call (14-day): return 5 items.
          const rows = callCount === 1
            ? [makeItem()]
            : Array.from({ length: 5 }, (_, i) => makeItem({ id: `uuid-${i}` }));
          return Promise.resolve({ data: rows, error: null });
        }),
        in: vi.fn().mockReturnThis()
      })
    } as unknown as SupabaseClient;
    const result = await selectArticles({ supabase: supa });
    expect(result.lookbackDays).toBe(14);
    expect(result.articles).toHaveLength(5);
  });

  it('returns empty array when fewer than 3 qualify even in 14-day lookback', async () => {
    vi.resetModules();
    const { selectArticles } = await import('@/lib/digest');
    const supa = makeSupabaseMock([makeItem(), makeItem({ id: 'uuid-2' })]);
    const result = await selectArticles({ supabase: supa });
    expect(result.articles).toHaveLength(0);
  });

  it('passes excludeIds to query', async () => {
    vi.resetModules();
    const { selectArticles } = await import('@/lib/digest');
    const notMock = vi.fn().mockReturnThis();
    const supa = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        not: notMock,
        gte: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({
          data: Array.from({ length: 5 }, (_, i) => makeItem({ id: `uuid-${i}` })),
          error: null
        }),
        in: vi.fn().mockReturnThis()
      })
    } as unknown as SupabaseClient;
    await selectArticles({ supabase: supa, excludeIds: ['uuid-excluded'] });
    // Should call .not('id', 'in', ...) for exclusion
    const notCalls = notMock.mock.calls;
    const idExclusionCall = notCalls.find(c => c[0] === 'id');
    expect(idExclusionCall).toBeTruthy();
  });
});

describe('hasRecentDigestRun', () => {
  it('returns true when a recent draft/approved/sent run exists', async () => {
    vi.resetModules();
    const { hasRecentDigestRun } = await import('@/lib/digest');
    const supa = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [{ id: 'some-run-id' }], error: null })
      })
    } as unknown as SupabaseClient;
    expect(await hasRecentDigestRun(supa)).toBe(true);
  });

  it('returns false when no recent run exists', async () => {
    vi.resetModules();
    const { hasRecentDigestRun } = await import('@/lib/digest');
    const supa = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [], error: null })
      })
    } as unknown as SupabaseClient;
    expect(await hasRecentDigestRun(supa)).toBe(false);
  });
});
```

Add the `DigestItem` import at the top of the test file (these types are exported from `digest.ts`):

```typescript
import type { DigestItem } from '@/lib/digest';
import type { SupabaseClient } from '@supabase/supabase-js';
```

- [ ] **Step 2: Run tests to confirm new tests fail**

```bash
npx vitest run tests/lib/digest.test.ts
```

Expected: new `selectArticles` and `hasRecentDigestRun` tests fail with `is not a function`.

- [ ] **Step 3: Add article selection functions to `src/lib/digest.ts`**

Append to the end of the file:

```typescript
// ── Article selection ─────────────────────────────────────────────────────────

export async function getLastDigestArticleIds(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase
    .from('digest_runs')
    .select('article_ids')
    .in('status', ['approved', 'sent'])
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data?.[0]?.article_ids ?? []) as string[];
}

export async function hasRecentDigestRun(supabase: SupabaseClient): Promise<boolean> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('digest_runs')
    .select('id')
    .in('status', ['draft', 'approved', 'sent'])
    .gte('created_at', cutoff)
    .limit(1);
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function selectArticles(opts: {
  supabase: SupabaseClient;
  niche?: string;
  excludeIds?: string[];
}): Promise<SelectArticlesResult> {
  const { supabase, niche = 'trades', excludeIds = [] } = opts;

  for (const days of [7, 14]) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    let query = supabase
      .from('feed_items')
      .select('id, title, ai_summary, why_it_matters, original_url, source, published_at, relevance_score')
      .eq('niche', niche)
      .not('relevance_score', 'is', null)
      .not('ai_summary', 'is', null)
      .gte('published_at', cutoff)
      .order('relevance_score', { ascending: false })
      .limit(20);

    if (excludeIds.length > 0) {
      query = query.not('id', 'in', `(${excludeIds.join(',')})`);
    }

    const { data, error } = await query;
    if (error) throw error;

    const items = (data ?? []) as DigestItem[];
    if (items.length >= 3) {
      return { articles: items.slice(0, 5), lookbackDays: days };
    }
  }

  return { articles: [], lookbackDays: 14 };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run tests/lib/digest.test.ts
```

Expected: all tests pass (token tests + article selection tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/digest.ts tests/lib/digest.test.ts
git commit -m "feat: add article selection functions to digest.ts"
```

---

## Task 5: Email HTML Builder

**Files:**
- Modify: `src/lib/digest.ts` (add `buildEmailHtml`, `getDateRange`, helper functions)
- Modify: `tests/lib/digest.test.ts` (add HTML builder tests)

- [ ] **Step 1: Add HTML builder tests to `tests/lib/digest.test.ts`**

Append to the file:

```typescript
// ── Email HTML builder ───────────────────────────────────────────────────────

describe('buildEmailHtml', () => {
  it('includes all article titles in output', async () => {
    vi.resetModules();
    const { buildEmailHtml } = await import('@/lib/digest');
    const articles = [
      makeItem({ title: 'Plumbing code update 2026', ai_summary: 'Summary one.', why_it_matters: 'Affects all plumbers.' }),
      makeItem({ id: 'uuid-2', title: 'HVAC regulations change', ai_summary: 'Summary two.', why_it_matters: 'Affects HVAC operators.' })
    ];
    const dateRange = { start: new Date('2026-05-19'), end: new Date('2026-05-25') };
    const html = buildEmailHtml(articles, dateRange);
    expect(html).toContain('Plumbing code update 2026');
    expect(html).toContain('HVAC regulations change');
  });

  it('includes date range in subject line area', async () => {
    vi.resetModules();
    const { buildEmailHtml } = await import('@/lib/digest');
    const html = buildEmailHtml(
      [makeItem()],
      { start: new Date('2026-05-19'), end: new Date('2026-05-25') }
    );
    expect(html).toContain('19 May');
    expect(html).toContain('25 May');
  });

  it('escapes HTML special characters in article content', async () => {
    vi.resetModules();
    const { buildEmailHtml } = await import('@/lib/digest');
    const article = makeItem({ title: 'Test <script>alert(1)</script>', ai_summary: 'Safe & clean.' });
    const html = buildEmailHtml([article], { start: new Date(), end: new Date() });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Safe &amp; clean.');
  });

  it('includes preview text as hidden div', async () => {
    vi.resetModules();
    const { buildEmailHtml } = await import('@/lib/digest');
    const article = makeItem({ ai_summary: 'This is the first article summary for preview.' });
    const html = buildEmailHtml([article], { start: new Date(), end: new Date() });
    expect(html).toContain('This is the first article summary for preview.');
    // Preview text should be inside a hidden div
    expect(html).toMatch(/display:none[^>]*>This is the first/);
  });

  it('includes unsubscribe placeholder', async () => {
    vi.resetModules();
    const { buildEmailHtml } = await import('@/lib/digest');
    const html = buildEmailHtml([makeItem()], { start: new Date(), end: new Date() });
    expect(html).toContain('{{unsubscribe_link}}');
  });
});

describe('getDateRange', () => {
  it('returns a 7-day window ending at the time of call', async () => {
    vi.resetModules();
    const { getDateRange } = await import('@/lib/digest');
    const range = getDateRange();
    const diffMs = range.end.getTime() - range.start.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeCloseTo(7, 0);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/lib/digest.test.ts
```

Expected: `buildEmailHtml` and `getDateRange` tests fail with `is not a function`.

- [ ] **Step 3: Add HTML builder functions to `src/lib/digest.ts`**

Append to the end of the file:

```typescript
// ── Email HTML builder ────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatShortDate(d: Date): string {
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

export function getDateRange(): DateRange {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { start, end };
}

export function buildEmailHtml(articles: DigestItem[], dateRange: DateRange): string {
  const startLabel = formatShortDate(dateRange.start);
  const endLabel = formatShortDate(dateRange.end);
  const rangeLabel = `${startLabel} - ${endLabel}`;
  const previewText = articles[0]
    ? articles[0].ai_summary.slice(0, 140)
    : 'Your weekly trades industry intelligence.';

  const articlesHtml = articles.map(a => `
      <tr>
        <td style="padding:24px 0;border-bottom:1px solid #e5e7eb;">
          <h2 style="margin:0 0 8px;font-size:18px;font-weight:600;line-height:1.3;">
            <a href="${escapeHtml(a.original_url)}" style="color:#0f766e;text-decoration:none;">${escapeHtml(a.title)}</a>
          </h2>
          <p style="margin:0 0 8px;font-size:15px;color:#374151;line-height:1.6;">${escapeHtml(a.ai_summary)}</p>
          <p style="margin:0 0 12px;font-size:13px;color:#6b7280;font-style:italic;">${escapeHtml(a.why_it_matters)}</p>
          <span style="font-size:12px;color:#9ca3af;">${escapeHtml(a.source)}</span>
          <a href="${escapeHtml(a.original_url)}" style="margin-left:12px;font-size:13px;color:#0f766e;">Read more →</a>
        </td>
      </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>This week in trades: ${escapeHtml(rangeLabel)}</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#f9fafb;">${escapeHtml(previewText)}</div>
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f9fafb;">
  <tr><td align="center" style="padding:32px 16px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;">
      <tr>
        <td style="background:#0f766e;padding:24px 32px;">
          <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.5px;">TradieIntel</h1>
          <p style="margin:6px 0 0;color:#99f6e4;font-size:13px;">Weekly Intel - ${escapeHtml(rangeLabel)}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:24px 32px 0;">
          <p style="margin:0;font-size:15px;color:#374151;line-height:1.6;">Here's what's worth knowing in the trades sector this week.</p>
        </td>
      </tr>
      <tr>
        <td style="padding:0 32px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            ${articlesHtml}
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:32px;background:#f9fafb;text-align:center;border-top:1px solid #e5e7eb;">
          <p style="margin:0 0 6px;font-size:12px;color:#9ca3af;">You're receiving this because you subscribed at tradieintel.com.au</p>
          <p style="margin:0;font-size:12px;color:#9ca3af;">© GrokoryAI - <a href="{{unsubscribe_link}}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe</a></p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}
```

- [ ] **Step 4: Run all digest tests**

```bash
npx vitest run tests/lib/digest.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/digest.ts tests/lib/digest.test.ts
git commit -m "feat: add email HTML builder and date range helper to digest.ts"
```

---

## Task 6: Loops API Client

**Files:**
- Modify: `src/lib/digest.ts` (add `createLoopsBroadcast`, `scheduleLoopsBroadcast`)
- Modify: `tests/lib/digest.test.ts` (add Loops API tests)

**Before writing any code:** Open `https://loops.so/docs/api-reference` and verify:
1. The endpoint for creating a campaign/broadcast (`POST /api/v1/campaigns` or equivalent)
2. The endpoint for scheduling/sending a campaign
3. The exact field names in the request body (especially `htmlBody`, `preheaderText`)
4. What field name the response uses for the campaign ID (`id`, `campaignId`, or other)

Update the implementation below if the actual endpoints or field names differ from what's shown.

- [ ] **Step 1: Add Loops API tests to `tests/lib/digest.test.ts`**

Append to the file:

```typescript
// ── Loops API client ─────────────────────────────────────────────────────────

describe('createLoopsBroadcast', () => {
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.resetModules();
  });

  it('returns campaign id from Loops API response', async () => {
    const { createLoopsBroadcast } = await import('@/lib/digest');
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'campaign-xyz' }), { status: 200 })
    );
    const id = await createLoopsBroadcast('loops-api-key', {
      name: 'Weekly Digest - 2026-05-26',
      subject: 'This week in trades: 19-25 May',
      preheaderText: 'Top 5 articles for your week.',
      htmlBody: '<html>test</html>'
    });
    expect(id).toBe('campaign-xyz');
  });

  it('sends correct Authorization header', async () => {
    const { createLoopsBroadcast } = await import('@/lib/digest');
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'campaign-abc' }), { status: 200 })
    );
    await createLoopsBroadcast('my-loops-key', {
      name: 'Test', subject: 'Test', preheaderText: 'Test', htmlBody: '<p>test</p>'
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer my-loops-key');
  });

  it('throws on non-200 response', async () => {
    const { createLoopsBroadcast } = await import('@/lib/digest');
    fetchMock.mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 })
    );
    await expect(createLoopsBroadcast('bad-key', {
      name: 'Test', subject: 'Test', preheaderText: 'Test', htmlBody: '<p>test</p>'
    })).rejects.toThrow('Loops campaign create error: 401');
  });
});

describe('scheduleLoopsBroadcast', () => {
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.resetModules();
  });

  it('calls the correct campaign endpoint with sendAt', async () => {
    const { scheduleLoopsBroadcast } = await import('@/lib/digest');
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await scheduleLoopsBroadcast('loops-api-key', 'campaign-123');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('campaign-123');
    const body = JSON.parse(init.body as string) as { sendAt: string };
    expect(body.sendAt).toBeTruthy();
    // sendAt should be ~15 minutes in the future
    const sendAt = new Date(body.sendAt).getTime();
    expect(sendAt).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
    expect(sendAt).toBeLessThan(Date.now() + 16 * 60 * 1000);
  });

  it('throws on non-200 response', async () => {
    const { scheduleLoopsBroadcast } = await import('@/lib/digest');
    fetchMock.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    await expect(scheduleLoopsBroadcast('loops-api-key', 'bad-id')).rejects.toThrow('Loops campaign schedule error: 404');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/lib/digest.test.ts
```

Expected: Loops tests fail with `is not a function`.

- [ ] **Step 3: Add Loops API functions to `src/lib/digest.ts`**

Append to the end of the file:

```typescript
// ── Loops API client ──────────────────────────────────────────────────────────
// Endpoints: https://loops.so/docs/api-reference
// Verify endpoint paths match current Loops API docs before deploying.

export async function createLoopsBroadcast(apiKey: string, opts: {
  name: string;
  subject: string;
  preheaderText: string;
  htmlBody: string;
}): Promise<string> {
  const res = await fetch('https://app.loops.so/api/v1/campaigns', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      name: opts.name,
      subject: opts.subject,
      preheaderText: opts.preheaderText,
      htmlBody: opts.htmlBody,
      type: 'html'
    })
  });
  if (!res.ok) throw new Error(`Loops campaign create error: ${res.status} ${await res.text()}`);
  const data = await res.json() as { id?: string; campaignId?: string };
  const id = data.id ?? data.campaignId;
  if (!id) throw new Error('Loops campaign create: no id in response');
  return id;
}

export async function scheduleLoopsBroadcast(apiKey: string, campaignId: string): Promise<void> {
  const sendAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const res = await fetch(`https://app.loops.so/api/v1/campaigns/${campaignId}/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ sendAt })
  });
  if (!res.ok) throw new Error(`Loops campaign schedule error: ${res.status} ${await res.text()}`);
}
```

- [ ] **Step 4: Run all digest tests**

```bash
npx vitest run tests/lib/digest.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/digest.ts tests/lib/digest.test.ts
git commit -m "feat: add Loops broadcast API client to digest.ts"
```

---

## Task 7: AgentMail Send + Stale Draft Cleanup

**Files:**
- Modify: `src/lib/digest.ts` (add `sendQaEmail`, `buildQaEmailHtml`, `cleanupStaleDrafts`)
- Modify: `tests/lib/digest.test.ts` (add AgentMail + cleanup tests)

The QA email is sent FROM `tradieintel-qa@agentmail.to` TO `gth@gthdigitalmarketing.com.au`. Greg reads it in his normal inbox.

**Before writing code:** Check AgentMail API docs at `https://agentmail.to/docs` and verify the endpoint for sending a message from an inbox. The implementation below assumes `POST /v0/inboxes/{username}/messages`. Update if different.

- [ ] **Step 1: Add AgentMail and cleanup tests to `tests/lib/digest.test.ts`**

Append to the file:

```typescript
// ── AgentMail QA send ────────────────────────────────────────────────────────

describe('sendQaEmail', () => {
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.resetModules();
  });

  it('sends to the approver email with correct Authorization header', async () => {
    const { sendQaEmail } = await import('@/lib/digest');
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await sendQaEmail('agentmail-key', {
      subject: '[APPROVE REQUIRED] Test digest',
      html: '<p>test</p>',
      approveUrl: 'https://tradieintel.com.au/api/digest/approve?token=abc'
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer agentmail-key');
    const body = JSON.parse(init.body as string) as { to: string[] };
    expect(body.to).toContain('gth@gthdigitalmarketing.com.au');
  });

  it('throws on non-200 response', async () => {
    const { sendQaEmail } = await import('@/lib/digest');
    fetchMock.mockResolvedValueOnce(new Response('Bad Request', { status: 400 }));
    await expect(sendQaEmail('bad-key', {
      subject: 'Test', html: '<p>test</p>', approveUrl: 'https://example.com'
    })).rejects.toThrow('AgentMail send error: 400');
  });
});

describe('cleanupStaleDrafts', () => {
  it('marks old draft runs as expired', async () => {
    vi.resetModules();
    const { cleanupStaleDrafts } = await import('@/lib/digest');
    const updateMock = vi.fn().mockReturnThis();
    const eqMock = vi.fn().mockResolvedValue({ error: null });
    const supa = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        lt: vi.fn().mockResolvedValue({
          data: [{ id: 'stale-run-1', broadcast_id: 'camp-1' }],
          error: null
        }),
        update: updateMock.mockReturnValue({ eq: eqMock })
      })
    } as unknown as SupabaseClient;
    await cleanupStaleDrafts(supa);
    expect(updateMock).toHaveBeenCalledWith({ status: 'expired' });
  });

  it('does nothing when no stale drafts exist', async () => {
    vi.resetModules();
    const { cleanupStaleDrafts } = await import('@/lib/digest');
    const updateMock = vi.fn();
    const supa = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        lt: vi.fn().mockResolvedValue({ data: [], error: null }),
        update: updateMock
      })
    } as unknown as SupabaseClient;
    await cleanupStaleDrafts(supa);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/lib/digest.test.ts
```

Expected: `sendQaEmail` and `cleanupStaleDrafts` tests fail.

- [ ] **Step 3: Add AgentMail and cleanup functions to `src/lib/digest.ts`**

Append to the end of the file:

```typescript
// ── AgentMail QA send ─────────────────────────────────────────────────────────
// API docs: https://agentmail.to/docs
// Sends FROM tradieintel-qa@agentmail.to TO the approver's inbox.

const DIGEST_APPROVER_EMAIL = 'gth@gthdigitalmarketing.com.au';
const QA_INBOX = 'tradieintel-qa';

export function buildQaEmailHtml(opts: {
  articles: DigestItem[];
  dateRange: DateRange;
  approveUrl: string;
  runId: string;
}): string {
  const startLabel = formatShortDate(opts.dateRange.start);
  const endLabel = formatShortDate(opts.dateRange.end);
  const articleList = opts.articles
    .map((a, i) => `<li style="margin-bottom:8px;"><strong>${i + 1}. ${escapeHtml(a.title)}</strong> - ${escapeHtml(a.source)} (score: ${a.relevance_score})</li>`)
    .join('');

  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 20px;color:#111;">
  <h2 style="color:#0f766e;">TradieIntel digest ready for approval</h2>
  <p><strong>Period:</strong> ${escapeHtml(startLabel)} - ${escapeHtml(endLabel)}</p>
  <p><strong>Articles selected (${opts.articles.length}):</strong></p>
  <ol>${articleList}</ol>
  <p style="margin-top:32px;">
    <a href="${escapeHtml(opts.approveUrl)}"
       style="background:#0f766e;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">
      Approve and schedule digest
    </a>
  </p>
  <p style="margin-top:24px;font-size:12px;color:#9ca3af;">This link expires in 7 days. Run ID: ${escapeHtml(opts.runId)}</p>
</body>
</html>`;
}

export async function sendQaEmail(apiKey: string, opts: {
  subject: string;
  html: string;
  approveUrl: string;
}): Promise<void> {
  const res = await fetch(`https://api.agentmail.to/v0/inboxes/${QA_INBOX}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      to: [DIGEST_APPROVER_EMAIL],
      subject: opts.subject,
      html: opts.html
    })
  });
  if (!res.ok) throw new Error(`AgentMail send error: ${res.status} ${await res.text()}`);
}

// ── Stale draft cleanup ───────────────────────────────────────────────────────

export async function cleanupStaleDrafts(supabase: SupabaseClient): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('digest_runs')
    .select('id, broadcast_id')
    .eq('status', 'draft')
    .lt('created_at', cutoff);
  if (error) throw error;
  if (!data || data.length === 0) return;

  for (const run of data as { id: string; broadcast_id: string | null }[]) {
    await supabase
      .from('digest_runs')
      .update({ status: 'expired' })
      .eq('id', run.id);
  }
}
```

- [ ] **Step 4: Run all digest tests**

```bash
npx vitest run tests/lib/digest.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/digest.ts tests/lib/digest.test.ts
git commit -m "feat: add AgentMail QA send and stale draft cleanup to digest.ts"
```

---

## Task 8: Cron Handler

**Files:**
- Create: `src/pages/api/cron/send-digest.ts`

This handler follows the same auth + dry-run pattern as `refresh-feeds.ts`. The `authoriseCron` function is already exported from `refresh-feeds.ts` - import it rather than duplicating.

- [ ] **Step 1: Create `src/pages/api/cron/send-digest.ts`**

```typescript
import type { APIRoute } from 'astro';
import { authoriseCron } from '@/pages/api/cron/refresh-feeds';
import { adminClient } from '@/lib/supabase';
import {
  cleanupStaleDrafts,
  hasRecentDigestRun,
  getLastDigestArticleIds,
  selectArticles,
  getDateRange,
  buildEmailHtml,
  buildQaEmailHtml,
  createLoopsBroadcast,
  sendQaEmail,
  signApproveToken
} from '@/lib/digest';

export const prerender = false;

const SITE_URL = 'https://tradieintel.com.au';

export const GET: APIRoute = async ({ request, url }) => {
  const secret = (import.meta.env.CRON_SECRET ?? process.env.CRON_SECRET ?? '') as string;
  if (!authoriseCron(request, secret)) {
    return new Response('Unauthorised', { status: 401 });
  }

  const dryRun = url.searchParams.get('dryRun') === '1';
  const supa = adminClient();
  const loopsApiKey = (import.meta.env.EMAIL_PROVIDER_API_KEY ?? process.env.EMAIL_PROVIDER_API_KEY ?? '') as string;
  const agentmailKey = (import.meta.env.AGENTMAIL_API_KEY ?? process.env.AGENTMAIL_API_KEY ?? '') as string;

  const summary: Record<string, unknown> = {
    started_at: new Date().toISOString(),
    dry_run: dryRun
  };

  // 1. Clean up stale drafts from previous runs
  await cleanupStaleDrafts(supa);

  // 2. Duplicate guard - abort if a digest was already sent/approved/drafted this week
  const alreadyRan = await hasRecentDigestRun(supa);
  if (alreadyRan) {
    summary.skipped = true;
    summary.skip_reason = 'recent_digest_exists';
    return new Response(JSON.stringify(summary), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  // 3. Select articles, excluding those from the last digest
  const excludeIds = await getLastDigestArticleIds(supa);
  const dateRange = getDateRange();
  const { articles, lookbackDays } = await selectArticles({ supabase: supa, excludeIds });

  summary.articles_selected = articles.length;
  summary.lookback_days = lookbackDays;

  // 4. Abort if not enough articles
  if (articles.length < 3) {
    const skipMeta = { article_count: articles.length, lookback_days: lookbackDays, dry_run: dryRun };

    if (!dryRun) {
      await supa.from('digest_runs').insert({
        status: 'skipped',
        article_ids: [],
        metadata: { ...skipMeta, skip_reason: 'insufficient_articles' }
      });

      // Notify approver of the skip
      const agentmailKey2 = (import.meta.env.AGENTMAIL_API_KEY ?? process.env.AGENTMAIL_API_KEY ?? '') as string;
      if (agentmailKey2) {
        try {
          await sendQaEmail(agentmailKey2, {
            subject: `[SKIPPED] TradieIntel digest - only ${articles.length} article(s) qualified`,
            html: `<p>The digest was skipped this week. Only ${articles.length} article(s) qualified (minimum is 3). Lookback was ${lookbackDays} days.</p>`,
            approveUrl: ''
          });
        } catch (e) {
          console.warn('Failed to send skip notification:', e);
        }
      }
    }

    summary.skipped = true;
    summary.skip_reason = 'insufficient_articles';
    return new Response(JSON.stringify(summary), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  // 5. Build the email HTML
  const emailHtml = buildEmailHtml(articles, dateRange);
  const startLabel = dateRange.start.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  const endLabel = dateRange.end.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  const subject = `This week in trades: ${startLabel} - ${endLabel}`;
  const preheaderText = articles[0].ai_summary.slice(0, 140);

  summary.subject = subject;
  summary.articles = articles.map(a => ({ id: a.id, title: a.title, score: a.relevance_score }));

  if (dryRun) {
    summary.dry_run_html_length = emailHtml.length;
    return new Response(JSON.stringify(summary), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  // 6. Create Loops broadcast draft
  const campaignName = `Weekly Digest - ${new Date().toISOString().slice(0, 10)}`;
  const broadcastId = await createLoopsBroadcast(loopsApiKey, {
    name: campaignName,
    subject,
    preheaderText,
    htmlBody: emailHtml
  });

  summary.broadcast_id = broadcastId;

  // 7. Insert digest_runs row as 'draft'
  const { data: runData, error: runError } = await supa
    .from('digest_runs')
    .insert({
      status: 'draft',
      broadcast_id: broadcastId,
      article_ids: articles.map(a => a.id),
      metadata: {
        subject,
        article_count: articles.length,
        lookback_days: lookbackDays,
        campaign_name: campaignName
      }
    })
    .select('id')
    .single();

  if (runError || !runData) {
    throw new Error(`Failed to insert digest_runs row: ${runError?.message}`);
  }

  const runId = runData.id as string;
  summary.run_id = runId;

  // 8. Sign approve token and send QA email
  const approveToken = signApproveToken(runId, broadcastId, secret);
  const approveUrl = `${SITE_URL}/api/digest/approve?token=${encodeURIComponent(approveToken)}`;

  const qaHtml = buildQaEmailHtml({ articles, dateRange, approveUrl, runId });

  try {
    await sendQaEmail(agentmailKey, {
      subject: `[APPROVE REQUIRED] TradieIntel digest - ${startLabel} - ${endLabel}`,
      html: qaHtml,
      approveUrl
    });
    summary.qa_email_sent = true;
  } catch (e) {
    console.warn('AgentMail QA send failed (broadcast still created):', e);
    summary.qa_email_sent = false;
    summary.qa_email_error = e instanceof Error ? e.message : String(e);
  }

  return new Response(JSON.stringify(summary), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
};
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Run all tests**

```bash
npm test
```

Expected: all 58 existing tests still pass. New digest tests pass. No regressions.

- [ ] **Step 4: Commit**

```bash
git add src/pages/api/cron/send-digest.ts
git commit -m "feat: add send-digest cron handler"
```

---

## Task 9: Approve Endpoint

**Files:**
- Create: `src/pages/api/digest/approve.ts`
- Create: `tests/pages/api/digest/approve.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/pages/api/digest/approve.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signApproveToken } from '@/lib/digest';

const SECRET = 'test-secret-at-least-32-chars-abc';

// Mock Supabase adminClient
vi.mock('@/lib/supabase', () => ({
  adminClient: vi.fn()
}));

// Mock digest functions
vi.mock('@/lib/digest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/digest')>();
  return {
    ...actual,
    scheduleLoopsBroadcast: vi.fn().mockResolvedValue(undefined)
  };
});

function makeRequest(token: string): Request {
  return new Request(`https://tradieintel.com.au/api/digest/approve?token=${encodeURIComponent(token)}`, {
    method: 'GET'
  });
}

function makeSupaWithRun(status: string) {
  const updateEq = vi.fn().mockResolvedValue({ error: null });
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: 'run-id-1', status, broadcast_id: 'campaign-123' },
        error: null
      }),
      update: vi.fn().mockReturnValue({ eq: updateEq })
    })
  };
}

describe('GET /api/digest/approve', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('EMAIL_PROVIDER_API_KEY', 'loops-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('returns 200 HTML confirmation page on valid token + draft run', async () => {
    const { adminClient } = await import('@/lib/supabase');
    (adminClient as ReturnType<typeof vi.fn>).mockReturnValue(makeSupaWithRun('draft'));

    const { GET } = await import('@/pages/api/digest/approve');
    const token = signApproveToken('run-id-1', 'campaign-123', SECRET);
    const res = await GET({ request: makeRequest(token), url: new URL(`https://example.com?token=${token}`) } as Parameters<typeof GET>[0]);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Digest approved');
    expect(res.headers.get('Content-Type')).toContain('text/html');
  });

  it('returns 400 HTML error page when token is expired', async () => {
    vi.useFakeTimers();
    const token = signApproveToken('run-id-1', 'campaign-123', SECRET);
    vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000);

    const { GET } = await import('@/pages/api/digest/approve');
    const res = await GET({ request: makeRequest(token), url: new URL(`https://example.com?token=${token}`) } as Parameters<typeof GET>[0]);

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain('expired');
    vi.useRealTimers();
  });

  it('returns 409 HTML error page when run is already approved', async () => {
    const { adminClient } = await import('@/lib/supabase');
    (adminClient as ReturnType<typeof vi.fn>).mockReturnValue(makeSupaWithRun('approved'));

    const { GET } = await import('@/pages/api/digest/approve');
    const token = signApproveToken('run-id-1', 'campaign-123', SECRET);
    const res = await GET({ request: makeRequest(token), url: new URL(`https://example.com?token=${token}`) } as Parameters<typeof GET>[0]);

    expect(res.status).toBe(409);
  });

  it('returns 400 when token is missing', async () => {
    const { GET } = await import('@/pages/api/digest/approve');
    const req = new Request('https://tradieintel.com.au/api/digest/approve', { method: 'GET' });
    const res = await GET({ request: req, url: new URL('https://example.com') } as Parameters<typeof GET>[0]);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/pages/api/digest/approve.test.ts
```

Expected: `FAIL` - `Cannot find module '@/pages/api/digest/approve'`

- [ ] **Step 3: Create `src/pages/api/digest/approve.ts`**

```typescript
import type { APIRoute } from 'astro';
import { adminClient } from '@/lib/supabase';
import { verifyApproveToken, scheduleLoopsBroadcast } from '@/lib/digest';

export const prerender = false;

function htmlPage(title: string, heading: string, message: string, isError = false): Response {
  const color = isError ? '#dc2626' : '#0f766e';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${title} - TradieIntel</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:480px;margin:80px auto;padding:40px;background:#fff;border-radius:12px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="width:56px;height:56px;border-radius:50%;background:${color}1a;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;">
      <span style="font-size:24px;">${isError ? '⚠️' : '✓'}</span>
    </div>
    <h1 style="margin:0 0 12px;font-size:22px;color:#111;">${heading}</h1>
    <p style="margin:0;font-size:15px;color:#6b7280;line-height:1.6;">${message}</p>
  </div>
</body>
</html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

export const GET: APIRoute = async ({ url }) => {
  const token = url.searchParams.get('token');
  if (!token) {
    return new Response(
      htmlPage('Error', 'Invalid link', 'This approval link is missing its token. Please check your email for the correct link.', true).body,
      { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  const secret = (import.meta.env.CRON_SECRET ?? process.env.CRON_SECRET ?? '') as string;
  const loopsApiKey = (import.meta.env.EMAIL_PROVIDER_API_KEY ?? process.env.EMAIL_PROVIDER_API_KEY ?? '') as string;

  let payload: ReturnType<typeof verifyApproveToken>;
  try {
    payload = verifyApproveToken(token, secret);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    const isExpired = msg.includes('expired');
    return new Response(
      htmlPage(
        'Link expired',
        isExpired ? 'This approval link has expired' : 'Invalid approval link',
        isExpired
          ? 'This digest run has been marked as expired. If you need to send a digest, trigger a new cron run.'
          : 'This link is not valid. Please check your email for the correct link.'
      , true).body,
      { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  const supa = adminClient();

  // Check current run status
  const { data: run, error: runError } = await supa
    .from('digest_runs')
    .select('id, status, broadcast_id')
    .eq('id', payload.run_id)
    .single();

  if (runError || !run) {
    return new Response(
      htmlPage('Error', 'Run not found', 'This digest run could not be found. It may have been cleaned up.', true).body,
      { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  const typedRun = run as { id: string; status: string; broadcast_id: string | null };

  if (typedRun.status !== 'draft') {
    const alreadyDone = typedRun.status === 'approved' || typedRun.status === 'sent';
    return new Response(
      htmlPage(
        alreadyDone ? 'Already approved' : 'Cannot approve',
        alreadyDone ? 'Digest already approved' : 'This digest cannot be approved',
        alreadyDone
          ? 'This digest has already been approved and is scheduled to send.'
          : `The digest run status is '${typedRun.status}' and cannot be approved.`
      , !alreadyDone).body,
      { status: 409, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  // Schedule the broadcast
  await scheduleLoopsBroadcast(loopsApiKey, payload.broadcast_id);

  // Update run status to approved
  await supa
    .from('digest_runs')
    .update({ status: 'approved', approved_at: new Date().toISOString() })
    .eq('id', payload.run_id);

  return new Response(
    htmlPage(
      'Digest approved',
      'Digest approved',
      'The digest has been approved and is scheduled to send to subscribers in approximately 15 minutes.'
    ).body,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
};
```

- [ ] **Step 4: Run approve endpoint tests**

```bash
npx vitest run tests/pages/api/digest/approve.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: all tests pass (58 original + all new digest tests).

- [ ] **Step 6: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/pages/api/digest/approve.ts tests/pages/api/digest/approve.test.ts
git commit -m "feat: add digest approve endpoint with JWT validation and HTML confirmation"
```

---

## Task 10: Dry-Run Smoke Test

Before the first live cron run, verify the full pipeline end-to-end in dry-run mode against the deployed site.

- [ ] **Step 1: Add `AGENTMAIL_API_KEY` to Vercel env vars**

In the Vercel dashboard for `tradie-intel`:
1. Go to Project Settings → Environment Variables
2. Add `AGENTMAIL_API_KEY` with the value from `~/.zshrc`
3. Also confirm `EMAIL_PROVIDER=loops` and `EMAIL_PROVIDER_API_KEY` is set to the Loops API key

- [ ] **Step 2: Deploy to Vercel**

Push the current branch to trigger a deploy:

```bash
git push
```

Wait for the Vercel build to complete (watch at vercel.com/dashboard or run `vercel logs` if CLI is configured).

- [ ] **Step 3: Trigger dry-run on deployed site**

```bash
CRON_SECRET=$(grep CRON_SECRET /Users/Greg/ClaudeCode/projects/tradie-intel/.env | cut -d= -f2)
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  'https://tradieintel.com.au/api/cron/send-digest?dryRun=1' | jq .
```

Expected JSON response (when articles exist in Supabase):
```json
{
  "started_at": "2026-05-26T...",
  "dry_run": true,
  "articles_selected": 5,
  "lookback_days": 7,
  "subject": "This week in trades: ...",
  "articles": [...],
  "dry_run_html_length": 4500
}
```

If `articles_selected` is 0, the `feed_items` table may be empty. Trigger the refresh-feeds cron first:
```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  'https://tradieintel.com.au/api/cron/refresh-feeds' | jq '.items_inserted'
```

Then re-run the digest dry-run.

- [ ] **Step 4: Verify approve endpoint rejects a bad token**

```bash
curl -s -o /dev/null -w "%{http_code}" \
  'https://tradieintel.com.au/api/digest/approve?token=invalid'
```

Expected: `400`

- [ ] **Step 5: Check Loops API endpoint compatibility**

If the dry-run passed but you haven't yet made a live Loops API call, test the campaign creation against the real Loops API:

```bash
LOOPS_KEY=$(grep EMAIL_PROVIDER_API_KEY /Users/Greg/ClaudeCode/projects/tradie-intel/.env | cut -d= -f2)
curl -s -X POST https://app.loops.so/api/v1/campaigns \
  -H "Authorization: Bearer $LOOPS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Campaign","subject":"Test","preheaderText":"Test","htmlBody":"<p>test</p>","type":"html"}' \
  | jq .
```

If the endpoint returns a 404 or the field names differ from what the test mocks assume, update `createLoopsBroadcast` and `scheduleLoopsBroadcast` in `src/lib/digest.ts` to match the real API, then update the test mocks accordingly. Loops API docs: `https://loops.so/docs/api-reference`.

- [ ] **Step 6: Final full test run**

```bash
npm test && npx tsc --noEmit
```

Expected: all tests pass, TypeScript clean.

- [ ] **Step 7: Final commit if any Loops adjustments were needed**

```bash
git add -p
git commit -m "fix: align Loops API client with actual endpoint structure"
```

---

## Post-build checklist

- [ ] `AGENTMAIL_API_KEY` is in Vercel env vars
- [ ] `EMAIL_PROVIDER=loops` in Vercel env vars
- [ ] `EMAIL_PROVIDER_API_KEY` is the Loops API key in Vercel env vars
- [ ] Dry-run confirmed articles are selected from live Supabase data
- [ ] Loops API endpoint verified with a real test call
- [ ] First live Tuesday run is ready to go (cron fires automatically at UTC 21:00 Monday)
