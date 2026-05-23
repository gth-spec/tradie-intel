import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FeedSource } from '@/config/feeds';

// Mock the Anthropic SDK before importing the module under test.
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class Anthropic {
      messages = { create: mockCreate };
      constructor(_opts: any) {}
    }
  };
});

const SOURCE: FeedSource = {
  name: 'Plumbing Connection',
  url: 'https://plumbingconnection.com.au/news/',
  type: 'scrape',
  category: 'news',
  enabled: true
};

function claudeResponse(items: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(items) }]
  };
}

function apifyOk(items: unknown[]) {
  return new Response(JSON.stringify(items), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('scrapeSourceApify', () => {
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    mockCreate.mockReset();
    fetchMock = vi.fn();
    global.fetch = fetchMock as any;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('APIFY_TOKEN', 'apify-test-token');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('CLAUDE_MODEL', 'claude-test-model');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('returns [] and warns when APIFY_TOKEN is missing', async () => {
    vi.stubEnv('APIFY_TOKEN', '');
    const { scrapeSourceApify } = await import('@/lib/scrape-apify');
    const result = await scrapeSourceApify(SOURCE);
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs to the correct Apify URL with token query param', async () => {
    fetchMock.mockResolvedValueOnce(apifyOk([{ markdown: '# news', url: SOURCE.url, pageTitle: 't' }]));
    mockCreate.mockResolvedValueOnce(claudeResponse([]));
    const { scrapeSourceApify } = await import('@/lib/scrape-apify');
    await scrapeSourceApify(SOURCE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.apify.com/v2/acts/apify~website-content-crawler/run-sync-get-dataset-items?token=apify-test-token'
    );
    expect(init.method).toBe('POST');
  });

  it('sends the correct request body shape', async () => {
    fetchMock.mockResolvedValueOnce(apifyOk([{ markdown: '# news', url: SOURCE.url, pageTitle: 't' }]));
    mockCreate.mockResolvedValueOnce(claudeResponse([]));
    const { scrapeSourceApify } = await import('@/lib/scrape-apify');
    await scrapeSourceApify(SOURCE);
    const init = fetchMock.mock.calls[0][1];
    const body = JSON.parse(init.body);
    expect(body.startUrls).toEqual([{ url: SOURCE.url }]);
    expect(body.maxCrawlDepth).toBe(0);
    expect(body.maxCrawlPages).toBe(1);
    expect(body.saveMarkdown).toBe(true);
    expect(body.saveHtml).toBe(false);
  });

  it('returns [] when Apify responds non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('err', { status: 500 }));
    const { scrapeSourceApify } = await import('@/lib/scrape-apify');
    const result = await scrapeSourceApify(SOURCE);
    expect(result).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns [] when Apify returns empty dataset', async () => {
    fetchMock.mockResolvedValueOnce(apifyOk([]));
    const { scrapeSourceApify } = await import('@/lib/scrape-apify');
    const result = await scrapeSourceApify(SOURCE);
    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("passes the dataset item's markdown to Claude", async () => {
    const markdown = '# Apify scraped page\n- item A';
    fetchMock.mockResolvedValueOnce(apifyOk([{ markdown, url: SOURCE.url, pageTitle: 't' }]));
    mockCreate.mockResolvedValueOnce(claudeResponse([]));
    const { scrapeSourceApify } = await import('@/lib/scrape-apify');
    await scrapeSourceApify(SOURCE);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const arg = mockCreate.mock.calls[0][0];
    const userMessage = arg.messages.find((m: any) => m.role === 'user');
    const userContent = typeof userMessage.content === 'string'
      ? userMessage.content
      : userMessage.content.map((c: any) => c.text).join('');
    expect(userContent).toContain(markdown);
  });

  it("returns ScrapedItem array parsed from Claude's JSON response", async () => {
    fetchMock.mockResolvedValueOnce(apifyOk([{ markdown: 'md', url: SOURCE.url, pageTitle: 't' }]));
    mockCreate.mockResolvedValueOnce(
      claudeResponse([
        {
          title: 'Apify pulled article',
          link: 'https://plumbingconnection.com.au/news/apify-1/',
          published_at: '2026-05-20T00:00:00Z',
          content: 'Excerpt.'
        }
      ])
    );
    const { scrapeSourceApify } = await import('@/lib/scrape-apify');
    const result = await scrapeSourceApify(SOURCE);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source: 'Plumbing Connection',
      source_url: SOURCE.url,
      title: 'Apify pulled article',
      link: 'https://plumbingconnection.com.au/news/apify-1/',
      content: 'Excerpt.'
    });
    expect(result[0].published_at).toBeInstanceOf(Date);
  });

  it('resolves relative link URLs to absolute using source.url', async () => {
    fetchMock.mockResolvedValueOnce(apifyOk([{ markdown: 'md', url: SOURCE.url, pageTitle: 't' }]));
    mockCreate.mockResolvedValueOnce(
      claudeResponse([
        {
          title: 'Relative',
          link: '/news/rel/',
          published_at: '2026-05-21T00:00:00Z',
          content: 'x'
        }
      ])
    );
    const { scrapeSourceApify } = await import('@/lib/scrape-apify');
    const result = await scrapeSourceApify(SOURCE);
    expect(result[0].link).toBe('https://plumbingconnection.com.au/news/rel/');
  });

  it('caps content at 500 chars', async () => {
    fetchMock.mockResolvedValueOnce(apifyOk([{ markdown: 'md', url: SOURCE.url, pageTitle: 't' }]));
    const longContent = 'b'.repeat(1500);
    mockCreate.mockResolvedValueOnce(
      claudeResponse([
        {
          title: 'Long',
          link: 'https://plumbingconnection.com.au/news/long/',
          published_at: '2026-05-21T00:00:00Z',
          content: longContent
        }
      ])
    );
    const { scrapeSourceApify } = await import('@/lib/scrape-apify');
    const result = await scrapeSourceApify(SOURCE);
    expect(result[0].content.length).toBe(500);
  });

  it('propagates AbortSignal to fetch', async () => {
    fetchMock.mockResolvedValueOnce(apifyOk([{ markdown: 'md', url: SOURCE.url, pageTitle: 't' }]));
    mockCreate.mockResolvedValueOnce(claudeResponse([]));
    const controller = new AbortController();
    const { scrapeSourceApify } = await import('@/lib/scrape-apify');
    await scrapeSourceApify(SOURCE, { signal: controller.signal });
    const init = fetchMock.mock.calls[0][1];
    expect(init.signal).toBe(controller.signal);
  });
});
