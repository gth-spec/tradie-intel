import { describe, it, expect, vi } from 'vitest';
import { handleConfirm } from '@/lib/confirm';
import { signToken } from '@/lib/token';
import { MemoryProvider } from '@/lib/email';
import type { ConfirmTokenPayload, ConsentScope } from '@/lib/consent';

const SECRET = 'confirm-test-secret';
const now = () => Math.floor(Date.now() / 1000);

function token(over: Partial<ConfirmTokenPayload> = {}): string {
  return signToken<ConfirmTokenPayload>({
    email: 'a@b.com',
    scope: 'tradieintel_digest',
    source: 'homepage-hero',
    referrer: null,
    utm_source: 'meta',
    utm_medium: null,
    utm_campaign: null,
    iat: now(),
    exp: now() + 3600,
    ...over
  }, SECRET);
}

/** Captures recordConsent calls instead of hitting Supabase. */
function deps(provider: MemoryProvider | null, recorded: any[] = []) {
  return {
    secret: SECRET,
    recordConsent: async (row: any) => { recorded.push(row); },
    getProviderFor: (_s: ConsentScope) => provider,
    recorded
  };
}

const meta = { ipHash: 'iphash', userAgent: 'vitest' };

describe('handleConfirm', () => {
  it('records consent and subscribes on a valid token', async () => {
    const provider = new MemoryProvider();
    const d = deps(provider);
    const out = await handleConfirm(token(), meta, d);

    expect(out).toEqual({ status: 'ok', scope: 'tradieintel_digest' });
    expect(provider.list()).toEqual(['a@b.com']);
    expect(d.recorded).toHaveLength(1);
    expect(d.recorded[0]).toMatchObject({
      email: 'a@b.com', scope: 'tradieintel_digest', source: 'homepage-hero', utm_source: 'meta'
    });
  });

  it('writes the consent row even when the provider throws, strictly before the subscribe attempt', async () => {
    const provider = new MemoryProvider();
    const callOrder: string[] = [];
    const recorded: any[] = [];
    vi.spyOn(provider, 'subscribe').mockImplementation(async () => {
      callOrder.push('subscribe');
      throw new Error('nitrosend 503');
    });
    const d = {
      secret: SECRET,
      recordConsent: async (row: any) => {
        callOrder.push('recordConsent');
        recorded.push(row);
      },
      getProviderFor: (_s: ConsentScope) => provider
    };

    const out = await handleConfirm(token(), meta, d);

    expect(out).toEqual({ status: 'provider_error', scope: 'tradieintel_digest' });
    expect(recorded).toHaveLength(1); // consent survived the provider failure
    // Guards against a future refactor that races recordConsent and subscribe
    // (e.g. via Promise.all) - that would still leave recorded.length === 1 and
    // outcome === 'provider_error', but callOrder would no longer be guaranteed
    // ['recordConsent', 'subscribe'].
    expect(callOrder).toEqual(['recordConsent', 'subscribe']);
  });

  it('records consent and skips subscribing when the scope has no provider', async () => {
    const d = deps(null);
    const out = await handleConfirm(token({ scope: 'grokoryai_commercial' }), meta, d);

    expect(out).toEqual({ status: 'ok', scope: 'grokoryai_commercial' });
    expect(d.recorded).toHaveLength(1);
  });

  it('rejects a tampered token without recording or subscribing', async () => {
    const provider = new MemoryProvider();
    const d = deps(provider);
    const out = await handleConfirm(token() + 'x', meta, d);

    expect(out).toEqual({ status: 'invalid' });
    expect(d.recorded).toHaveLength(0);
    expect(provider.list()).toEqual([]);
  });

  it('rejects an expired token without recording or subscribing', async () => {
    const provider = new MemoryProvider();
    const d = deps(provider);
    const out = await handleConfirm(token({ exp: now() - 10 }), meta, d);

    expect(out).toEqual({ status: 'expired' });
    expect(d.recorded).toHaveLength(0);
    expect(provider.list()).toEqual([]);
  });

  it('is idempotent across a repeated click', async () => {
    const provider = new MemoryProvider();
    const d = deps(provider);
    const t = token();
    await handleConfirm(t, meta, d);
    const out = await handleConfirm(t, meta, d);

    expect(out).toEqual({ status: 'ok', scope: 'tradieintel_digest' });
    expect(provider.list()).toEqual(['a@b.com']); // MemoryProvider dedupes via Set
  });
});
