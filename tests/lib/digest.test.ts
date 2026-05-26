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
