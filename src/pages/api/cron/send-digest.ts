import type { APIRoute } from 'astro';
import { authoriseCron } from '@/pages/api/cron/refresh-feeds';
import { adminClient } from '@/lib/supabase';
import {
  cleanupStaleDrafts,
  hasRecentDigestRun,
  getLastDigestArticleIds,
  selectArticles,
  getDateRange,
  buildEmailLmx,
  buildQaEmailHtml,
  createLoopsDraftCampaign,
  updateLoopsEmailMessage,
  sendQaEmail
} from '@/lib/digest';

export const prerender = false;

function loopsCampaignUrl(campaignId: string): string {
  return `https://app.loops.so/campaigns/${campaignId}`;
}

export const GET: APIRoute = async ({ request, url }) => {
  const secret = (import.meta.env.CRON_SECRET ?? process.env.CRON_SECRET ?? '') as string;
  if (!secret) {
    return new Response('Server misconfigured: CRON_SECRET not set', { status: 500 });
  }
  if (!authoriseCron(request, secret)) {
    return new Response('Unauthorised', { status: 401 });
  }

  const dryRun = url.searchParams.get('dryRun') === '1';
  const supa = adminClient();
  const loopsApiKey = (import.meta.env.EMAIL_PROVIDER_API_KEY ?? process.env.EMAIL_PROVIDER_API_KEY ?? '') as string;
  const agentmailKey = (import.meta.env.AGENTMAIL_API_KEY ?? process.env.AGENTMAIL_API_KEY ?? '') as string;

  const summary: Record<string, unknown> = {
    started_at: new Date().toISOString(),
    dry_run: dryRun
  };

  // 1. Clean up stale drafts from previous runs
  await cleanupStaleDrafts(supa);

  // 2. Duplicate guard - abort if a digest was already drafted this week
  const alreadyRan = await hasRecentDigestRun(supa);
  if (alreadyRan) {
    summary.skipped = true;
    summary.skip_reason = 'recent_digest_exists';
    return new Response(JSON.stringify(summary), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  // 3. Select articles, excluding those from the last digest
  const excludeIds = await getLastDigestArticleIds(supa);
  const dateRange = getDateRange();
  const { articles, lookbackDays } = await selectArticles({ supabase: supa, excludeIds });

  summary.articles_selected = articles.length;
  summary.lookback_days = lookbackDays;

  // 4. Abort if not enough articles
  if (articles.length < 3) {
    if (!dryRun) {
      await supa.from('digest_runs').insert({
        status: 'skipped',
        article_ids: [],
        metadata: {
          article_count: articles.length,
          lookback_days: lookbackDays,
          skip_reason: 'insufficient_articles'
        }
      });

      if (agentmailKey) {
        try {
          await sendQaEmail(agentmailKey, {
            subject: `[SKIPPED] TradieIntel digest - only ${articles.length} article(s) qualified`,
            html: `<p>The digest was skipped this week. Only ${articles.length} article(s) qualified (minimum is 3). Lookback was ${lookbackDays} days.</p>`,
            approveUrl: ''
          });
        } catch (e) {
          console.warn('Failed to send skip notification:', e);
        }
      }
    }

    summary.skipped = true;
    summary.skip_reason = 'insufficient_articles';
    return new Response(JSON.stringify(summary), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  // 5. Build LMX content
  const lmx = buildEmailLmx(articles, dateRange);
  const startLabel = dateRange.start.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  const endLabel = dateRange.end.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  const subject = `This week in trades: ${startLabel} - ${endLabel}`;
  const previewText = articles[0].ai_summary.slice(0, 140);

  summary.subject = subject;
  summary.articles = articles.map(a => ({ id: a.id, title: a.title, score: a.relevance_score }));

  if (dryRun) {
    summary.dry_run_lmx_length = lmx.length;
    return new Response(JSON.stringify(summary), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  // 6. Create Loops draft campaign
  const campaignName = `Weekly Digest - ${new Date().toISOString().slice(0, 10)}`;
  const draft = await createLoopsDraftCampaign(loopsApiKey, campaignName);

  summary.campaign_id = draft.campaignId;

  // 7. Update the email message with LMX content
  await updateLoopsEmailMessage(loopsApiKey, {
    emailMessageId: draft.emailMessageId,
    expectedRevisionId: draft.contentRevisionId,
    subject,
    previewText,
    lmx
  });

  // 8. Insert digest_runs row as 'draft' - this run stays in 'draft' status forever
  //    since send is manual via Loops UI. We could later add a webhook to update it.
  const { data: runData, error: runError } = await supa
    .from('digest_runs')
    .insert({
      status: 'draft',
      broadcast_id: draft.campaignId,
      article_ids: articles.map(a => a.id),
      metadata: {
        subject,
        article_count: articles.length,
        lookback_days: lookbackDays,
        campaign_name: campaignName,
        email_message_id: draft.emailMessageId,
        loops_campaign_url: loopsCampaignUrl(draft.campaignId)
      }
    })
    .select('id')
    .single();

  if (runError || !runData) {
    throw new Error(`Failed to insert digest_runs row: ${runError?.message}`);
  }

  summary.run_id = (runData as { id: string }).id;

  // 9. Send QA email pointing to the Loops UI for review + manual send
  const loopsUrl = loopsCampaignUrl(draft.campaignId);
  const qaHtml = buildQaEmailHtml({
    articles,
    dateRange,
    approveUrl: loopsUrl,
    runId: (runData as { id: string }).id
  });

  try {
    await sendQaEmail(agentmailKey, {
      subject: `[REVIEW] TradieIntel digest draft - ${startLabel} - ${endLabel}`,
      html: qaHtml,
      approveUrl: loopsUrl
    });
    summary.qa_email_sent = true;
  } catch (e) {
    console.warn('AgentMail QA send failed (Loops draft still created):', e);
    summary.qa_email_sent = false;
    summary.qa_email_error = e instanceof Error ? e.message : String(e);
  }

  summary.loops_campaign_url = loopsUrl;

  return new Response(JSON.stringify(summary), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
};
