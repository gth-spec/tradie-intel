// RSS feed sources. Verified via scripts/verify-feeds.mjs on 2026-05-23.

export interface FeedSource {
  name: string;
  url: string;
  category: 'regulatory' | 'industry' | 'news' | 'government' | 'weather';
  enabled: boolean;
}

export const FEEDS: FeedSource[] = [
  // last_verified: 2026-05-23, FAILED (404)
  { name: 'Fair Work Australia',           url: 'https://www.fairwork.gov.au/about-us/news-and-media-releases.rss',          category: 'regulatory', enabled: false },
  // last_verified: 2026-05-23, 9 items
  { name: 'Master Plumbers AU',            url: 'https://www.masterplumbers.com.au/feed',                                     category: 'industry',   enabled: true },
  // last_verified: 2026-05-23, FAILED (request timed out after 15s)
  { name: 'Master Electricians AU',        url: 'https://www.masterelectricians.com.au/feed',                                 category: 'industry',   enabled: false },
  // last_verified: 2026-05-23, FAILED (404)
  { name: 'Housing Industry Association',  url: 'https://hia.com.au/our-industry/newsroom/feed',                              category: 'industry',   enabled: false },
  // last_verified: 2026-05-23, FAILED (0 items returned)
  { name: 'Master Builders AU',            url: 'https://masterbuilders.com.au/news/feed',                                    category: 'industry',   enabled: false },
  // last_verified: 2026-05-23, FAILED (404)
  { name: 'ai.gov.au',                     url: 'https://www.ai.gov.au/news.rss',                                             category: 'government', enabled: false },
  // last_verified: 2026-05-23, FAILED (404)
  { name: 'Business.gov.au',               url: 'https://business.gov.au/news/feed',                                          category: 'government', enabled: false },
  // last_verified: 2026-05-23, FAILED (404 - BOM XML endpoint moved/removed)
  { name: 'BOM Severe Weather AU',         url: 'http://www.bom.gov.au/fwo/IDZ00056.warnings_national.xml',                   category: 'weather',    enabled: false }
];

// Note: each URL must be verified working before deploy via scripts/verify-feeds.mjs (Task 6.5).
// Use `enabled: false` to disable a feed without removing it.
// TODO: source replacement feeds for disabled categories (regulatory, government, weather, electricians, builders, HIA).
