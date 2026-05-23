import { describe, it, expect } from 'vitest';
import { authoriseCron, dedupeAgainstExisting, withinMaxAge } from '@/pages/api/cron/refresh-feeds';

describe('authoriseCron', () => {
  it('accepts matching bearer token', () => {
    const req = new Request('http://x', { headers: { Authorization: 'Bearer s3cret' } });
    expect(authoriseCron(req, 's3cret')).toBe(true);
  });
  it('rejects missing header', () => {
    const req = new Request('http://x');
    expect(authoriseCron(req, 's3cret')).toBe(false);
  });
  it('rejects wrong token', () => {
    const req = new Request('http://x', { headers: { Authorization: 'Bearer nope' } });
    expect(authoriseCron(req, 's3cret')).toBe(false);
  });
});

describe('dedupeAgainstExisting', () => {
  it('filters out items whose URL already exists', () => {
    const existing = new Set(['https://a', 'https://b']);
    const candidates = [
      { url: 'https://a', title: 'A', content: '', publishedAt: new Date() },
      { url: 'https://c', title: 'C', content: '', publishedAt: new Date() }
    ];
    const result = dedupeAgainstExisting(candidates, existing);
    expect(result.map(r => r.url)).toEqual(['https://c']);
  });
});

describe('withinMaxAge', () => {
  it('returns true for an item published today', () => {
    expect(withinMaxAge(new Date(), 14)).toBe(true);
  });
  it('returns true for an item 13 days old', () => {
    const d = new Date();
    d.setDate(d.getDate() - 13);
    expect(withinMaxAge(d, 14)).toBe(true);
  });
  it('returns false for an item 30 days old', () => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    expect(withinMaxAge(d, 14)).toBe(false);
  });
});
