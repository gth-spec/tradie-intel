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
});
