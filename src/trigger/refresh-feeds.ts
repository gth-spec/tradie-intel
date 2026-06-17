import { schedules, task, logger } from "@trigger.dev/sdk";
import { FEEDS } from "@/config/feeds";
import { adminClient } from "@/lib/supabase";
import { SITE } from "@/config/site";
import { fetchFeedTask } from "./fetch-feed";
import { enrichItemTask, type EnrichItemPayload } from "./enrich-item";

// Orchestrator. Replaces src/pages/api/cron/refresh-feeds.ts.
//
// Two entry points share one orchestrate() function:
//   - refreshFeedsSchedule : the cron (always dryRun=false)
//   - refreshFeedsTask     : manually triggerable with { dryRun } for safe testing
//
// Flow:
//   1. Load enabled feeds + existing URLs (dedupe set) from Supabase.
//   2. Fan out one fetch-feed run per feed (batchTriggerAndWait).
//   3. Dedupe, age-filter, and cap the combined items.
//   4. dryRun -> report would-enrich counts only (no writes, no Claude spend).
//      live   -> fan out one enrich-item run per surviving item.
//
// What Trigger.dev gives us that the old hand-rolled version did not:
//   - per-feed / per-item retries + visible failed runs in the dashboard
//   - no function-timeout ceiling on the Claude enrich step
//   - the Promise.allSettled / summary bookkeeping disappears

const MAX_NEW_ITEMS_PER_RUN = 30;
const MAX_AGE_DAYS = 14;

interface RefreshSummary {
  dryRun: boolean;
  feeds: number;
  feedsFailed: number;
  newItems: number;
  inserted: number;
  failed: number;
  perFeed: { name: string; ok: boolean; newItems: number }[];
}

async function orchestrate(dryRun: boolean): Promise<RefreshSummary> {
  const enabledFeeds = FEEDS.filter((f) => f.enabled);

  // Dedupe set: URLs already in the table for this niche.
  const supa = adminClient();
  const { data, error } = await supa
    .from("feed_items")
    .select("original_url")
    .eq("niche", SITE.niche);
  if (error) throw new Error(`Failed to load existing URLs: ${error.message}`);
  const existing = new Set<string>(
    (data ?? []).map((r: { original_url: string }) => r.original_url)
  );

  // Fan out: one fetch-feed run per feed. Results are order-aligned to input.
  const fetchResults = await fetchFeedTask.batchTriggerAndWait(
    enabledFeeds.map((feed) => ({ payload: { feed } }))
  );

  // Gather -> dedupe -> age-filter -> cap.
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const toEnrich: { payload: EnrichItemPayload }[] = [];
  const perFeed: RefreshSummary["perFeed"] = [];
  let feedsFailed = 0;
  let remaining = MAX_NEW_ITEMS_PER_RUN;

  fetchResults.runs.forEach((result, idx) => {
    const feed = enabledFeeds[idx];
    if (!result.ok) {
      feedsFailed++;
      perFeed.push({ name: feed.name, ok: false, newItems: 0 });
      logger.error(`fetch-feed failed for ${feed.name}`, { error: result.error });
      return;
    }
    let feedNew = 0;
    for (const item of result.output) {
      if (remaining <= 0) break;
      if (existing.has(item.url)) continue;
      if (new Date(item.publishedAt).getTime() < cutoff) continue;
      existing.add(item.url);
      toEnrich.push({ payload: { ...item, feedName: feed.name, feedUrl: feed.url } });
      remaining--;
      feedNew++;
    }
    perFeed.push({ name: feed.name, ok: true, newItems: feedNew });
  });

  // Dry run: report what WOULD be enriched, no writes, no Claude spend.
  if (dryRun) {
    logger.log("refresh-feeds DRY RUN", {
      feeds: enabledFeeds.length,
      feedsFailed,
      wouldEnrich: toEnrich.length,
      perFeed,
    });
    return {
      dryRun: true,
      feeds: enabledFeeds.length,
      feedsFailed,
      newItems: toEnrich.length,
      inserted: 0,
      failed: 0,
      perFeed,
    };
  }

  if (toEnrich.length === 0) {
    logger.log("refresh-feeds: no new items to enrich", { feeds: enabledFeeds.length });
    return {
      dryRun: false,
      feeds: enabledFeeds.length,
      feedsFailed,
      newItems: 0,
      inserted: 0,
      failed: 0,
      perFeed,
    };
  }

  // Fan out: one enrich-item run per new item.
  const enrichResults = await enrichItemTask.batchTriggerAndWait(toEnrich);
  const inserted = enrichResults.runs.filter((r) => r.ok).length;
  const failed = enrichResults.runs.filter((r) => !r.ok).length;

  logger.log("refresh-feeds complete", {
    feeds: enabledFeeds.length,
    feedsFailed,
    newItems: toEnrich.length,
    inserted,
    failed,
  });

  return {
    dryRun: false,
    feeds: enabledFeeds.length,
    feedsFailed,
    newItems: toEnrich.length,
    inserted,
    failed,
    perFeed,
  };
}

// Manual entry point for testing: trigger with { dryRun: true } for a safe baseline.
export const refreshFeedsTask = task({
  id: "refresh-feeds",
  maxDuration: 1800,
  run: async (payload: { dryRun?: boolean } = {}) => orchestrate(payload.dryRun ?? false),
});

// Cron entry point: always a live run. 23:30 UTC = 09:30 AEST (matches old Vercel cron).
export const refreshFeedsSchedule = schedules.task({
  id: "refresh-feeds-schedule",
  cron: "30 23 * * *",
  maxDuration: 1800,
  run: async () => orchestrate(false),
});
