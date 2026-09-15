import { describe, it, expect } from 'vitest';
import { linkify } from '@/lib/linkify';

describe('linkify', () => {
  it('links a trailing https URL with a tidy label', () => {
    expect(linkify('Rules here: https://www.mdtdesign.com.au/grant/')).toEqual([
      { text: 'Rules here: ' },
      { text: 'mdtdesign.com.au/grant', href: 'https://www.mdtdesign.com.au/grant/' },
    ]);
  });

  it('keeps trailing punctuation out of the link and leaves bare domains as text', () => {
    expect(linkify('See https://x.com/a. Or visit example.com')).toEqual([
      { text: 'See ' },
      { text: 'x.com/a', href: 'https://x.com/a' },
      { text: '. Or visit example.com' },
    ]);
  });

  it('returns plain text unchanged', () => {
    expect(linkify('No links here.')).toEqual([{ text: 'No links here.' }]);
  });
});
