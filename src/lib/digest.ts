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
  // ponytail: cron fires weekly at a fixed wall-clock time, so last week's row
  // lands only seconds inside a naive 7-day cutoff (it happened 2026-07-21,
  // silently skipping the digest). 6 days gives a full day of slack; revisit
  // if the cron schedule ever moves off a fixed weekly time.
  const cutoff = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
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

export function formatShortDate(d: Date): string {
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

export function getDateRange(): DateRange {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { start, end };
}

// ── NitroSend section-based digest builder ────────────────────────────────────
// Returns an array of NitroSend section objects compatible with
// `design.sections[]` in the PATCH /templates call.
// Shape per docs/nitrosend-api-probe.md:
//   { type:'header', props:{…} }
//   { type:'text',   props:{ content:'<html>' } }
//   { type:'footer' }

export function buildDigestSections(articles: DigestItem[], dateRange: DateRange): unknown[] {
  const startLabel = formatShortDate(dateRange.start);
  const endLabel = formatShortDate(dateRange.end);
  const rangeLabel = `${startLabel} - ${endLabel}`;

  const sections: unknown[] = [];

  // Header
  sections.push({
    type: 'header',
    props: {
      variant: 'wordmark',
      wordmark_text: 'TradieIntel',
      wordmark_color: '#ffffff',
      background_color: '#0f766e'
    }
  });

  // Intro text
  sections.push({
    type: 'text',
    props: {
      content: `<p style="color:#374151;">Here's what's worth knowing in the trades sector this week (${escapeHtml(rangeLabel)}).</p>`
    }
  });

  // One text section per article
  for (const a of articles) {
    sections.push({
      type: 'text',
      props: {
        content: [
          `<h2 style="margin:0 0 8px;font-size:18px;font-weight:600;line-height:1.3;">`,
          `<a href="${escapeHtml(a.original_url)}" style="color:#0f766e;text-decoration:none;">${escapeHtml(a.title)}</a>`,
          `</h2>`,
          `<p style="margin:0 0 8px;font-size:15px;color:#374151;line-height:1.6;">${escapeHtml(a.ai_summary)}</p>`,
          `<p style="margin:0 0 12px;font-size:13px;color:#6b7280;font-style:italic;">${escapeHtml(a.why_it_matters)}</p>`,
          `<span style="font-size:12px;color:#9ca3af;">${escapeHtml(a.source)}</span>`,
          `<a href="${escapeHtml(a.original_url)}" style="margin-left:12px;font-size:13px;color:#0f766e;">Read more →</a>`
        ].join('')
      }
    });
  }

  // Footer (auto-fills company name + address + unsubscribe from brand kit)
  sections.push({ type: 'footer' });

  return sections;
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
  <p style="margin-top:24px;font-size:12px;color:#9ca3af;">Clicking the button verifies a signed token and immediately sends the NitroSend campaign to the TradieIntel Weekly Digest list. Run ID: ${escapeHtml(opts.runId)}</p>
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
// NitroSend has no campaign DELETE endpoint (campaigns are GET/POST/PATCH/send
// only per docs/nitrosend-api-probe.md), so cleanup is DB-only: stale draft
// rows are marked expired without any external API call.

export async function cleanupStaleDrafts(
  supabase: SupabaseClient
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
    await supabase
      .from('digest_runs')
      .update({ status: 'expired' })
      .eq('id', run.id);
  }
}
