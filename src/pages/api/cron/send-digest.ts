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
  createResendBroadcast,
  sendQaEmail,
  signApproveToken
} from '@/lib/digest';

export const prerender = false;

export const GET: APIRoute = async ({ request, url }) => {
  const secret = (import.meta.env.CRON_SECRET ?? process.env.CRON_SECRET ?? '') as string;
  if (!secret) return new Response('Server misconfigured: CRON_SECRET not set', { status: 500 });
  if (!authoriseCron(request, secret)) return new Response('Unauthorised', { status: 401 });

  const dryRun = url.searchParams.get('dryRun') === '1';
  const supa = adminClient();

  const resendKey = (import.meta.env.RESEND_API_KEY ?? process.env.RESEND_API_KEY ?? '') as string;
  const segmentId = (import.meta.env.RESEND_SEGMENT_ID ?? process.env.RESEND_SEGMENT_ID ?? '') as string;
  const fromAddr = (import.meta.env.RESEND_FROM ?? process.env.RESEND_FROM ?? '') as string;
  const siteUrl = (import.meta.env.PUBLIC_SITE_URL ?? process.env.PUBLIC_SITE_URL ?? 'https://tradieintel.com.au') as string;
  const agentmailKey = (import.meta.env.AGENTMAIL_API_KEY ?? process.env.AGENTMAIL_API_KEY ?? '') as string;

  const summary: Record<string, unknown> = {
    started_at: new Date().toISOString(),
    dry_run: dryRun
  };

  await cleanupStaleDrafts(supa, resendKey || undefined);

  if (await hasRecentDigestRun(supa)) {
    summary.skipped = true;
    summary.skip_reason = 'recent_digest_exists';
    return new Response(JSON.stringify(summary), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  const excludeIds = await getLastDigestArticleIds(supa);
  const dateRange = getDateRange();
  const { articles, lookbackDays } = await selectArticles({ supabase: supa, excludeIds });

  summary.articles_selected = articles.length;
  summary.lookback_days = lookbackDays;

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
            html: `<p>The digest was skipped this week. Only ${articles.length} article(s) qualified (minimum is 3). Lookback was ${lookbackDays} days.</p>`
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

  const html = buildEmailHtml(articles, dateRange);
  const startLabel = dateRange.start.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  const endLabel = dateRange.end.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  const subject = `This week in trades: ${startLabel} - ${endLabel}`;
  const campaignName = `Weekly Digest - ${new Date().toISOString().slice(0, 10)}`;

  summary.subject = subject;
  summary.articles = articles.map(a => ({ id: a.id, title: a.title, score: a.relevance_score }));

  if (dryRun) {
    summary.dry_run_html_length = html.length;
    return new Response(JSON.stringify(summary), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!resendKey || !segmentId || !fromAddr) {
    return new Response('Server misconfigured: RESEND_API_KEY, RESEND_SEGMENT_ID, and RESEND_FROM must be set', { status: 500 });
  }

  const broadcastId = await createResendBroadcast(resendKey, {
    segmentId,
    from: fromAddr,
    subject,
    html,
    name: campaignName
  });

  summary.broadcast_id = broadcastId;

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
        campaign_name: campaignName,
        resend_segment_id: segmentId
      }
    })
    .select('id')
    .single();

  if (runError || !runData) {
    throw new Error(`Failed to insert digest_runs row: ${runError?.message}`);
  }

  const runId = (runData as { id: string }).id;
  summary.run_id = runId;

  const token = signApproveToken(runId, broadcastId, secret);
  const approveUrl = `${siteUrl}/api/digest/approve?token=${encodeURIComponent(token)}`;

  const qaHtml = buildQaEmailHtml({ articles, dateRange, approveUrl, runId });

  try {
    await sendQaEmail(agentmailKey, {
      subject: `[REVIEW] TradieIntel digest draft - ${startLabel} - ${endLabel}`,
      html: qaHtml
    });
    summary.qa_email_sent = true;
  } catch (e) {
    console.warn('AgentMail QA send failed (broadcast still created):', e);
    summary.qa_email_sent = false;
    summary.qa_email_error = e instanceof Error ? e.message : String(e);
  }

  summary.approve_url = approveUrl;
  return new Response(JSON.stringify(summary), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
};
