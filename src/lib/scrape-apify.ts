// Apify fallback scrape adapter.
//
// Used only when the primary Firecrawl adapter (src/lib/scrape.ts) returns
// zero items or throws. Hits Apify's website-content-crawler actor for a
// single-page synchronous crawl, then runs the same Claude extraction prompt
// as scrape.ts to convert the page markdown into ScrapedItem[].
//
// Free-tier safe: caller is responsible for only invoking this on Firecrawl
// failure. Same defensive coding as scrape.ts - never throws, returns [] and
// logs on any operational failure.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { FeedSource } from '@/config/feeds';
import { type ScrapedItem } from '@/lib/scrape';

const CONTENT_CAP = 500;
const APIFY_ENDPOINT =
  'https://api.apify.com/v2/acts/apify~website-content-crawler/run-sync-get-dataset-items';
const DEFAULT_MODEL = 'claude-sonnet-4-5';

const ExtractedArticleSchema = z.object({
  title: z.string().min(1),
  link: z.string().min(1),
  published_at: z.string().min(1),
  content: z.string().default('')
});

const ExtractionResponseSchema = z.array(ExtractedArticleSchema);

const EXTRACTION_PROMPT = `You are extracting recent news articles from a scraped news/index page for an Australian trades industry feed (plumbers, electricians, builders, allied trades).

Return a JSON array of articles found on this page. Each article must have:
- title: the article headline
- link: the URL to the full article (absolute or root-relative)
- published_at: publication date as an ISO 8601 string (best estimate if only a date is shown; if no date is visible at all, use today's date)
- content: a short excerpt or summary from the page (max ~400 chars)

Only include items that look like genuine recent news articles, regulatory updates, industry announcements, or licensing/safety/workplace bulletins relevant to Australian trades or construction. Exclude navigation links, login links, category pages, generic "about us" links, ads, and event/registration links.

Respond with ONLY a valid JSON array - no prose, no markdown code fences. If no relevant articles are present, respond with [].

Page markdown:
---
{{MARKDOWN}}
---`;

function env(key: string): string | undefined {
  const fromMeta = (import.meta as any).env?.[key];
  if (fromMeta) return fromMeta;
  return process.env[key];
}

export async function scrapeSourceApify(
  source: FeedSource,
  opts: { signal?: AbortSignal } = {}
): Promise<ScrapedItem[]> {
  const apifyToken = env('APIFY_TOKEN');
  if (!apifyToken) {
    console.warn(`[scrape-apify] APIFY_TOKEN missing - skipping ${source.name}`);
    return [];
  }

  // Step 1: Apify run-sync (single page crawl)
  let markdown: string;
  try {
    const res = await fetch(
      `${APIFY_ENDPOINT}?token=${apifyToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startUrls: [{ url: source.url }],
          maxCrawlDepth: 0,
          maxCrawlPages: 1,
          saveMarkdown: true,
          saveHtml: false
        }),
        signal: opts.signal
      }
    );

    if (!res.ok) {
      console.error(`[scrape-apify] Apify ${res.status} for ${source.name} (${source.url})`);
      return [];
    }

    const items: any = await res.json();
    if (!Array.isArray(items) || items.length === 0) {
      // Legitimate empty result - silent.
      return [];
    }
    markdown = items[0]?.markdown ?? '';
    if (!markdown) {
      console.error(`[scrape-apify] Apify returned empty markdown for ${source.name}`);
      return [];
    }
  } catch (err) {
    console.error(`[scrape-apify] Apify error for ${source.name}:`, err);
    return [];
  }

  // Step 2: Claude extraction
  let rawText: string;
  try {
    const anthropic = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') });
    const model = env('CLAUDE_MODEL') || DEFAULT_MODEL;
    const response: any = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: EXTRACTION_PROMPT.replace('{{MARKDOWN}}', markdown)
        }
      ]
    });
    const textBlock = response.content?.find((b: any) => b.type === 'text');
    rawText = textBlock?.text ?? '';
  } catch (err) {
    console.error(`[scrape-apify] Claude error for ${source.name}:`, err);
    return [];
  }

  let parsed: z.infer<typeof ExtractionResponseSchema>;
  try {
    const stripped = stripCodeFences(rawText).trim();
    const json = JSON.parse(stripped);
    parsed = ExtractionResponseSchema.parse(json);
  } catch (err) {
    console.error(`[scrape-apify] Failed to parse Claude response for ${source.name}:`, err);
    return [];
  }

  const items: ScrapedItem[] = [];
  for (const article of parsed) {
    let absoluteLink: string;
    try {
      absoluteLink = new URL(article.link, source.url).href;
    } catch {
      continue;
    }

    const publishedAt = new Date(article.published_at);
    const safePublishedAt = isNaN(publishedAt.getTime()) ? new Date() : publishedAt;

    items.push({
      source: source.name,
      source_url: source.url,
      title: article.title,
      link: absoluteLink,
      content: (article.content ?? '').slice(0, CONTENT_CAP),
      published_at: safePublishedAt
    });
  }

  return items;
}

function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1] : text;
}
