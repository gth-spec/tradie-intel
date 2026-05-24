import type { APIRoute } from 'astro';
import { FEEDS, type FeedSource } from '@/config/feeds';
import { fetchFeed, type RssItem } from '@/lib/rss';
import { scrapeSource, type ScrapedItem } from '@/lib/scrape';
import { scrapeSourceApify } from '@/lib/scrape-apify';
import { enrich } from '@/lib/claude';
import { adminClient } from '@/lib/supabase';
import { titleToSlug } from '@/lib/slug';
import { SITE } from '@/config/site';

export const prerender = false;

// Operational caps - guardrails against runaway costs and stale data.
const MAX_NEW_ITEMS_PER_RUN = 30;
const MAX_AGE_DAYS = 14;
const PER_FEED_TIMEOUT_MS = 20_000;

interface IngestedItem {
  title: string;
  url: string;
  content: string;
  publishedAt: Date;
}

export function authoriseCron(req: Request, secret: string): boolean {
  const auth = req.headers.get('authorization') ?? '';
  return auth === `Bearer ${secret}`;
}

export function dedupeAgainstExisting<T extends { url: string }>(items: T[], existing: Set<string>): T[] {
  return items.filter(i => !existing.has(i.url));
}

export function withinMaxAge(publishedAt: Date, maxAgeDays = MAX_AGE_DAYS): boolean {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  return publishedAt.getTime() >= cutoff;
}

interface FetchSourceSummary {
  apify_fallback_calls: number;
}

async function fetchSource(
  source: FeedSource,
  signal: AbortSignal,
  cronSummary: FetchSourceSummary = { apify_fallback_calls: 0 }
): Promise<IngestedItem[]> {
  if (source.type === 'rss') {
    const items = await fetchFeed(source.url, { signal });
    return items.map((i: RssItem) => ({
      title: i.title, url: i.url, content: i.content, publishedAt: i.publishedAt
    }));
  }
  if (source.type === 'scrape') {
    let items: ScrapedItem[] = [];
    let firecrawlError: unknown = null;

    try {
      items = await scrapeSource(source, { signal });
    } catch (err) {
      firecrawlError = err;
      console.warn(
        `Firecrawl failed for ${source.name}:`,
        err instanceof Error ? err.message : err
      );
    }

    if (items.length === 0) {
      console.log(
        `[apify-fallback] ${source.name} - Firecrawl returned 0 items${firecrawlError ? ' (after error)' : ''}, trying Apify`
      );
      const fallback = await scrapeSourceApify(source, { signal });
      if (fallback.length > 0) {
        cronSummary.apify_fallback_calls++;
        items = fallback;
      }
    }

    return items.map((i: ScrapedItem) => ({
      title: i.title, url: i.link, content: i.content, publishedAt: i.published_at
    }));
  }
  return [];
}

async function getExistingUrls(): Promise<Set<string>> {
  const supa = adminClient();
  const { data, error } = await supa
    .from('feed_items')
    .select('original_url')
    .eq('niche', SITE.niche);
  if (error) throw error;
  return new Set((data ?? []).map((r: { original_url: string }) => r.original_url));
}

interface InsertRow {
  source: string;
  source_url: string;
  original_url: string;
  title: string;
  original_content: string;
  published_at: string;
  niche: string;
  ai_summary: string;
  why_it_matters: string;
  relevance_score: number;
  tags: string[];
  slug: string;
  question_headline: string | null;
  key_stat: string | null;
  key_quote: string | null;
  key_takeaways: string[];
}

export async function processItem(item: IngestedItem, feedName: string, feedUrl: string): Promise<InsertRow | null> {
  try {
    const enr = await enrich({ title: item.title, content: item.content });
    return {
      source: feedName,
      source_url: feedUrl,
      original_url: item.url,
      title: item.title,
      original_content: item.content.slice(0, 500),
      published_at: item.publishedAt.toISOString(),
      niche: SITE.niche,
      ai_summary: enr.summary,
      why_it_matters: enr.whyItMatters,
      relevance_score: enr.relevanceScore,
      tags: enr.tags,
      slug: titleToSlug(item.title, item.url.slice(-6).replace(/[^a-z0-9]/gi, '')),
      question_headline: enr.questionHeadline,
      key_stat: enr.keyStat,
      key_quote: enr.keyQuote,
      key_takeaways: enr.keyTakeaways
    };
  } catch (err) {
    console.error('Enrichment failed for', item.url, err);
    return null;
  }
}

async function insertWithSlugRetry(supa: ReturnType<typeof adminClient>, row: InsertRow): Promise<{ ok: boolean; error?: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = attempt === 0 ? row.slug : `${row.slug}-${attempt + 1}`;
    const { error } = await supa.from('feed_items').upsert(
      { ...row, slug: candidate },
      { onConflict: 'niche,original_url' }
    );
    if (!error) return { ok: true };
    if (!/duplicate key|unique constraint/i.test(error.message ?? '')) {
      return { ok: false, error: error.message };
    }
  }
  return { ok: false, error: 'slug collision after 5 attempts' };
}

export const GET: APIRoute = async ({ request, url }) => {
  const secret = (import.meta.env.CRON_SECRET ?? process.env.CRON_SECRET ?? '') as string;
  if (!authoriseCron(request, secret)) {
    return new Response('Unauthorised', { status: 401 });
  }

  const dryRun = url.searchParams.get('dryRun') === '1';
  const backfill = url.searchParams.get('backfill') === '1';

  const existing = await getExistingUrls();
  const supa = adminClient();

  const summary = {
    started_at: new Date().toISOString(),
    dry_run: dryRun,
    feeds_processed: 0,
    items_fetched: 0,
    items_skipped_existing: 0,
    items_skipped_age: 0,
    items_new: 0,
    items_inserted: 0,
    items_errored: 0,
    capped_at_max: false,
    apify_fallback_calls: 0,
    per_feed: [] as Array<{ name: string; type: string; ok: boolean; error?: string; new_items?: number }>
  };

  const enabledFeeds = FEEDS.filter(f => f.enabled);

  // Fetch all feeds in parallel - eliminates sequential wait time.
  // Each feed gets its own timeout signal so a slow source can't block others.
  const feedResults = await Promise.allSettled(
    enabledFeeds.map(async feed => {
      const items = await fetchSource(feed, AbortSignal.timeout(PER_FEED_TIMEOUT_MS), summary);
      return { feed, items };
    })
  );

  // Apply cap and insert sequentially (preserves deterministic cap behaviour).
  let remainingCap = MAX_NEW_ITEMS_PER_RUN;

  for (const result of feedResults) {
    summary.feeds_processed++;

    if (result.status === 'rejected') {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      summary.items_errored++;
      // Find the corresponding feed for error reporting
      const idx = feedResults.indexOf(result);
      const feed = enabledFeeds[idx];
      summary.per_feed.push({ name: feed?.name ?? 'unknown', type: feed?.type ?? 'unknown', ok: false, error: message });
      console.error('Feed failed:', message);
      continue;
    }

    const { feed, items } = result.value;

    if (remainingCap <= 0) {
      summary.capped_at_max = true;
      summary.per_feed.push({ name: feed.name, type: feed.type, ok: true, new_items: 0 });
      continue;
    }

    summary.items_fetched += items.length;

    const fresh = dedupeAgainstExisting(items, existing);
    summary.items_skipped_existing += items.length - fresh.length;

    const withinAge = backfill ? fresh : fresh.filter(i => withinMaxAge(i.publishedAt));
    summary.items_skipped_age += fresh.length - withinAge.length;

    const capped = withinAge.slice(0, remainingCap);
    summary.items_new += capped.length;
    remainingCap -= capped.length;

    for (const item of capped) {
      const row = await processItem(item, feed.name, feed.url);
      if (!row) { summary.items_errored++; continue; }
      if (dryRun) { summary.items_inserted++; continue; }
      const res = await insertWithSlugRetry(supa, row);
      if (res.ok) { summary.items_inserted++; existing.add(item.url); }
      else { summary.items_errored++; console.error('Insert failed', res.error); }
    }

    summary.per_feed.push({ name: feed.name, type: feed.type, ok: true, new_items: capped.length });
  }

  return new Response(JSON.stringify(summary), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
};
