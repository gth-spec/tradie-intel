import { createHmac, timingSafeEqual } from 'node:crypto';
// Used by article selection functions added in later tasks.
import type { SupabaseClient } from '@supabase/supabase-js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DigestItem {
  id: string;
  title: string;
  ai_summary: string;
  why_it_matters: string;
  original_url: string;
  source: string;
  published_at: string;
  relevance_score: number;
}

export interface DigestRun {
  id: string;
  created_at: string;
  status: 'draft' | 'approved' | 'sent' | 'skipped' | 'expired';
  broadcast_id: string | null;
  article_ids: string[];
  approved_at: string | null;
  sent_at: string | null;
  metadata: Record<string, unknown> | null;
}

export interface ApproveTokenPayload {
  run_id: string;
  broadcast_id: string;
  exp: number;
}

export interface SelectArticlesResult {
  articles: DigestItem[];
  lookbackDays: number;
}

export interface DateRange {
  start: Date;
  end: Date;
}

// ── Token utilities ───────────────────────────────────────────────────────────

export function signApproveToken(runId: string, broadcastId: string, secret: string): string {
  const payload: ApproveTokenPayload = {
    run_id: runId,
    broadcast_id: broadcastId,
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

export function verifyApproveToken(token: string, secret: string): ApproveTokenPayload {
  const dotIdx = token.indexOf('.');
  if (dotIdx === -1) throw new Error('Invalid token format');
  const payloadB64 = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const expected = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  const expectedBuf = Buffer.from(expected, 'ascii');
  const sigBuf = Buffer.from(sig, 'ascii');
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Invalid token signature');
  }
  let payload: ApproveTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as ApproveTokenPayload;
  } catch {
    throw new Error('Invalid token format');
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');
  return payload;
}

// ── Article selection ─────────────────────────────────────────────────────────

export async function getLastDigestArticleIds(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase
    .from('digest_runs')
    .select('article_ids')
    .in('status', ['approved', 'sent'])
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data?.[0]?.article_ids ?? []) as string[];
}

export async function hasRecentDigestRun(supabase: SupabaseClient): Promise<boolean> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('digest_runs')
    .select('id')
    .in('status', ['draft', 'approved', 'sent'])
    .gte('created_at', cutoff)
    .limit(1);
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function selectArticles(opts: {
  supabase: SupabaseClient;
  niche?: string;
  excludeIds?: string[];
}): Promise<SelectArticlesResult> {
  const { supabase, niche = 'trades', excludeIds = [] } = opts;

  for (const days of [7, 14]) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = supabase
      .from('feed_items')
      .select('id, title, ai_summary, why_it_matters, original_url, source, published_at, relevance_score')
      .eq('niche', niche)
      .not('relevance_score', 'is', null)
      .not('ai_summary', 'is', null)
      .gte('published_at', cutoff)
      .order('relevance_score', { ascending: false })
      .limit(20);

    if (excludeIds.length > 0) {
      query = query.not('id', 'in', `(${excludeIds.join(',')})`);
    }

    const { data, error } = await query as { data: unknown[] | null; error: { message: string } | null };
    if (error) throw error;

    const items = (data ?? []) as DigestItem[];
    if (items.length >= 3) {
      return { articles: items.slice(0, 5), lookbackDays: days };
    }
  }

  return { articles: [], lookbackDays: 14 };
}

// ── Email HTML builder ────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatShortDate(d: Date): string {
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

export function getDateRange(): DateRange {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { start, end };
}

export function buildEmailHtml(articles: DigestItem[], dateRange: DateRange): string {
  const startLabel = formatShortDate(dateRange.start);
  const endLabel = formatShortDate(dateRange.end);
  const rangeLabel = `${startLabel} - ${endLabel}`;
  const previewText = articles[0]
    ? articles[0].ai_summary.slice(0, 140)
    : 'Your weekly trades industry intelligence.';

  const articlesHtml = articles.map(a => `
      <tr>
        <td style="padding:24px 0;border-bottom:1px solid #e5e7eb;">
          <h2 style="margin:0 0 8px;font-size:18px;font-weight:600;line-height:1.3;">
            <a href="${escapeHtml(a.original_url)}" style="color:#0f766e;text-decoration:none;">${escapeHtml(a.title)}</a>
          </h2>
          <p style="margin:0 0 8px;font-size:15px;color:#374151;line-height:1.6;">${escapeHtml(a.ai_summary)}</p>
          <p style="margin:0 0 12px;font-size:13px;color:#6b7280;font-style:italic;">${escapeHtml(a.why_it_matters)}</p>
          <span style="font-size:12px;color:#9ca3af;">${escapeHtml(a.source)}</span>
          <a href="${escapeHtml(a.original_url)}" style="margin-left:12px;font-size:13px;color:#0f766e;">Read more →</a>
        </td>
      </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>This week in trades: ${escapeHtml(rangeLabel)}</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#f9fafb;">${escapeHtml(previewText)}</div>
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f9fafb;">
  <tr><td align="center" style="padding:32px 16px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;">
      <tr>
        <td style="background:#0f766e;padding:24px 32px;">
          <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.5px;">TradieIntel</h1>
          <p style="margin:6px 0 0;color:#99f6e4;font-size:13px;">Weekly Intel - ${escapeHtml(rangeLabel)}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:24px 32px 0;">
          <p style="margin:0;font-size:15px;color:#374151;line-height:1.6;">Here's what's worth knowing in the trades sector this week.</p>
        </td>
      </tr>
      <tr>
        <td style="padding:0 32px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            ${articlesHtml}
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:32px;background:#f9fafb;text-align:center;border-top:1px solid #e5e7eb;">
          <p style="margin:0 0 6px;font-size:12px;color:#9ca3af;">You're receiving this because you subscribed at tradieintel.com.au</p>
          <p style="margin:0;font-size:12px;color:#9ca3af;">© GrokoryAI - <a href="{{unsubscribe_link}}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe</a></p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ── Resend API client ────────────────────────────────────────────────────────

export interface CreateResendBroadcastInput {
  segmentId: string;
  from: string;
  subject: string;
  html: string;
  name: string;
  replyTo?: string;
}

export async function createResendBroadcast(
  apiKey: string,
  input: CreateResendBroadcastInput
): Promise<string> {
  const body: Record<string, unknown> = {
    segment_id: input.segmentId,
    from: input.from,
    subject: input.subject,
    html: input.html,
    name: input.name
  };
  if (input.replyTo) body.reply_to = input.replyTo;

  const res = await fetch('https://api.resend.com/broadcasts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`Resend broadcast create error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json() as { id?: string };
  if (!data.id) throw new Error('Resend broadcast create: missing id in response');
  return data.id;
}

export async function sendResendBroadcast(
  apiKey: string,
  broadcastId: string,
  scheduledAt?: string
): Promise<void> {
  const body = scheduledAt ? { scheduled_at: scheduledAt } : {};
  const res = await fetch(`https://api.resend.com/broadcasts/${broadcastId}/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`Resend broadcast send error: ${res.status} ${await res.text()}`);
  }
}

export async function deleteResendBroadcast(
  apiKey: string,
  broadcastId: string
): Promise<void> {
  const res = await fetch(`https://api.resend.com/broadcasts/${broadcastId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  if (res.status === 404) return;
  if (!res.ok) {
    throw new Error(`Resend broadcast delete error: ${res.status} ${await res.text()}`);
  }
}

// ── AgentMail QA send ─────────────────────────────────────────────────────────
// Sends FROM tradieintel-qa@agentmail.to TO the approver's email address.

const QA_INBOX = 'tradieintel-qa@agentmail.to';

function approverEmail(): string {
  return (import.meta.env.DIGEST_APPROVER_EMAIL
    ?? process.env.DIGEST_APPROVER_EMAIL
    ?? 'hello@tradieintel.com.au') as string;
}

export function buildQaEmailHtml(opts: {
  articles: DigestItem[];
  dateRange: DateRange;
  approveUrl: string;
  runId: string;
}): string {
  const startLabel = formatShortDate(opts.dateRange.start);
  const endLabel = formatShortDate(opts.dateRange.end);
  const articleList = opts.articles
    .map((a, i) => `<li style="margin-bottom:8px;"><strong>${i + 1}. ${escapeHtml(a.title)}</strong> - ${escapeHtml(a.source)} (score: ${a.relevance_score})</li>`)
    .join('');

  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 20px;color:#111;">
  <h2 style="color:#0f766e;">TradieIntel digest draft ready for approval</h2>
  <p><strong>Period:</strong> ${escapeHtml(startLabel)} - ${escapeHtml(endLabel)}</p>
  <p><strong>Articles selected (${opts.articles.length}):</strong></p>
  <ol>${articleList}</ol>
  <p style="margin-top:32px;">
    <a href="${escapeHtml(opts.approveUrl)}"
       style="background:#0f766e;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">
      Approve and send
    </a>
  </p>
  <p style="margin-top:24px;font-size:12px;color:#9ca3af;">Clicking the button verifies a signed token and immediately sends the Resend broadcast to all subscribers in the General segment. Run ID: ${escapeHtml(opts.runId)}</p>
</body>
</html>`;
}

export async function sendQaEmail(apiKey: string, opts: {
  subject: string;
  html: string;
}): Promise<void> {
  const res = await fetch(`https://api.agentmail.to/v0/inboxes/${QA_INBOX}/messages/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      to: [approverEmail()],
      subject: opts.subject,
      html: opts.html
    })
  });
  if (!res.ok) throw new Error(`AgentMail send error: ${res.status} ${await res.text()}`);
}

// ── Stale draft cleanup ───────────────────────────────────────────────────────

export async function cleanupStaleDrafts(
  supabase: SupabaseClient,
  resendKey?: string
): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('digest_runs')
    .select('id, broadcast_id')
    .eq('status', 'draft')
    .lt('created_at', cutoff);
  if (error) throw error;
  if (!data || data.length === 0) return;

  for (const run of data as { id: string; broadcast_id: string | null }[]) {
    if (resendKey && run.broadcast_id) {
      try {
        await deleteResendBroadcast(resendKey, run.broadcast_id);
      } catch (e) {
        console.warn(`Failed to delete Resend draft ${run.broadcast_id} for run ${run.id}:`, e);
      }
    }
    await supabase
      .from('digest_runs')
      .update({ status: 'expired' })
      .eq('id', run.id);
  }
}
