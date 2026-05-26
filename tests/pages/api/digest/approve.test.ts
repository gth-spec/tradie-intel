import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signApproveToken } from '@/lib/digest';

const SECRET = 'test-secret-at-least-32-chars-abc';

// Mock Supabase adminClient
vi.mock('@/lib/supabase', () => ({
  adminClient: vi.fn()
}));

// Mock digest functions - keep real signApproveToken/verifyApproveToken, mock scheduleLoopsBroadcast
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
    const res = await GET({ request: makeRequest(token), url: makeUrl(token) } as Parameters<typeof GET>[0]);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Digest approved');
    expect(res.headers.get('Content-Type')).toContain('text/html');
  });

  it('returns 400 HTML error page when token is expired', async () => {
    vi.useFakeTimers();
    const token = signApproveToken('run-id-1', 'campaign-123', SECRET);
    vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000);

    vi.resetModules();
    const { GET } = await import('@/pages/api/digest/approve');
    const res = await GET({ request: makeRequest(token), url: makeUrl(token) } as Parameters<typeof GET>[0]);

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain('expired');
    vi.useRealTimers();
  });

  it('returns 409 HTML error page when run is already approved', async () => {
    vi.resetModules();
    const { adminClient } = await import('@/lib/supabase');
    (adminClient as ReturnType<typeof vi.fn>).mockReturnValue(makeSupaWithRun('approved'));
    const { GET } = await import('@/pages/api/digest/approve');
    const token = signApproveToken('run-id-1', 'campaign-123', SECRET);
    const res = await GET({ request: makeRequest(token), url: makeUrl(token) } as Parameters<typeof GET>[0]);
    expect(res.status).toBe(409);
  });

  it('returns 400 when token is missing', async () => {
    vi.resetModules();
    const { GET } = await import('@/pages/api/digest/approve');
    const req = new Request('https://tradieintel.com.au/api/digest/approve', { method: 'GET' });
    const res = await GET({ request: req, url: new URL('https://example.com') } as Parameters<typeof GET>[0]);
    expect(res.status).toBe(400);
  });
});
