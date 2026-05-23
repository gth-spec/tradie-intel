// Firecrawl + Claude scrape adapter for non-RSS content sources.
//
// Two-step pipeline per source:
//   1. POST the index URL to Firecrawl /v1/scrape -> get cleaned markdown.
//   2. Send the markdown to Claude with an extraction prompt -> JSON list of articles.
//
// Returns the same shape as the (forthcoming) RSS adapter so the cron pipeline
// can treat both uniformly. Never throws on operational failure - logs and
// returns [] so a single broken source can't take down the run.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { FeedSource } from '@/config/feeds';

export interface ScrapedItem {
  source: string;
  source_url: string;
  title: string;
  link: string;
  content: string;
  published_at: Date;
}

const CONTENT_CAP = 500;
const FIRECRAWL_ENDPOINT = 'https://api.firecrawl.dev/v1/scrape';
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
  // Astro exposes secrets via import.meta.env at runtime; tests use process.env.
  const fromMeta = (import.meta as any).env?.[key];
  if (fromMeta) return fromMeta;
  return process.env[key];
}

export async function scrapeSource(
  source: FeedSource,
  opts: { signal?: AbortSignal } = {}
): Promise<ScrapedItem[]> {
  const firecrawlKey = env('FIRECRAWL_API_KEY');
  if (!firecrawlKey) {
    console.warn(`[scrape] FIRECRAWL_API_KEY missing - skipping ${source.name}`);
    return [];
  }

  // Step 1: Firecrawl scrape
  let markdown: string;
  try {
    const res = await fetch(FIRECRAWL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${firecrawlKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: source.url,
        formats: ['markdown'],
        onlyMainContent: true
      }),
      signal: opts.signal
    });

    if (!res.ok) {
      console.error(`[scrape] Firecrawl ${res.status} for ${source.name} (${source.url})`);
      return [];
    }

    const json: any = await res.json();
    markdown = json?.data?.markdown ?? '';
    if (!markdown) {
      console.error(`[scrape] Firecrawl returned empty markdown for ${source.name}`);
      return [];
    }
  } catch (err) {
    console.error(`[scrape] Firecrawl error for ${source.name}:`, err);
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
    console.error(`[scrape] Claude error for ${source.name}:`, err);
    return [];
  }

  // Parse + validate Claude's JSON
  let parsed: z.infer<typeof ExtractionResponseSchema>;
  try {
    const stripped = stripCodeFences(rawText).trim();
    const json = JSON.parse(stripped);
    parsed = ExtractionResponseSchema.parse(json);
  } catch (err) {
    console.error(`[scrape] Failed to parse Claude response for ${source.name}:`, err);
    return [];
  }

  // Normalise: absolute URLs, capped content, Date parsing
  const items: ScrapedItem[] = [];
  for (const article of parsed) {
    let absoluteLink: string;
    try {
      absoluteLink = new URL(article.link, source.url).href;
    } catch {
      continue; // skip malformed link
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
  // Strip ```json ... ``` or ``` ... ``` wrappers if Claude included them.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1] : text;
}
