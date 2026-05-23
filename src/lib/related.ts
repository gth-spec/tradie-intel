import type { FeedItem } from '@/lib/supabase';

export function selectRelated(current: FeedItem, candidates: FeedItem[], limit: number): FeedItem[] {
  const others = candidates.filter(c => c.id !== current.id);
  const currentTags = new Set(current.tags);

  const scored = others.map(c => {
    const overlap = c.tags.filter(t => currentTags.has(t)).length;
    const sameSource = c.source === current.source ? 1 : 0;
    const ts = new Date(c.published_at).getTime();
    return { item: c, overlap, sameSource, ts };
  });

  scored.sort((a, b) => {
    if (b.overlap !== a.overlap) return b.overlap - a.overlap;
    if (b.sameSource !== a.sameSource) return b.sameSource - a.sameSource;
    return b.ts - a.ts;
  });

  return scored.slice(0, limit).map(s => s.item);
}
