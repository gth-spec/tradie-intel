import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryProvider, isValidEmail, type SubscribeMeta } from '@/lib/email';

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
