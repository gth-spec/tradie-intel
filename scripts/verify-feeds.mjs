#!/usr/bin/env node
// Verify each RSS feed in src/config/feeds.ts. Exits non-zero if any fail.
// Inline copy of FEEDS for verification only. Canonical list is in src/config/feeds.ts.

import Parser from 'rss-parser';

const FEEDS = [
  { name: 'Fair Work Australia',          url: 'https://www.fairwork.gov.au/about-us/news-and-media-releases.rss' },
  { name: 'Master Plumbers AU',           url: 'https://www.masterplumbers.com.au/feed' },
  { name: 'Master Electricians AU',       url: 'https://www.masterelectricians.com.au/feed' },
  { name: 'Housing Industry Association', url: 'https://hia.com.au/our-industry/newsroom/feed' },
  { name: 'Master Builders AU',           url: 'https://masterbuilders.com.au/news/feed' },
  { name: 'ai.gov.au',                    url: 'https://www.ai.gov.au/news.rss' },
  { name: 'Business.gov.au',              url: 'https://business.gov.au/news/feed' },
  { name: 'BOM Severe Weather AU',        url: 'http://www.bom.gov.au/fwo/IDZ00056.warnings_national.xml' }
];

const parser = new Parser({ timeout: 15_000 });
const results = [];

for (const feed of FEEDS) {
  const start = Date.now();
  try {
    const data = await parser.parseURL(feed.url);
    const itemCount = (data.items ?? []).length;
    const sample = data.items?.[0] ?? {};
    const hasTitle = typeof sample.title === 'string';
    const hasLink = typeof sample.link === 'string';
    const hasDate = !!(sample.isoDate || sample.pubDate);
    results.push({
      name: feed.name, ok: true, items: itemCount,
      hasTitle, hasLink, hasDate, ms: Date.now() - start
    });
  } catch (err) {
    results.push({
      name: feed.name, ok: false,
      error: err.message?.slice(0, 80), ms: Date.now() - start
    });
  }
}

console.table(results);

const broken = results.filter(r => !r.ok || r.items === 0);
if (broken.length > 0) {
  console.error(`\n${broken.length} feed(s) failed or returned 0 items. Disable them in src/config/feeds.ts (enabled: false).`);
  console.error('Broken:', broken.map(b => b.name).join(', '));
  process.exit(1);
}
console.log('\nAll feeds healthy.');
