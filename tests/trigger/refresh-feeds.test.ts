import { describe, it, expect } from 'vitest';
import { normalizeUrl } from '@/trigger/refresh-feeds';

describe('normalizeUrl', () => {
  it('strips a trailing slash so both forms dedupe together', () => {
    expect(normalizeUrl('https://sourceable.net/some-article/')).toBe(
      'https://sourceable.net/some-article'
    );
    expect(normalizeUrl('https://sourceable.net/some-article')).toBe(
      'https://sourceable.net/some-article'
    );
  });

  it('leaves a bare root path alone', () => {
    expect(normalizeUrl('https://sourceable.net/')).toBe('https://sourceable.net/');
  });

  it('returns the input unchanged if it is not a valid URL', () => {
    expect(normalizeUrl('not-a-url')).toBe('not-a-url');
  });
});
