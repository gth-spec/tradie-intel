import type { APIRoute } from 'astro';
import { authoriseCron } from '@/pages/api/cron/refresh-feeds';
import { adminClient } from '@/lib/supabase';
import {
  cleanupStaleDrafts,
  hasRecentDigestRun,
  getLastDigestArticleIds,
  selectArticles,
  getDateRange,
  buildEmailHtml,
  buildQaEmailHtml,
  createLoopsBroadcast,
  sendQaEmail,
  signApproveToken
} from '@/lib/digest';

export const prerender = false;

const SITE_URL = 'https://tradieintel.com.au';

export const GET: APIRoute = async ({ request, url }) => {
  const secret = (import.meta.env.CRON_SECRET ?? process.env.CRON_SECRET ?? '') as string;
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

  // 2. Duplicate guard - abort if a digest was already sent/approved/drafted this week
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
    const skipMeta = { article_count: articles.length, lookback_days: lookbackDays, dry_run: dryRun };

    if (!dryRun) {
      await supa.from('digest_runs').insert({
        status: 'skipped',
        article_ids: [],
        metadata: { ...skipMeta, skip_reason: 'insufficient_articles' }
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

  // 5. Build the email HTML
  const emailHtml = buildEmailHtml(articles, dateRange);
  const startLabel = dateRange.start.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  const endLabel = dateRange.end.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  const subject = `This week in trades: ${startLabel} - ${endLabel}`;
  const preheaderText = articles[0].ai_summary.slice(0, 140);

  summary.subject = subject;
  summary.articles = articles.map(a => ({ id: a.id, title: a.title, score: a.relevance_score }));

  if (dryRun) {
    summary.dry_run_html_length = emailHtml.length;
    return new Response(JSON.stringify(summary), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  // 6. Create Loops broadcast draft
  const campaignName = `Weekly Digest - ${new Date().toISOString().slice(0, 10)}`;
  const broadcastId = await createLoopsBroadcast(loopsApiKey, {
    name: campaignName,
    subject,
    preheaderText,
    htmlBody: emailHtml
  });

  summary.broadcast_id = broadcastId;

  // 7. Insert digest_runs row as 'draft'
  const { data: runData, error: runError } = await supa
    .from('digest_runs')
    .insert({
      status: 'draft',
      broadcast_id: broadcastId,
      article_ids: articles.map(a => a.id),
      metadata: {
        subject,
        article_count: articles.length,
        lookback_days: lookbackDays,
        campaign_name: campaignName
      }
    })
    .select('id')
    .single();

  if (runError || !runData) {
    throw new Error(`Failed to insert digest_runs row: ${runError?.message}`);
  }

  const runId = runData.id as string;
  summary.run_id = runId;

  // 8. Sign approve token and send QA email
  const approveToken = signApproveToken(runId, broadcastId, secret);
  const approveUrl = `${SITE_URL}/api/digest/approve?token=${encodeURIComponent(approveToken)}`;

  const qaHtml = buildQaEmailHtml({ articles, dateRange, approveUrl, runId });

  try {
    await sendQaEmail(agentmailKey, {
      subject: `[APPROVE REQUIRED] TradieIntel digest - ${startLabel} - ${endLabel}`,
      html: qaHtml,
      approveUrl
    });
    summary.qa_email_sent = true;
  } catch (e) {
    console.warn('AgentMail QA send failed (broadcast still created):', e);
    summary.qa_email_sent = false;
    summary.qa_email_error = e instanceof Error ? e.message : String(e);
  }

  return new Response(JSON.stringify(summary), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
};
