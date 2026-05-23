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

function firecrawlOk(markdown: string) {
  return new Response(
    JSON.stringify({ success: true, data: { markdown } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

describe('scrapeSource', () => {
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
    // Default env
    vi.stubEnv('FIRECRAWL_API_KEY', 'fc-test');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('CLAUDE_MODEL', 'claude-test-model');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('returns [] and warns when FIRECRAWL_API_KEY is missing', async () => {
    vi.stubEnv('FIRECRAWL_API_KEY', '');
    const { scrapeSource } = await import('@/lib/scrape');
    const result = await scrapeSource(SOURCE);
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls Firecrawl with correct URL, formats, and headers', async () => {
    fetchMock.mockResolvedValueOnce(firecrawlOk('# news\n- article a'));
    mockCreate.mockResolvedValueOnce(claudeResponse([]));
    const { scrapeSource } = await import('@/lib/scrape');
    await scrapeSource(SOURCE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.firecrawl.dev/v1/scrape');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer fc-test');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.url).toBe(SOURCE.url);
    expect(body.formats).toEqual(['markdown']);
    expect(body.onlyMainContent).toBe(true);
  });

  it('returns [] on Firecrawl non-200 response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 502 }));
    const { scrapeSource } = await import('@/lib/scrape');
    const result = await scrapeSource(SOURCE);
    expect(result).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('calls Claude with the scraped markdown', async () => {
    const markdown = '# News page\n\n- Item one\n- Item two';
    fetchMock.mockResolvedValueOnce(firecrawlOk(markdown));
    mockCreate.mockResolvedValueOnce(claudeResponse([]));
    const { scrapeSource } = await import('@/lib/scrape');
    await scrapeSource(SOURCE);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const arg = mockCreate.mock.calls[0][0];
    expect(arg.model).toBe('claude-test-model');
    const userMessage = arg.messages.find((m: any) => m.role === 'user');
    const userContent = typeof userMessage.content === 'string'
      ? userMessage.content
      : userMessage.content.map((c: any) => c.text).join('');
    expect(userContent).toContain(markdown);
  });

  it("parses Claude's JSON response into ScrapedItem[]", async () => {
    fetchMock.mockResolvedValueOnce(firecrawlOk('markdown'));
    mockCreate.mockResolvedValueOnce(
      claudeResponse([
        {
          title: 'New plumbing licence rules',
          link: 'https://plumbingconnection.com.au/news/article-1/',
          published_at: '2026-05-20T00:00:00Z',
          content: 'Short excerpt about plumbing licensing.'
        }
      ])
    );
    const { scrapeSource } = await import('@/lib/scrape');
    const result = await scrapeSource(SOURCE);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source: 'Plumbing Connection',
      source_url: SOURCE.url,
      title: 'New plumbing licence rules',
      link: 'https://plumbingconnection.com.au/news/article-1/',
      content: 'Short excerpt about plumbing licensing.'
    });
    expect(result[0].published_at).toBeInstanceOf(Date);
  });

  it('resolves relative URLs to absolute', async () => {
    fetchMock.mockResolvedValueOnce(firecrawlOk('markdown'));
    mockCreate.mockResolvedValueOnce(
      claudeResponse([
        {
          title: 'Relative link article',
          link: '/news/relative-article/',
          published_at: '2026-05-21T00:00:00Z',
          content: 'excerpt'
        }
      ])
    );
    const { scrapeSource } = await import('@/lib/scrape');
    const result = await scrapeSource(SOURCE);
    expect(result[0].link).toBe('https://plumbingconnection.com.au/news/relative-article/');
  });

  it('caps content excerpts at 500 chars', async () => {
    fetchMock.mockResolvedValueOnce(firecrawlOk('markdown'));
    const longContent = 'a'.repeat(1200);
    mockCreate.mockResolvedValueOnce(
      claudeResponse([
        {
          title: 'Long content article',
          link: 'https://plumbingconnection.com.au/news/long/',
          published_at: '2026-05-21T00:00:00Z',
          content: longContent
        }
      ])
    );
    const { scrapeSource } = await import('@/lib/scrape');
    const result = await scrapeSource(SOURCE);
    expect(result[0].content.length).toBe(500);
  });

  it('returns [] on Claude JSON parse failure', async () => {
    fetchMock.mockResolvedValueOnce(firecrawlOk('markdown'));
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'this is not json at all' }]
    });
    const { scrapeSource } = await import('@/lib/scrape');
    const result = await scrapeSource(SOURCE);
    expect(result).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('propagates AbortSignal to fetch', async () => {
    fetchMock.mockResolvedValueOnce(firecrawlOk('markdown'));
    mockCreate.mockResolvedValueOnce(claudeResponse([]));
    const controller = new AbortController();
    const { scrapeSource } = await import('@/lib/scrape');
    await scrapeSource(SOURCE, { signal: controller.signal });
    const init = fetchMock.mock.calls[0][1];
    expect(init.signal).toBe(controller.signal);
  });
});
