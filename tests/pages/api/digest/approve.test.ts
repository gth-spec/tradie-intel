import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signApproveToken } from '@/lib/digest';

const SECRET = 'test-secret-at-least-32-chars-abc';

// Mock Supabase adminClient
vi.mock('@/lib/supabase', () => ({
  adminClient: vi.fn()
}));

// Mock digest functions - keep real signApproveToken/verifyApproveToken, mock sendResendBroadcast
vi.mock('@/lib/digest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/digest')>();
  return {
    ...actual,
    sendResendBroadcast: vi.fn().mockResolvedValue(undefined)
  };
});

function makeRequest(token: string): Request {
  return new Request(`https://tradieintel.com.au/api/digest/approve?token=${encodeURIComponent(token)}`, {
    method: 'GET'
  });
}

function makeUrl(token: string): URL {
  return new URL(`https://example.com?token=${encodeURIComponent(token)}`);
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
    vi.stubEnv('RESEND_API_KEY', 're_test_key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('verifies the HMAC token, calls Resend send, and updates digest_runs to sent', async () => {
    const { adminClient } = await import('@/lib/supabase');
    (adminClient as ReturnType<typeof vi.fn>).mockReturnValue(makeSupaWithRun('draft'));

    const { GET } = await import('@/pages/api/digest/approve');
    const { sendResendBroadcast } = await import('@/lib/digest');
    const token = signApproveToken('run-id-1', 'campaign-123', SECRET);
    const res = await GET({ request: makeRequest(token), url: makeUrl(token) } as Parameters<typeof GET>[0]);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Digest sent');
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(sendResendBroadcast).toHaveBeenCalledWith('re_test_key', 'campaign-123');
  });

  it('returns 400 on missing or malformed token', async () => {
    vi.resetModules();
    const { GET } = await import('@/pages/api/digest/approve');
    const req = new Request('https://tradieintel.com.au/api/digest/approve', { method: 'GET' });
    const res = await GET({ request: req, url: new URL('https://example.com') } as Parameters<typeof GET>[0]);
    expect(res.status).toBe(400);
  });

  it('returns 401 on bad signature', async () => {
    vi.resetModules();
    const { GET } = await import('@/pages/api/digest/approve');
    const badToken = 'invalid.token.signature';
    const res = await GET({ request: makeRequest(badToken), url: makeUrl(badToken) } as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
  });

  it('returns 409 when run is already sent', async () => {
    const { adminClient } = await import('@/lib/supabase');
    (adminClient as ReturnType<typeof vi.fn>).mockReturnValue(makeSupaWithRun('sent'));
    const { GET } = await import('@/pages/api/digest/approve');
    const { sendResendBroadcast } = await import('@/lib/digest');
    vi.mocked(sendResendBroadcast).mockClear();
    const token = signApproveToken('run-id-1', 'campaign-123', SECRET);
    const res = await GET({ request: makeRequest(token), url: makeUrl(token) } as Parameters<typeof GET>[0]);
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain('Not draftable');
    expect(sendResendBroadcast).not.toHaveBeenCalled();
  });

  it('returns 409 when run has status skipped', async () => {
    const { adminClient } = await import('@/lib/supabase');
    (adminClient as ReturnType<typeof vi.fn>).mockReturnValue(makeSupaWithRun('skipped'));
    const { GET } = await import('@/pages/api/digest/approve');
    const { sendResendBroadcast } = await import('@/lib/digest');
    vi.mocked(sendResendBroadcast).mockClear();
    const token = signApproveToken('run-id-1', 'campaign-123', SECRET);
    const res = await GET({ request: makeRequest(token), url: makeUrl(token) } as Parameters<typeof GET>[0]);
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain('Not draftable');
    expect(sendResendBroadcast).not.toHaveBeenCalled();
  });

  it('returns 502 when sendResendBroadcast throws', async () => {
    const { adminClient } = await import('@/lib/supabase');
    const supaStub = makeSupaWithRun('draft');
    (adminClient as ReturnType<typeof vi.fn>).mockReturnValue(supaStub);
    const { GET } = await import('@/pages/api/digest/approve');
    const { sendResendBroadcast } = await import('@/lib/digest');
    vi.mocked(sendResendBroadcast).mockRejectedValueOnce(new Error('Resend broadcast send error: 500 Internal Server Error'));
    const token = signApproveToken('run-id-1', 'campaign-123', SECRET);
    const res = await GET({ request: makeRequest(token), url: makeUrl(token) } as Parameters<typeof GET>[0]);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain('Resend send failed');
    // DB update must NOT have been called
    expect(supaStub.from().update).not.toHaveBeenCalled();
  });

  it('returns 404 when run id not found', async () => {
    vi.resetModules();
    const { adminClient } = await import('@/lib/supabase');
    (adminClient as ReturnType<typeof vi.fn>).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } })
      })
    });
    const { GET } = await import('@/pages/api/digest/approve');
    const token = signApproveToken('run-id-1', 'campaign-123', SECRET);
    const res = await GET({ request: makeRequest(token), url: makeUrl(token) } as Parameters<typeof GET>[0]);
    expect(res.status).toBe(404);
  });
});
