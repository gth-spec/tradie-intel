// RSS feed sources. Specific URLs to be verified in Task 6.5 before first cron run.

export interface FeedSource {
  name: string;
  url: string;
  category: 'regulatory' | 'industry' | 'news' | 'government' | 'weather';
  enabled: boolean;
}

export const FEEDS: FeedSource[] = [
  { name: 'Fair Work Australia',           url: 'https://www.fairwork.gov.au/about-us/news-and-media-releases.rss',          category: 'regulatory', enabled: true },
  { name: 'Master Plumbers AU',            url: 'https://www.masterplumbers.com.au/feed',                                     category: 'industry',   enabled: true },
  { name: 'Master Electricians AU',        url: 'https://www.masterelectricians.com.au/feed',                                 category: 'industry',   enabled: true },
  { name: 'Housing Industry Association',  url: 'https://hia.com.au/our-industry/newsroom/feed',                              category: 'industry',   enabled: true },
  { name: 'Master Builders AU',            url: 'https://masterbuilders.com.au/news/feed',                                    category: 'industry',   enabled: true },
  { name: 'ai.gov.au',                     url: 'https://www.ai.gov.au/news.rss',                                             category: 'government', enabled: true },
  { name: 'Business.gov.au',               url: 'https://business.gov.au/news/feed',                                          category: 'government', enabled: true },
  { name: 'BOM Severe Weather AU',         url: 'http://www.bom.gov.au/fwo/IDZ00056.warnings_national.xml',                   category: 'weather',    enabled: true }
];

// Note: each URL must be verified working before deploy via scripts/verify-feeds.mjs (Task 6.5).
// Use `enabled: false` to disable a feed without removing it.
