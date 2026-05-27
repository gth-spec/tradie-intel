import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryProvider, ResendProvider, isValidEmail, type SubscribeMeta } from '@/lib/email';

const META: SubscribeMeta = {
  consent: true,
  consent_timestamp: '2026-05-23T00:00:00Z',
  source: 'homepage-hero',
  referrer: null,
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
};

describe('isValidEmail', () => {
  it('accepts valid emails', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('a.b+c@sub.example.com.au')).toBe(true);
  });
  it('rejects obvious junk', () => {
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('@nodomain')).toBe(false);
    expect(isValidEmail('no@tld')).toBe(false);
  });
});

describe('MemoryProvider', () => {
  let provider: MemoryProvider;
  beforeEach(() => { provider = new MemoryProvider(); });

  it('stores a subscriber', async () => {
    await provider.subscribe('a@b.com', META);
    expect(provider.list()).toEqual(['a@b.com']);
  });

  it('de-dupes', async () => {
    await provider.subscribe('a@b.com', META);
    await provider.subscribe('a@b.com', META);
    expect(provider.list()).toEqual(['a@b.com']);
  });

  it('rejects invalid emails', async () => {
    await expect(provider.subscribe('garbage', META)).rejects.toThrow(/invalid email/i);
  });

  it('records the most recent meta for retrieval', async () => {
    await provider.subscribe('a@b.com', META);
    expect(provider.lastMeta()).toMatchObject({
      source: 'homepage-hero', consent: true
    });
  });
});

const meta: SubscribeMeta = {
  consent: true,
  consent_timestamp: '2026-05-27T00:00:00.000Z',
  source: 'tradieintel.com.au',
  referrer: null,
  utm_source: 'organic',
  utm_medium: null,
  utm_campaign: null
};

describe('ResendProvider.subscribe', () => {
  beforeEach(() => { vi.spyOn(global, 'fetch'); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('POSTs /contacts with email, segments[{id}], and utm/consent in properties', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ object: 'contact', id: 'c-1' }), { status: 200 })
    );
    const p = new ResendProvider('re_key', 'seg-1');
    await p.subscribe('user@example.com', meta);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.resend.com/contacts');
    expect(init.headers['Authorization']).toBe('Bearer re_key');
    const body = JSON.parse(init.body);
    expect(body.email).toBe('user@example.com');
    expect(body.segments).toEqual([{ id: 'seg-1' }]);
    expect(body.unsubscribed).toBe(false);
    expect(body.properties).toEqual(expect.objectContaining({
      source: 'tradieintel.com.au',
      utm_source: 'organic',
      consent_at: '2026-05-27T00:00:00.000Z'
    }));
  });

  it('rejects invalid email before any fetch', async () => {
    const p = new ResendProvider('re_key', 'seg-1');
    await expect(p.subscribe('not-an-email', meta)).rejects.toThrow('Invalid email');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('treats 422 "already exists" as success (idempotent re-subscribe)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Contact already exists' }), { status: 422 })
    );
    const p = new ResendProvider('re_key', 'seg-1');
    await expect(p.subscribe('user@example.com', meta)).resolves.toBeUndefined();
  });

  it('throws on other non-2xx responses', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('forbidden', { status: 403 })
    );
    const p = new ResendProvider('re_key', 'seg-1');
    await expect(p.subscribe('user@example.com', meta)).rejects.toThrow('Resend contact create error: 403');
  });

  it('sets unsubscribed: true when meta.consent is false', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ object: 'contact', id: 'c-1' }), { status: 200 })
    );
    const p = new ResendProvider('re_key', 'seg-1');
    await p.subscribe('user@example.com', { ...meta, consent: false });
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const body = JSON.parse(init.body);
    expect(body.unsubscribed).toBe(true);
  });
});
