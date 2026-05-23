import { describe, it, expect } from 'vitest';
import { selectRelated } from '@/lib/related';
import type { FeedItem } from '@/lib/supabase';

function item(o: Partial<FeedItem>): FeedItem {
  return {
    id: 'x', source: 'src', source_url: 'u', original_url: 'u', title: 't',
    original_content: null, published_at: new Date().toISOString(),
    niche: 'trades', ai_summary: null, why_it_matters: null,
    relevance_score: 50, tags: [], slug: 's', created_at: new Date().toISOString(),
    ...o
  };
}

describe('selectRelated', () => {
  const current = item({ id: 'c', tags: ['plumbing', 'QLD'], source: 'src-a' });

  it('prefers items with most tag overlap', () => {
    const candidates = [
      item({ id: '1', tags: ['electrical'] }),
      item({ id: '2', tags: ['plumbing'] }),
      item({ id: '3', tags: ['plumbing', 'QLD'] })
    ];
    expect(selectRelated(current, candidates, 2).map(i => i.id)).toEqual(['3', '2']);
  });

  it('falls back to same source when no tag overlap', () => {
    const candidates = [
      item({ id: '1', tags: ['random'], source: 'src-b' }),
      item({ id: '2', tags: ['random'], source: 'src-a' })
    ];
    expect(selectRelated(current, candidates, 1).map(i => i.id)).toEqual(['2']);
  });

  it('falls back to most recent if nothing matches', () => {
    const candidates = [
      item({ id: '1', tags: ['x'], source: 'other', published_at: '2026-01-01T00:00:00Z' }),
      item({ id: '2', tags: ['y'], source: 'other', published_at: '2026-05-01T00:00:00Z' })
    ];
    expect(selectRelated(current, candidates, 1).map(i => i.id)).toEqual(['2']);
  });

  it('never returns the current item', () => {
    const candidates = [current, item({ id: 'other', tags: ['plumbing'] })];
    expect(selectRelated(current, candidates, 5).map(i => i.id)).not.toContain('c');
  });

  it('respects the limit', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => item({ id: `${i}`, tags: ['plumbing'] }));
    expect(selectRelated(current, candidates, 3)).toHaveLength(3);
  });
});
