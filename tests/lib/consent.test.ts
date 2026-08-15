import { describe, it, expect, vi } from 'vitest';
import { recordConsent } from '@/lib/consent';
import type { ConsentRow } from '@/lib/consent';

const row: ConsentRow = {
  email: 'a@b.com',
  scope: 'tradieintel_digest',
  requested_at: new Date().toISOString(),
  source: 'homepage-hero',
  referrer: null,
  utm_source: 'meta',
  utm_medium: null,
  utm_campaign: null,
  ip_hash: 'real-iphash',
  user_agent: 'real-ua'
};

/**
 * Minimal fake of the chained Supabase query builder used by recordConsent:
 * .from().select().eq().eq().maybeSingle() for the existence check, plus
 * .from().insert() and .from().update().eq() for the write. Records every
 * call so tests can assert exactly which path (insert vs update) ran and
 * with what payload.
 */
function fakeSupabase(opts: { existing: { id: string } | null; selectError?: string }) {
  const calls: Array<{ op: string; arg?: unknown }> = [];
  const client = {
    from: vi.fn((table: string) => {
      calls.push({ op: 'from', arg: table });
      return {
        select: vi.fn((cols: string) => {
          calls.push({ op: 'select', arg: cols });
          return {
            eq: vi.fn((col: string, val: string) => {
              calls.push({ op: 'eq', arg: [col, val] });
              return {
                eq: vi.fn((col2: string, val2: string) => {
                  calls.push({ op: 'eq', arg: [col2, val2] });
                  return {
                    maybeSingle: vi.fn(async () => ({
                      data: opts.selectError ? null : opts.existing,
                      error: opts.selectError ? { message: opts.selectError } : null
                    }))
                  };
                })
              };
            })
          };
        }),
        insert: vi.fn(async (payload: unknown) => {
          calls.push({ op: 'insert', arg: payload });
          return { error: null };
        }),
        update: vi.fn((patch: unknown) => {
          calls.push({ op: 'update', arg: patch });
          return {
            eq: vi.fn(async (col: string, val: string) => {
              calls.push({ op: 'update.eq', arg: [col, val] });
              return { error: null };
            })
          };
        })
      };
    })
  };
  return { client, calls };
}

describe('recordConsent', () => {
  it('inserts with the real ip_hash/user_agent on first touch (no existing row)', async () => {
    const { client, calls } = fakeSupabase({ existing: null });

    await recordConsent(client as any, row);

    const insertCall = calls.find(c => c.op === 'insert');
    expect(insertCall).toBeTruthy();
    expect(insertCall!.arg).toMatchObject({
      email: 'a@b.com',
      scope: 'tradieintel_digest',
      ip_hash: 'real-iphash',
      user_agent: 'real-ua'
    });
    expect(calls.some(c => c.op === 'update')).toBe(false);
  });

  it('on a repeat hit, updates only confirmed_at and never touches ip_hash/user_agent', async () => {
    const { client, calls } = fakeSupabase({ existing: { id: 'row-1' } });

    // Simulates a second click carrying a DIFFERENT ip_hash/user_agent than the
    // first-touch row (e.g. the real subscriber clicking after a security-gateway
    // pre-fetch already created the row) - the update must not carry these fields
    // at all, so the first-touch values already in the DB survive untouched.
    await recordConsent(client as any, { ...row, ip_hash: 'different-iphash', user_agent: 'different-ua' });

    const updateCall = calls.find(c => c.op === 'update');
    expect(updateCall).toBeTruthy();
    expect(Object.keys(updateCall!.arg as object)).toEqual(['confirmed_at']);
    expect(calls.some(c => c.op === 'insert')).toBe(false);

    const updateEqCall = calls.find(c => c.op === 'update.eq');
    expect(updateEqCall!.arg).toEqual(['id', 'row-1']);
  });

  it('throws if the existence check fails', async () => {
    const { client } = fakeSupabase({ existing: null, selectError: 'connection refused' });

    await expect(recordConsent(client as any, row)).rejects.toThrow(/recordConsent failed: connection refused/);
  });
});
