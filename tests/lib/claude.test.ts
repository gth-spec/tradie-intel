import { describe, it, expect } from 'vitest';
import { normaliseTags, enrichmentPrompt, parseEnrichmentResponse } from '@/lib/claude';

describe('normaliseTags', () => {
  it('lowercases trade categories', () => {
    expect(normaliseTags(['Plumbing', 'electrical'])).toEqual(['plumbing', 'electrical']);
  });
  it('preserves uppercase state codes', () => {
    expect(normaliseTags(['QLD', 'nsw'])).toEqual(['QLD', 'NSW']);
  });
  it('maps known aliases to canonical form', () => {
    expect(normaliseTags(['Queensland', 'plumber'])).toEqual(['QLD', 'plumbing']);
  });
  it('drops unknown tags', () => {
    expect(normaliseTags(['plumbing', 'random-garbage'])).toEqual(['plumbing']);
  });
  it('de-dupes', () => {
    expect(normaliseTags(['QLD', 'qld', 'Queensland'])).toEqual(['QLD']);
  });
});

describe('enrichmentPrompt', () => {
  it('includes the title and content', () => {
    const p = enrichmentPrompt({ title: 'Foo', content: 'Bar' });
    expect(p).toContain('Foo');
    expect(p).toContain('Bar');
  });
  it('lists allowed tags', () => {
    const p = enrichmentPrompt({ title: 'x', content: 'y' });
    expect(p).toContain('plumbing');
    expect(p).toContain('QLD');
  });
});

describe('enrichmentPrompt - GEO fields', () => {
  it('asks for question_headline', () => {
    const p = enrichmentPrompt({ title: 'Foo', content: 'Bar' });
    expect(p).toContain('question_headline');
  });
  it('asks for key_stat', () => {
    const p = enrichmentPrompt({ title: 'Foo', content: 'Bar' });
    expect(p).toContain('key_stat');
  });
  it('asks for key_quote', () => {
    const p = enrichmentPrompt({ title: 'Foo', content: 'Bar' });
    expect(p).toContain('key_quote');
  });
  it('asks for key_takeaways', () => {
    const p = enrichmentPrompt({ title: 'Foo', content: 'Bar' });
    expect(p).toContain('key_takeaways');
  });
});

describe('parseEnrichmentResponse', () => {
  it('parses a full valid response with all GEO fields', () => {
    const result = parseEnrichmentResponse(JSON.stringify({
      summary: 'Test summary',
      why_it_matters: 'Affects plumbers and electricians.',
      relevance_score: 75,
      tags: ['plumbing'],
      question_headline: 'How does this affect plumbers?',
      key_stat: null,
      key_quote: null,
      key_takeaways: ['Point one', 'Point two']
    }));
    expect(result.questionHeadline).toBe('How does this affect plumbers?');
    expect(result.keyStat).toBeNull();
    expect(result.keyTakeaways).toHaveLength(2);
  });

  it('parses response with empty takeaways', () => {
    const result = parseEnrichmentResponse(JSON.stringify({
      summary: 'Test',
      why_it_matters: 'Matters.',
      relevance_score: 50,
      tags: [],
      question_headline: 'What happened?',
      key_stat: null,
      key_quote: null,
      key_takeaways: []
    }));
    expect(result.keyTakeaways).toEqual([]);
  });

  it('truncates key_takeaways to max 4 items', () => {
    const result = parseEnrichmentResponse(JSON.stringify({
      summary: 'Test',
      why_it_matters: 'Matters.',
      relevance_score: 50,
      tags: [],
      question_headline: 'What?',
      key_stat: null,
      key_quote: null,
      key_takeaways: ['A', 'B', 'C', 'D', 'E']
    }));
    expect(result.keyTakeaways).toHaveLength(4);
  });

  it('returns keyQuote when provided', () => {
    const result = parseEnrichmentResponse(JSON.stringify({
      summary: 'Test',
      why_it_matters: 'Matters.',
      relevance_score: 50,
      tags: [],
      question_headline: 'What?',
      key_stat: '$2.4 billion allocated',
      key_quote: '"Big change" - Jane Smith, MBA CEO',
      key_takeaways: []
    }));
    expect(result.keyStat).toBe('$2.4 billion allocated');
    expect(result.keyQuote).toBe('"Big change" - Jane Smith, MBA CEO');
  });

  it('tolerates code-fenced JSON', () => {
    const json = JSON.stringify({
      summary: 'Test',
      why_it_matters: 'Matters.',
      relevance_score: 50,
      tags: [],
      question_headline: 'What?',
      key_stat: null,
      key_quote: null,
      key_takeaways: []
    });
    const result = parseEnrichmentResponse('```json\n' + json + '\n```');
    expect(result.questionHeadline).toBe('What?');
  });
});
