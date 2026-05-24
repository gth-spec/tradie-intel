// Content sources for the trades feed pipeline. Two source types:
//   - 'rss'    : parsed via rss-parser (src/lib/rss.ts)
//   - 'scrape' : fetched via Firecrawl + Claude extraction (src/lib/scrape.ts)
//
// Both produce the same downstream item shape (title, link, content, published_at),
// so the cron pipeline (Task 12) dispatches by type and enriches uniformly.
//
// Verify via scripts/verify-feeds.mjs (RSS) and scripts/verify-scrapes.mjs (scrape).

export type SourceType = 'rss' | 'scrape';
export type SourceCategory = 'regulatory' | 'industry' | 'news' | 'government' | 'weather';

export interface FeedSource {
  name: string;
  url: string;
  type: SourceType;
  category: SourceCategory;
  enabled: boolean;
}

export const FEEDS: FeedSource[] = [
  // ── RSS sources (verified 2026-05-23) ────────────────────────────────────
  { name: 'Master Plumbers AU',            url: 'https://www.masterplumbers.com.au/feed', type: 'rss', category: 'industry', enabled: true }, // 9 items

  // RSS sources that failed verification 2026-05-23 - kept as records, disabled.
  { name: 'Fair Work Australia',           url: 'https://www.fairwork.gov.au/about-us/news-and-media-releases.rss', type: 'rss', category: 'regulatory', enabled: false }, // FAILED (404)
  { name: 'Master Electricians AU',        url: 'https://www.masterelectricians.com.au/feed', type: 'rss', category: 'industry', enabled: false }, // FAILED (timeout)
  { name: 'Housing Industry Association',  url: 'https://hia.com.au/our-industry/newsroom/feed', type: 'rss', category: 'industry', enabled: false }, // FAILED (404)
  { name: 'Master Builders AU',            url: 'https://masterbuilders.com.au/news/feed', type: 'rss', category: 'industry', enabled: false }, // FAILED (0 items)
  { name: 'ai.gov.au',                     url: 'https://www.ai.gov.au/news.rss', type: 'rss', category: 'government', enabled: false }, // FAILED (404)
  { name: 'Business.gov.au',               url: 'https://business.gov.au/news/feed', type: 'rss', category: 'government', enabled: false }, // FAILED (404)
  { name: 'BOM Severe Weather AU',         url: 'http://www.bom.gov.au/fwo/IDZ00056.warnings_national.xml', type: 'rss', category: 'weather', enabled: false }, // FAILED (404)

  // ── RSS sources (added post-launch) ─────────────────────────────────────
  { name: 'Energy Magazine AU',            url: 'https://www.energymagazine.com.au/feed/', type: 'rss', category: 'industry', enabled: true }, // energy/electrical trades

  // ── Scrape sources (Firecrawl, verified in Task 6.7) ─────────────────────
  // Starter set covering categories the broken RSS feeds left empty.
  // Each is a news/index page that lists multiple recent articles.
  { name: 'Plumbing Connection',           url: 'https://plumbingconnection.com.au/news/',                  type: 'scrape', category: 'news',       enabled: false }, // BLOCKED: Cloudflare WAF 403
  { name: 'Electrical Connection',         url: 'https://electricalconnection.com.au/news/',                type: 'scrape', category: 'news',       enabled: false }, // BLOCKED: Cloudflare WAF 403
  { name: 'Sourceable',                    url: 'https://sourceable.net/',                                  type: 'scrape', category: 'news',       enabled: true },
  { name: 'HIA News',                      url: 'https://hia.com.au/our-industry/newsroom',                 type: 'scrape', category: 'industry',   enabled: true },
  { name: 'Master Builders AU News',       url: 'https://masterbuilders.com.au/Newsroom',                   type: 'scrape', category: 'industry',   enabled: true },
  { name: 'Fair Work Ombudsman News',      url: 'https://www.fairwork.gov.au/about-us/news-and-media-releases', type: 'scrape', category: 'regulatory', enabled: true },
  { name: 'Safe Work Australia News',      url: 'https://www.safeworkaustralia.gov.au/media-centre',        type: 'scrape', category: 'regulatory', enabled: true },
  { name: 'ABCC News',                     url: 'https://www.abcc.gov.au/news-and-media',                   type: 'scrape', category: 'regulatory', enabled: false } // DEFUNCT: ABCC abolished 2022, domain dead
];

// Note: Use `enabled: false` to disable a source without removing it.
// Scrape sources need a working FIRECRAWL_API_KEY env var at runtime.
