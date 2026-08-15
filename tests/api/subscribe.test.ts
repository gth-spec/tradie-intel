import { describe, it, expect, vi } from 'vitest';
import { handleSubscribe, type SubscribeDeps } from '@/pages/api/subscribe';
import { verifyToken } from '@/lib/token';
import type { ConfirmTokenPayload } from '@/lib/consent';

const SECRET = 'subscribe-test-secret';

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://x/api/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

function deps(over: Partial<SubscribeDeps> = {}): SubscribeDeps & { sent: any[] } {
  const sent: any[] = [];
  return {
    secret: SECRET,
    siteUrl: 'https://x.test',
    checkRateLimit: async () => ({ allowed: true }),
    sendConfirmationEmail: async (to, links) => { sent.push({ to, links }); },
    sent,
    ...over
  } as SubscribeDeps & { sent: any[] };
}

describe('handleSubscribe', () => {
  it('returns 200 and sends a confirmation without subscribing anyone', async () => {
    const d = deps();
    const res = await handleSubscribe(post({ email: 'a@b.com', consent_digest: true }), d);

    expect(res.status).toBe(200);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].to).toBe('a@b.com');
    expect(d.sent[0].links).toHaveLength(1);
    expect(d.sent[0].links[0].scope).toBe('tradieintel_digest');
  });

  it('mints two scoped tokens when both boxes are ticked', async () => {
    const d = deps();
    await handleSubscribe(post({ email: 'a@b.com', consent_digest: true, consent_commercial: true }), d);

    const scopes = d.sent[0].links.map((l: any) => l.scope);
    expect(scopes).toEqual(['tradieintel_digest', 'grokoryai_commercial']);
    expect(d.sent).toHaveLength(1); // one email, two links - never two emails
  });

  it('carries attribution metadata into the token', async () => {
    const d = deps();
    await handleSubscribe(post({
      email: 'a@b.com', consent_digest: true,
      source: 'homepage-hero', referrer: 'https://google.com', utm_source: 'meta'
    }), d);

    const url = new URL(d.sent[0].links[0].url);
    const payload = verifyToken<ConfirmTokenPayload>(url.searchParams.get('t')!, SECRET);
    expect(payload).toMatchObject({
      email: 'a@b.com', source: 'homepage-hero', referrer: 'https://google.com', utm_source: 'meta'
    });
    expect(payload.iat).toBeGreaterThan(0);
  });

  it('returns 400 on invalid email format before sending anything', async () => {
    const d = deps();
    const res = await handleSubscribe(post({ email: 'garbage', consent_digest: true }), d);
    expect(res.status).toBe(400);
    expect(d.sent).toHaveLength(0);
  });

  it('returns 400 when digest consent is missing or false', async () => {
    const d = deps();
    expect((await handleSubscribe(post({ email: 'a@b.com' }), d)).status).toBe(400);
    expect((await handleSubscribe(post({ email: 'a@b.com', consent_digest: false }), d)).status).toBe(400);
    expect(d.sent).toHaveLength(0);
  });

  it('returns 400 on missing email field', async () => {
    const d = deps();
    expect((await handleSubscribe(post({ consent_digest: true }), d)).status).toBe(400);
  });

  it('silently accepts (200) but sends nothing when the honeypot is filled', async () => {
    const d = deps();
    const res = await handleSubscribe(
      post({ email: 'a@b.com', consent_digest: true, website: 'http://bot.com' }), d
    );
    expect(res.status).toBe(200);
    expect(d.sent).toHaveLength(0);
  });

  it('returns 200 without sending when rate-limited, so the response cannot probe the limiter', async () => {
    const d = deps({ checkRateLimit: async () => ({ allowed: false, reason: 'ip_cap' as const }) });
    const res = await handleSubscribe(post({ email: 'a@b.com', consent_digest: true }), d);
    expect(res.status).toBe(200);
    expect(d.sent).toHaveLength(0);
  });

  it('returns 200 identically whether or not the address already exists', async () => {
    const d = deps();
    const first = await handleSubscribe(post({ email: 'a@b.com', consent_digest: true }), d);
    const second = await handleSubscribe(post({ email: 'a@b.com', consent_digest: true }), d);
    expect(await first.text()).toBe(await second.text());
    expect(first.status).toBe(second.status);
  });

  it('returns 405 on non-POST', async () => {
    const d = deps();
    const res = await handleSubscribe(new Request('http://x/api/subscribe', { method: 'GET' }), d);
    expect(res.status).toBe(405);
  });
});
