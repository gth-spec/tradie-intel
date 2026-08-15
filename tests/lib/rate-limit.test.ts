import { describe, it, expect } from 'vitest';
import { checkRateLimit, hashValue } from '@/lib/rate-limit';

/** Minimal stub of the Supabase query chain used by checkRateLimit. */
function stubSupa(rows: any[], opts: { throwOnSelect?: boolean } = {}) {
  const inserted: any[] = [];
  const orFilters: string[] = [];
  return {
    inserted,
    orFilters,
    from() {
      return {
        select() {
          return {
            gte() {
              return {
                or(filter: string) {
                  orFilters.push(filter);
                  if (opts.throwOnSelect) throw new Error('supabase down');
                  return Promise.resolve({ data: rows, error: null });
                }
              };
            }
          };
        },
        insert(row: any) { inserted.push(row); return Promise.resolve({ error: null }); },
        delete() { return { lt: () => Promise.resolve({ error: null }) }; }
      };
    }
  } as any;
}

describe('checkRateLimit', () => {
  it('allows a first-time address', async () => {
    const supa = stubSupa([]);
    expect(await checkRateLimit(supa, 'a@b.com', '1.1.1.1')).toMatchObject({ allowed: true });
  });

  it('blocks a repeat of the same address inside the window', async () => {
    const recent = { email_hash: hashValue('a@b.com'), ip_hash: hashValue('9.9.9.9'), created_at: new Date().toISOString() };
    const supa = stubSupa([recent]);
    expect(await checkRateLimit(supa, 'a@b.com', '1.1.1.1')).toMatchObject({ allowed: false });
  });

  it('blocks a sixth signup from the same IP within the hour', async () => {
    const ipHash = hashValue('1.1.1.1');
    const rows = Array.from({ length: 5 }, (_, i) => ({
      email_hash: hashValue(`other${i}@b.com`), ip_hash: ipHash, created_at: new Date().toISOString()
    }));
    const supa = stubSupa(rows);
    expect(await checkRateLimit(supa, 'new@b.com', '1.1.1.1')).toMatchObject({ allowed: false });
  });

  it('fails open when the store is unreachable', async () => {
    const supa = stubSupa([], { throwOnSelect: true });
    expect(await checkRateLimit(supa, 'a@b.com', '1.1.1.1')).toMatchObject({ allowed: true });
  });

  it('hashes rather than storing raw values', () => {
    expect(hashValue('a@b.com')).not.toContain('a@b.com');
    expect(hashValue('A@B.com')).toBe(hashValue('a@b.com'));
  });

  it('degrades correctly when ip is null: address-window check still applies, .or() filter omits the ip_hash term, and insert writes ip_hash: null', async () => {
    // Address-window check must still block even with no IP to key on.
    const recent = { email_hash: hashValue('a@b.com'), ip_hash: null, created_at: new Date().toISOString() };
    const supaBlocked = stubSupa([recent]);
    expect(await checkRateLimit(supaBlocked, 'a@b.com', null)).toMatchObject({ allowed: false, reason: 'address_window' });
    expect(supaBlocked.orFilters[0]).toContain('email_hash.eq.');
    expect(supaBlocked.orFilters[0]).not.toContain('ip_hash');

    // First-time address with no IP: allowed, doesn't throw, and the row it writes has ip_hash: null.
    const supaAllowed = stubSupa([]);
    expect(await checkRateLimit(supaAllowed, 'new@b.com', null)).toMatchObject({ allowed: true });
    expect(supaAllowed.orFilters[0]).not.toContain('ip_hash');
    expect(supaAllowed.inserted[0]).toMatchObject({ ip_hash: null });
  });
});
