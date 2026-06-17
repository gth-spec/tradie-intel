import { task } from "@trigger.dev/sdk";
import { enrich } from "@/lib/claude";
import { adminClient } from "@/lib/supabase";
import { titleToSlug } from "@/lib/slug";
import { SITE } from "@/config/site";

// One item per run: Claude-enrich it, then upsert to Supabase with slug-collision retry.
//
// Difference vs the old inline loop: a failed enrich or insert THROWS, so the run
// shows as failed (and replayable) in the Trigger.dev dashboard instead of being
// swallowed by console.error. That visibility is the point of the spike.

export interface EnrichItemPayload {
  title: string;
  url: string;
  content: string;
  publishedAt: string; // ISO 8601
  feedName: string;
  feedUrl: string;
}

export const enrichItemTask = task({
  id: "enrich-item",
  maxDuration: 120,
  retry: {
    maxAttempts: 3,
    factor: 1.8,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 30_000,
  },
  run: async (payload: EnrichItemPayload) => {
    const enr = await enrich({ title: payload.title, content: payload.content });
    const supa = adminClient();
    const baseSlug = titleToSlug(payload.title);

    const row = {
      source: payload.feedName,
      source_url: payload.feedUrl,
      original_url: payload.url,
      title: payload.title,
      original_content: payload.content.slice(0, 500),
      published_at: payload.publishedAt,
      niche: SITE.niche,
      ai_summary: enr.summary,
      why_it_matters: enr.whyItMatters,
      relevance_score: enr.relevanceScore,
      tags: enr.tags,
      slug: baseSlug,
      question_headline: enr.questionHeadline,
      key_stat: enr.keyStat,
      key_quote: enr.keyQuote,
      key_takeaways: enr.keyTakeaways,
    };

    // Clean slug from title; append -2, -3, ... on unique-constraint violation.
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
      const { error } = await supa
        .from("feed_items")
        .upsert({ ...row, slug: candidate }, { onConflict: "niche,original_url" });

      if (!error) return { inserted: true, url: payload.url, slug: candidate };
      if (!/duplicate key|unique constraint/i.test(error.message ?? "")) {
        throw new Error(`Insert failed for ${payload.url}: ${error.message}`);
      }
    }

    throw new Error(`Slug collision after 5 attempts for ${payload.url}`);
  },
});
