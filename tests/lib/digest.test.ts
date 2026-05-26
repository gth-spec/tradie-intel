import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DigestItem } from '@/lib/digest';
import type { SupabaseClient } from '@supabase/supabase-js';

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

  it('includes date range in output', async () => {
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
