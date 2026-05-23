import { describe, it, expect } from 'vitest';
import { handleSubscribe } from '@/pages/api/subscribe';
import { MemoryProvider } from '@/lib/email';

describe('handleSubscribe', () => {
  function post(body: unknown, headers: Record<string, string> = {}): Request {
    return new Request('http://x/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
  }

  it('returns 200 on valid email with consent', async () => {
    const provider = new MemoryProvider();
    const res = await handleSubscribe(post({ email: 'a@b.com', consent: true }), provider);
    expect(res.status).toBe(200);
    expect(provider.list()).toEqual(['a@b.com']);
  });

  it('returns 400 on invalid email', async () => {
    const provider = new MemoryProvider();
    const res = await handleSubscribe(post({ email: 'garbage', consent: true }), provider);
    expect(res.status).toBe(400);
  });

  it('returns 400 when consent is missing or false', async () => {
    const provider = new MemoryProvider();
    const res = await handleSubscribe(post({ email: 'a@b.com' }), provider);
    expect(res.status).toBe(400);
  });

  it('silently accepts (200) but does not subscribe when honeypot is filled', async () => {
    const provider = new MemoryProvider();
    const res = await handleSubscribe(post({ email: 'a@b.com', consent: true, website: 'http://bot.com' }), provider);
    expect(res.status).toBe(200);
    expect(provider.list()).toEqual([]);
  });

  it('returns 400 on missing email field', async () => {
    const provider = new MemoryProvider();
    const res = await handleSubscribe(post({ consent: true }), provider);
    expect(res.status).toBe(400);
  });

  it('forwards consent metadata to the provider', async () => {
    const provider = new MemoryProvider();
    await handleSubscribe(post({
      email: 'a@b.com', consent: true, source: 'homepage-hero', referrer: 'https://google.com'
    }), provider);
    expect(provider.lastMeta()).toMatchObject({
      source: 'homepage-hero', referrer: 'https://google.com', consent: true
    });
  });
});
