import { task } from "@trigger.dev/sdk";
import { fetchFeed } from "@/lib/rss";
import { scrapeSource, type ScrapedItem } from "@/lib/scrape";
import { scrapeSourceApify } from "@/lib/scrape-apify";
import type { FeedSource } from "@/config/feeds";

// One feed per run. Returns normalised items as JSON-serialisable rows
// (publishedAt as an ISO string so it survives the task boundary cleanly).
//
// Ports the per-feed fetch logic out of refresh-feeds.ts:
//   - rss    -> fetchFeed()
//   - scrape -> scrapeSource() with scrapeSourceApify() fallback on empty
// The libs are reused unchanged; this task only re-orchestrates them.

const PER_FEED_TIMEOUT_MS = 20_000;

export interface FetchedItem {
  title: string;
  url: string;
  content: string;
  publishedAt: string; // ISO 8601
}

export const fetchFeedTask = task({
  id: "fetch-feed",
  maxDuration: 120,
  retry: {
    maxAttempts: 2,
    factor: 1.8,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 10_000,
  },
  run: async (payload: { feed: FeedSource }): Promise<FetchedItem[]> => {
    const { feed } = payload;
    const signal = AbortSignal.timeout(PER_FEED_TIMEOUT_MS);

    if (feed.type === "rss") {
      const items = await fetchFeed(feed.url, { signal });
      return items.map((i) => ({
        title: i.title,
        url: i.url,
        content: i.content,
        publishedAt: i.publishedAt.toISOString(),
      }));
    }

    // scrape: Firecrawl first (scrapeSource swallows errors -> []), Apify fallback on empty
    let items: ScrapedItem[] = [];
    try {
      items = await scrapeSource(feed, { signal });
    } catch {
      items = [];
    }
    if (items.length === 0) {
      const fallback = await scrapeSourceApify(feed, { signal });
      if (fallback.length > 0) items = fallback;
    }

    return items.map((i) => ({
      title: i.title,
      url: i.link,
      content: i.content,
      publishedAt: i.published_at.toISOString(),
    }));
  },
});
