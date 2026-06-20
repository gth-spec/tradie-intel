import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DigestItem } from '@/lib/digest';
import type { SupabaseClient } from '@supabase/supabase-js';

// ── Token utilities ──────────────────────────────────────────────────────────

describe('signApproveToken / verifyApproveToken', () => {
  const SECRET = 'test-secret-32-chars-minimum-abc';
  const RUN_ID = '550e8400-e29b-41d4-a716-446655440000';
  const BROADCAST_ID = 'bc-abc123';

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

// ── Resend API client ────────────────────────────────────────────────────────

describe('createResendBroadcast', () => {
  beforeEach(() => { vi.spyOn(global, 'fetch'); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('POSTs to /broadcasts with segment_id, from, subject, html, name and returns id', async () => {
    const { createResendBroadcast } = await import('@/lib/digest');
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'bc-123' }), { status: 200 })
    );
    const id = await createResendBroadcast('re_key', {
      segmentId: 'seg-1',
      from: 'TradieIntel <hello@tradieintel.com.au>',
      subject: 'Weekly digest',
      html: '<p>hi</p>',
      name: 'Weekly Digest - 2026-05-27'
    });
    expect(id).toBe('bc-123');
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.resend.com/broadcasts');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer re_key');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      segment_id: 'seg-1',
      from: 'TradieIntel <hello@tradieintel.com.au>',
      subject: 'Weekly digest',
      html: '<p>hi</p>',
      name: 'Weekly Digest - 2026-05-27'
    });
  });

  it('throws when Resend returns a non-2xx', async () => {
    const { createResendBroadcast } = await import('@/lib/digest');
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('bad domain', { status: 422 })
    );
    await expect(createResendBroadcast('re_key', {
      segmentId: 's', from: 'a@b.com', subject: 's', html: '<p/>', name: 'n'
    })).rejects.toThrow('Resend broadcast create error: 422');
  });

  it('throws when response is missing id', async () => {
    const { createResendBroadcast } = await import('@/lib/digest');
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 })
    );
    await expect(createResendBroadcast('re_key', {
      segmentId: 's', from: 'a@b.com', subject: 's', html: '<p/>', name: 'n'
    })).rejects.toThrow('missing id');
  });
});

describe('sendResendBroadcast', () => {
  beforeEach(() => { vi.spyOn(global, 'fetch'); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('POSTs to /broadcasts/{id}/send with empty body when no scheduledAt', async () => {
    const { sendResendBroadcast } = await import('@/lib/digest');
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'bc-123' }), { status: 200 })
    );
    await sendResendBroadcast('re_key', 'bc-123');
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.resend.com/broadcasts/bc-123/send');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({});
  });

  it('passes scheduled_at when provided', async () => {
    const { sendResendBroadcast } = await import('@/lib/digest');
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'bc-123' }), { status: 200 })
    );
    await sendResendBroadcast('re_key', 'bc-123', 'in 5 minutes');
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(JSON.parse(init.body)).toEqual({ scheduled_at: 'in 5 minutes' });
  });

  it('throws when Resend returns a non-2xx', async () => {
    const { sendResendBroadcast } = await import('@/lib/digest');
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('not found', { status: 404 })
    );
    await expect(sendResendBroadcast('re_key', 'missing'))
      .rejects.toThrow('Resend broadcast send error: 404');
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

  it('POSTs /v0/inboxes/{full-inbox-id}/messages/send with Authorization and to[]', async () => {
    const { sendQaEmail } = await import('@/lib/digest');
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await sendQaEmail('agentmail-key', {
      subject: '[REVIEW] Test digest',
      html: '<p>test</p>'
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.agentmail.to/v0/inboxes/tradieintel-qa@agentmail.to/messages/send');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer agentmail-key');
    const body = JSON.parse(init.body as string) as { to: string[]; subject: string; html: string };
    expect(body.to).toContain('hello@tradieintel.com.au');
    expect(body.subject).toBe('[REVIEW] Test digest');
    expect(body.html).toBe('<p>test</p>');
  });

  it('throws on non-200 response', async () => {
    const { sendQaEmail } = await import('@/lib/digest');
    fetchMock.mockResolvedValueOnce(new Response('Bad Request', { status: 400 }));
    await expect(sendQaEmail('bad-key', {
      subject: 'Test', html: '<p>test</p>'
    })).rejects.toThrow('AgentMail send error: 400');
  });
});

describe('deleteResendBroadcast', () => {
  beforeEach(() => { vi.spyOn(global, 'fetch'); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('DELETEs /broadcasts/{id} with Bearer auth and no body', async () => {
    const { deleteResendBroadcast } = await import('@/lib/digest');
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ object: 'broadcast', id: 'bc-1', deleted: true }), { status: 200 })
    );
    await deleteResendBroadcast('re_key', 'bc-1');
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.resend.com/broadcasts/bc-1');
    expect(init.method).toBe('DELETE');
    expect(init.headers['Authorization']).toBe('Bearer re_key');
    expect(init.body).toBeUndefined();
  });

  it('tolerates 404 silently (already deleted)', async () => {
    const { deleteResendBroadcast } = await import('@/lib/digest');
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('not found', { status: 404 })
    );
    await expect(deleteResendBroadcast('re_key', 'gone')).resolves.toBeUndefined();
  });

  it('throws on other non-2xx (e.g. 500)', async () => {
    const { deleteResendBroadcast } = await import('@/lib/digest');
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('server error', { status: 500 })
    );
    await expect(deleteResendBroadcast('re_key', 'bc-1'))
      .rejects.toThrow('Resend broadcast delete error: 500');
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

  it('expires multiple stale draft rows without any HTTP call (NitroSend has no campaign DELETE)', async () => {
    vi.resetModules();
    const fetchSpy = vi.spyOn(global, 'fetch');
    const { cleanupStaleDrafts } = await import('@/lib/digest');
    const updateEq = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn().mockReturnValue({ eq: updateEq });
    const supa = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        lt: vi.fn().mockResolvedValue({
          data: [
            { id: 'r-1', broadcast_id: 'bc-1' },
            { id: 'r-2', broadcast_id: 'bc-2' },
            { id: 'r-3', broadcast_id: null }
          ],
          error: null
        }),
        update: updateMock
      })
    } as unknown as SupabaseClient;
    await cleanupStaleDrafts(supa);
    // DB-only: no external HTTP calls made
    expect(fetchSpy).not.toHaveBeenCalled();
    // All three rows are expired regardless of broadcast_id presence
    expect(updateMock).toHaveBeenCalledTimes(3);
    expect(updateMock).toHaveBeenCalledWith({ status: 'expired' });
    fetchSpy.mockRestore();
  });

  it('leaves non-draft and fresh draft rows untouched', async () => {
    vi.resetModules();
    const { cleanupStaleDrafts } = await import('@/lib/digest');
    const updateMock = vi.fn();
    // Supabase mock: .lt() returns empty (no stale drafts qualify the select)
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

// ── buildDigestSections ───────────────────────────────────────────────────────

describe('buildDigestSections', () => {
  const fakeArticles: DigestItem[] = [
    {
      id: 'a1',
      title: 'Gas safety update for plumbers',
      ai_summary: 'New gas regs effective July.',
      why_it_matters: 'Affects all licensed gas fitters.',
      original_url: 'https://example.com/gas-safety',
      source: 'WorkSafe AU',
      published_at: '2026-06-14T00:00:00Z',
      relevance_score: 95
    },
    {
      id: 'a2',
      title: 'Electricians & the new code',
      ai_summary: 'Wiring standard revised.',
      why_it_matters: 'Mandatory from 1 July.',
      original_url: 'https://example.com/wiring',
      source: 'Standards AU',
      published_at: '2026-06-15T00:00:00Z',
      relevance_score: 88
    },
    {
      id: 'a3',
      title: 'Builder licensing changes <2026>',
      ai_summary: 'Summary with <html> & special chars.',
      why_it_matters: 'Important & "urgent".',
      original_url: 'https://example.com/builders?a=1&b=2',
      source: 'VBA',
      published_at: '2026-06-16T00:00:00Z',
      relevance_score: 80
    }
  ];

  const dateRange = {
    start: new Date('2026-06-14'),
    end: new Date('2026-06-21')
  };

  it('starts with a header section with wordmark_text TradieIntel and teal background', async () => {
    vi.resetModules();
    const { buildDigestSections } = await import('@/lib/digest');
    const sections = buildDigestSections(fakeArticles, dateRange);
    expect(sections.length).toBeGreaterThan(0);
    const first = sections[0] as { type: string; props: Record<string, string> };
    expect(first.type).toBe('header');
    expect(first.props.variant).toBe('wordmark');
    expect(first.props.wordmark_text).toBe('TradieIntel');
    expect(first.props.wordmark_color).toBe('#ffffff');
    expect(first.props.background_color).toBe('#0f766e');
  });

  it('ends with a footer section', async () => {
    vi.resetModules();
    const { buildDigestSections } = await import('@/lib/digest');
    const sections = buildDigestSections(fakeArticles, dateRange);
    const last = sections[sections.length - 1] as { type: string };
    expect(last.type).toBe('footer');
  });

  it('returns header + intro text + 3 article sections + footer = 6 sections for 3 articles', async () => {
    vi.resetModules();
    const { buildDigestSections } = await import('@/lib/digest');
    const sections = buildDigestSections(fakeArticles, dateRange);
    // 1 header + 1 intro text + 3 article text sections + 1 footer = 6
    expect(sections).toHaveLength(6);
  });

  it('includes each article title in the serialized sections', async () => {
    vi.resetModules();
    const { buildDigestSections } = await import('@/lib/digest');
    const sections = buildDigestSections(fakeArticles, dateRange);
    const serialized = JSON.stringify(sections);
    expect(serialized).toContain('Gas safety update for plumbers');
    expect(serialized).toContain('Electricians &amp; the new code');
    expect(serialized).toContain('Builder licensing changes &lt;2026&gt;');
  });

  it('includes each article original_url in the serialized sections', async () => {
    vi.resetModules();
    const { buildDigestSections } = await import('@/lib/digest');
    const sections = buildDigestSections(fakeArticles, dateRange);
    const serialized = JSON.stringify(sections);
    expect(serialized).toContain('https://example.com/gas-safety');
    expect(serialized).toContain('https://example.com/wiring');
  });

  it('article sections are type text with content including teal link and italic why_it_matters', async () => {
    vi.resetModules();
    const { buildDigestSections } = await import('@/lib/digest');
    const sections = buildDigestSections(fakeArticles, dateRange);
    // Article sections start at index 2 (after header + intro)
    const articleSection = sections[2] as { type: string; props: { content: string } };
    expect(articleSection.type).toBe('text');
    expect(articleSection.props.content).toContain('color:#0f766e');
    expect(articleSection.props.content).toContain('font-style:italic');
  });

  it('intro text section includes the date range label', async () => {
    vi.resetModules();
    const { buildDigestSections } = await import('@/lib/digest');
    const sections = buildDigestSections(fakeArticles, dateRange);
    const intro = sections[1] as { type: string; props: { content: string } };
    expect(intro.type).toBe('text');
    // Should contain date range (14 Jun and 21 Jun in en-AU format)
    expect(intro.props.content).toContain('14 Jun');
    expect(intro.props.content).toContain('21 Jun');
  });

  it('escapes HTML special chars in article title and why_it_matters', async () => {
    vi.resetModules();
    const { buildDigestSections } = await import('@/lib/digest');
    const sections = buildDigestSections(fakeArticles, dateRange);
    const serialized = JSON.stringify(sections);
    // Article 3 has <2026> in title — must be escaped
    expect(serialized).not.toContain('<2026>');
    expect(serialized).toContain('&lt;2026&gt;');
    // why_it_matters has &amp; and "
    expect(serialized).toContain('Important &amp; &quot;urgent&quot;');
  });

  it('handles zero articles gracefully: header + intro + footer only', async () => {
    vi.resetModules();
    const { buildDigestSections } = await import('@/lib/digest');
    const sections = buildDigestSections([], dateRange);
    expect(sections).toHaveLength(3);
    expect((sections[0] as { type: string }).type).toBe('header');
    expect((sections[sections.length - 1] as { type: string }).type).toBe('footer');
  });
});
