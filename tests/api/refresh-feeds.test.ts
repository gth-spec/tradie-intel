import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authoriseCron, dedupeAgainstExisting, withinMaxAge, processItem } from '@/pages/api/cron/refresh-feeds';
import * as claude from '@/lib/claude';
import type { Enrichment } from '@/lib/claude';

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

describe('processItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps GEO enrichment fields to InsertRow', async () => {
    const mockEnrichment: Enrichment = {
      summary: 'Test summary',
      whyItMatters: 'Test why it matters',
      relevanceScore: 85,
      tags: ['plumbing', 'new-requirements'],
      questionHeadline: 'How will this affect my business?',
      keyStat: '$50 million in government funding',
      keyQuote: 'This will change everything - John Smith, CEO',
      keyTakeaways: ['First takeaway', 'Second takeaway']
    };

    vi.spyOn(claude, 'enrich').mockResolvedValue(mockEnrichment);

    const item = {
      title: 'Test Article',
      url: 'https://example.com/article',
      content: 'Test content here',
      publishedAt: new Date('2026-05-24')
    };

    const row = await processItem(item, 'TestFeed', 'https://example.com/feed');

    expect(row).not.toBeNull();
    expect(row?.question_headline).toBe(mockEnrichment.questionHeadline);
    expect(row?.key_stat).toBe(mockEnrichment.keyStat);
    expect(row?.key_quote).toBe(mockEnrichment.keyQuote);
    expect(row?.key_takeaways).toEqual(mockEnrichment.keyTakeaways);
  });
});
