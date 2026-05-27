import { describe, it, expect } from 'vitest';
import { titleToSlug } from '@/lib/slug';

describe('titleToSlug', () => {
  it('lowercases and hyphenates', () => {
    expect(titleToSlug('New Licensing Rules')).toBe('new-licensing-rules');
  });
  it('strips punctuation', () => {
    expect(titleToSlug("Plumber's Guide: 2026 Update")).toBe('plumbers-guide-2026-update');
  });
  it('collapses whitespace', () => {
    expect(titleToSlug('A    B   C')).toBe('a-b-c');
  });
  it('truncates long slugs to 80 chars', () => {
    const long = 'word '.repeat(50);
    expect(titleToSlug(long).length).toBeLessThanOrEqual(80);
  });
  it('handles non-ASCII', () => {
    expect(titleToSlug('Café résumé')).toBe('cafe-resume');
  });
  it('appends a short hash when given a duplicate suffix', () => {
    expect(titleToSlug('Test', 'abc123')).toBe('test-abc123');
  });

  // Regression: the cron used to pass `item.url.slice(-6)` as the suffix, which
  // produced ugly slugs like '...businesss-nesss', '...supply-strains-rains'.
  // Refresh-feeds.ts now calls titleToSlug(title) with no suffix; this test
  // pins the expected behaviour so the regression can't recur silently.
  it('produces a clean slug from a title with no suffix arg', () => {
    expect(titleToSlug('Mental Health Support for Small Businesss'))
      .toBe('mental-health-support-for-small-businesss');
    expect(titleToSlug('Support for plumbing businesses facing high fuel costs and supply strains'))
      .toBe('support-for-plumbing-businesses-facing-high-fuel-costs-and-supply-strains');
    // ^ clean — no '-rains' fragment appended from old URL-suffix behaviour
  });
});
