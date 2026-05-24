import Parser from 'rss-parser';

// Use a browser-like UA - some feeds (e.g. Energy Magazine) block bot-identified crawlers.
const RSS_UA = 'Mozilla/5.0 (compatible; TradieIntel/1.0; +https://tradieintel.com.au)';

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': RSS_UA }
});

export interface RssItem {
  title: string;
  url: string;
  content: string;
  publishedAt: Date;
}

export async function parseFeedXml(xml: string): Promise<RssItem[]> {
  const feed = await parser.parseString(xml);
  return (feed.items ?? [])
    .filter(i => i.title && i.link)
    .map(i => ({
      title: i.title!.trim(),
      url: i.link!.trim(),
      content: (i.contentSnippet ?? i.content ?? '').trim(),
      publishedAt: i.isoDate ? new Date(i.isoDate) : new Date()
    }));
}

export async function fetchFeed(url: string, opts?: { signal?: AbortSignal }): Promise<RssItem[]> {
  const res = await fetch(url, {
    headers: { 'User-Agent': RSS_UA },
    signal: opts?.signal
  });
  if (!res.ok) throw new Error(`Feed ${url} returned HTTP ${res.status}`);
  const xml = await res.text();
  return parseFeedXml(xml);
}
