import { describe, it, expect } from 'vitest';
import { parseFeedXml } from '@/lib/rss';

const SAMPLE_RSS = `<?xml version="1.0"?>
<rss version="2.0">
<channel>
  <title>Sample Feed</title>
  <item>
    <title>Story One</title>
    <link>https://example.com/one</link>
    <pubDate>Mon, 22 May 2026 06:00:00 +1000</pubDate>
    <description>Summary one</description>
  </item>
  <item>
    <title>Story Two</title>
    <link>https://example.com/two</link>
    <pubDate>Mon, 22 May 2026 07:00:00 +1000</pubDate>
    <description>Summary two</description>
  </item>
</channel>
</rss>`;

describe('parseFeedXml', () => {
  it('returns array of items with normalised fields', async () => {
    const items = await parseFeedXml(SAMPLE_RSS);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: 'Story One',
      url: 'https://example.com/one',
      content: 'Summary one'
    });
    expect(items[0].publishedAt).toBeInstanceOf(Date);
  });

  it('handles missing description', async () => {
    const xml = SAMPLE_RSS.replace(/<description>[^<]+<\/description>/g, '');
    const items = await parseFeedXml(xml);
    expect(items[0].content).toBe('');
  });
});
