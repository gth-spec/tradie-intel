import { describe, it, expect } from 'vitest';
import { normaliseTags, enrichmentPrompt } from '@/lib/claude';

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
