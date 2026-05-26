import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DigestItem } from '@/lib/digest';
import type { SupabaseClient } from '@supabase/supabase-js';

// ── Article selection ────────────────────────────────────────────────────────

function makeItem(overrides: Partial<DigestItem> = {}): DigestItem {
  return {
    id: 'uuid-1',
    title: 'Test Article',
    ai_summary: 'A test summary.',
    why_it_matters: 'Matters to plumbers.',
    original_url: 'https://example.com/article',
    source: 'Test Source',
    published_at: new Date().toISOString(),
    relevance_score: 80,
    ...overrides
  };
}

describe('selectArticles', () => {
  it('returns top 5 articles when 5+ qualify in 7 days', async () => {
    vi.resetModules();
    const { selectArticles } = await import('@/lib/digest');
    const items = Array.from({ length: 8 }, (_, i) => makeItem({ id: `uuid-${i}`, relevance_score: 90 - i }));

    const mockChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: items, error: null }),
      in: vi.fn().mockReturnThis()
    };

    const supa = {
      from: vi.fn().mockReturnValue(mockChain)
    } as unknown as SupabaseClient;
    const result = await selectArticles({ supabase: supa });
    expect(result.articles).toHaveLength(5);
    expect(result.lookbackDays).toBe(7);
  });

  it('falls back to 14-day lookback when fewer than 3 qualify in 7 days', async () => {
    vi.resetModules();
    const { selectArticles } = await import('@/lib/digest');
    let callCount = 0;

    const mockChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation(() => {
        callCount++;
        const rows = callCount === 1
          ? [makeItem()]
          : Array.from({ length: 5 }, (_, i) => makeItem({ id: `uuid-${i}` }));
        return Promise.resolve({ data: rows, error: null });
      }),
      in: vi.fn().mockReturnThis()
    };

    const supa = {
      from: vi.fn().mockReturnValue(mockChain)
    } as unknown as SupabaseClient;
    const result = await selectArticles({ supabase: supa });
    expect(result.lookbackDays).toBe(14);
    expect(result.articles).toHaveLength(5);
  });

  it('returns empty array when fewer than 3 qualify even in 14-day lookback', async () => {
    vi.resetModules();
    const { selectArticles } = await import('@/lib/digest');
    const items = [makeItem(), makeItem({ id: 'uuid-2' })];

    const mockChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: items, error: null }),
      in: vi.fn().mockReturnThis()
    };

    const supa = {
      from: vi.fn().mockReturnValue(mockChain)
    } as unknown as SupabaseClient;
    const result = await selectArticles({ supabase: supa });
    expect(result.articles).toHaveLength(0);
  });

  it('skips excludeIds when array is empty', async () => {
    vi.resetModules();
    const { selectArticles } = await import('@/lib/digest');
    const items = Array.from({ length: 5 }, (_, i) => makeItem({ id: `uuid-${i}` }));

    const mockChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: items, error: null }),
      in: vi.fn().mockReturnThis()
    };

    const supa = {
      from: vi.fn().mockReturnValue(mockChain)
    } as unknown as SupabaseClient;
    await selectArticles({ supabase: supa, excludeIds: [] });
    // The .not method for 'id' filter should not be called when excludeIds is empty
    const notCalls = mockChain.not.mock.calls;
    const idExclusionCall = notCalls.find((c: unknown[]) => c[0] === 'id');
    expect(idExclusionCall).toBeFalsy();
  });
});

describe('hasRecentDigestRun', () => {
  it('returns true when a recent draft/approved/sent run exists', async () => {
    vi.resetModules();
    const { hasRecentDigestRun } = await import('@/lib/digest');

    const mockChain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [{ id: 'some-run-id' }], error: null })
    };

    const supa = {
      from: vi.fn().mockReturnValue(mockChain)
    } as unknown as SupabaseClient;
    expect(await hasRecentDigestRun(supa)).toBe(true);
  });

  it('returns false when no recent run exists', async () => {
    vi.resetModules();
    const { hasRecentDigestRun } = await import('@/lib/digest');

    const mockChain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null })
    };

    const supa = {
      from: vi.fn().mockReturnValue(mockChain)
    } as unknown as SupabaseClient;
    expect(await hasRecentDigestRun(supa)).toBe(false);
  });
});

// ── LMX email builder ────────────────────────────────────────────────────────

describe('buildEmailLmx', () => {
  it('produces valid LMX with Style, H1, and article blocks', async () => {
    vi.resetModules();
    const { buildEmailLmx } = await import('@/lib/digest');
    const articles = [
      makeItem({ title: 'Plumbing code update', ai_summary: 'Summary.', why_it_matters: 'Affects plumbers.' })
    ];
    const lmx = buildEmailLmx(articles, { start: new Date('2026-05-19'), end: new Date('2026-05-25') });
    expect(lmx).toContain('<Style />');
    expect(lmx).toContain('<H1>This week in trades</H1>');
    expect(lmx).toContain('<H2><Link href="https://example.com/article">Plumbing code update</Link></H2>');
    expect(lmx).toContain('19 May');
    expect(lmx).toContain('25 May');
  });

  it('escapes special characters in titles', async () => {
    vi.resetModules();
    const { buildEmailLmx } = await import('@/lib/digest');
    const articles = [makeItem({ title: 'A & B <script>', ai_summary: 'Body' })];
    const lmx = buildEmailLmx(articles, { start: new Date(), end: new Date() });
    expect(lmx).not.toContain('<script>');
    expect(lmx).toContain('A &amp; B &lt;script&gt;');
  });

  it('escapes ampersands in URLs', async () => {
    vi.resetModules();
    const { buildEmailLmx } = await import('@/lib/digest');
    const articles = [makeItem({ original_url: 'https://example.com/x?a=1&b=2' })];
    const lmx = buildEmailLmx(articles, { start: new Date(), end: new Date() });
    expect(lmx).toContain('https://example.com/x?a=1&amp;b=2');
  });

  it('includes one Divider per article plus separator dividers', async () => {
    vi.resetModules();
    const { buildEmailLmx } = await import('@/lib/digest');
    const articles = [makeItem(), makeItem({ id: 'uuid-2' })];
    const lmx = buildEmailLmx(articles, { start: new Date(), end: new Date() });
    const dividerCount = (lmx.match(/<Divider \/>/g) ?? []).length;
    // 1 divider before articles + 1 divider per article = 3
    expect(dividerCount).toBe(3);
  });
});

// ── Loops API client (new flow) ──────────────────────────────────────────────

describe('createLoopsDraftCampaign', () => {
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

  it('returns ids from Loops API response', async () => {
    const { createLoopsDraftCampaign } = await import('@/lib/digest');
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        campaignId: 'cmp-1',
        emailMessageId: 'em-1',
        emailMessageContentRevisionId: 'rev-1'
      }), { status: 201 })
    );
    const result = await createLoopsDraftCampaign('loops-key', 'Test Campaign');
    expect(result).toEqual({ campaignId: 'cmp-1', emailMessageId: 'em-1', contentRevisionId: 'rev-1' });
  });

  it('throws when response missing IDs', async () => {
    const { createLoopsDraftCampaign } = await import('@/lib/digest');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ campaignId: 'cmp-1' }), { status: 201 }));
    await expect(createLoopsDraftCampaign('loops-key', 'Test')).rejects.toThrow('missing IDs');
  });

  it('throws on non-2xx response', async () => {
    const { createLoopsDraftCampaign } = await import('@/lib/digest');
    fetchMock.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    await expect(createLoopsDraftCampaign('bad-key', 'Test')).rejects.toThrow('Loops campaign create error: 401');
  });
});

describe('updateLoopsEmailMessage', () => {
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

  it('POSTs to the email-messages endpoint with expectedRevisionId, subject, previewText, lmx', async () => {
    const { updateLoopsEmailMessage } = await import('@/lib/digest');
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await updateLoopsEmailMessage('loops-key', {
      emailMessageId: 'em-1',
      expectedRevisionId: 'rev-1',
      subject: 'Subject',
      previewText: 'Preview',
      lmx: '<Style />\n<H1>Title</H1>'
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://app.loops.so/api/v1/email-messages/em-1');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      expectedRevisionId: 'rev-1',
      subject: 'Subject',
      previewText: 'Preview',
      lmx: '<Style />\n<H1>Title</H1>'
    });
  });

  it('throws on non-2xx response', async () => {
    const { updateLoopsEmailMessage } = await import('@/lib/digest');
    fetchMock.mockResolvedValueOnce(new Response('Conflict', { status: 409 }));
    await expect(updateLoopsEmailMessage('loops-key', {
      emailMessageId: 'em-1', expectedRevisionId: 'rev-1', subject: 'x', previewText: 'x', lmx: '<Style />'
    })).rejects.toThrow('Loops email message update error: 409');
  });
});

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
      subject: '[REVIEW] Test digest',
      html: '<p>test</p>',
      approveUrl: 'https://app.loops.so/campaigns/cmp-test'
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
    const updateEq = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn().mockReturnValue({ eq: updateEq });
    const supa = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        lt: vi.fn().mockResolvedValue({
          data: [{ id: 'stale-run-1', broadcast_id: 'camp-1' }],
          error: null
        }),
        update: updateMock
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
