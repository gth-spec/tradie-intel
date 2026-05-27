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

export interface SelectArticlesResult {
  articles: DigestItem[];
  lookbackDays: number;
}

export interface DateRange {
  start: Date;
  end: Date;
}

export interface CreateLoopsDraftResult {
  campaignId: string;
  emailMessageId: string;
  contentRevisionId: string;
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

// ── Email LMX builder ─────────────────────────────────────────────────────────

function escapeLmxAttr(s: string): string {
  // For attribute values in Link href etc.
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function escapeLmxText(s: string): string {
  // For text content - escape < > & to prevent breaking the LMX parser
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatShortDate(d: Date): string {
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

export function getDateRange(): DateRange {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { start, end };
}

export function buildEmailLmx(articles: DigestItem[], dateRange: DateRange): string {
  const startLabel = formatShortDate(dateRange.start);
  const endLabel = formatShortDate(dateRange.end);

  const articleBlocks = articles.map(a => `
<H2><Link href="${escapeLmxAttr(a.original_url)}">${escapeLmxText(a.title)}</Link></H2>
<Paragraph>${escapeLmxText(a.ai_summary)}</Paragraph>
<Paragraph><Em>${escapeLmxText(a.why_it_matters)}</Em></Paragraph>
<Paragraph>${escapeLmxText(a.source)} · <Link href="${escapeLmxAttr(a.original_url)}">Read more →</Link></Paragraph>
<Divider />`).join('\n');

  return `<Style />
<H1>This week in trades</H1>
<Paragraph>${escapeLmxText(`Here's what's worth knowing in the trades sector this week (${startLabel} - ${endLabel}).`)}</Paragraph>
<Divider />
${articleBlocks}
<Paragraph><Em>You're receiving this because you subscribed at tradieintel.com.au</Em></Paragraph>`;
}

// ── Loops API client ──────────────────────────────────────────────────────────

export async function createLoopsDraftCampaign(apiKey: string, name: string): Promise<CreateLoopsDraftResult> {
  const res = await fetch('https://app.loops.so/api/v1/campaigns', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ name })
  });
  if (!res.ok) throw new Error(`Loops campaign create error: ${res.status} ${await res.text()}`);
  const data = await res.json() as {
    campaignId?: string;
    emailMessageId?: string;
    emailMessageContentRevisionId?: string;
  };
  if (!data.campaignId || !data.emailMessageId || !data.emailMessageContentRevisionId) {
    throw new Error('Loops campaign create: missing IDs in response');
  }
  return {
    campaignId: data.campaignId,
    emailMessageId: data.emailMessageId,
    contentRevisionId: data.emailMessageContentRevisionId
  };
}

export async function updateLoopsEmailMessage(apiKey: string, opts: {
  emailMessageId: string;
  expectedRevisionId: string;
  subject: string;
  previewText: string;
  lmx: string;
}): Promise<void> {
  const res = await fetch(`https://app.loops.so/api/v1/email-messages/${opts.emailMessageId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      expectedRevisionId: opts.expectedRevisionId,
      subject: opts.subject,
      previewText: opts.previewText,
      lmx: opts.lmx
    })
  });
  if (!res.ok) throw new Error(`Loops email message update error: ${res.status} ${await res.text()}`);
}

// ── AgentMail QA send ─────────────────────────────────────────────────────────
// Sends FROM tradieintel-qa@agentmail.to TO the approver's email address.
// API docs: https://agentmail.to/docs - verify endpoint before deploying.

const DIGEST_APPROVER_EMAIL = 'gth@gthdigitalmarketing.com.au';
const QA_INBOX = 'tradieintel-qa';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  <h2 style="color:#0f766e;">TradieIntel digest ready for approval</h2>
  <p><strong>Period:</strong> ${escapeHtml(startLabel)} - ${escapeHtml(endLabel)}</p>
  <p><strong>Articles selected (${opts.articles.length}):</strong></p>
  <ol>${articleList}</ol>
  <p style="margin-top:32px;">
    <a href="${escapeHtml(opts.approveUrl)}"
       style="background:#0f766e;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">
      Approve and schedule digest
    </a>
  </p>
  <p style="margin-top:24px;font-size:12px;color:#9ca3af;">This link expires in 7 days. Run ID: ${escapeHtml(opts.runId)}</p>
</body>
</html>`;
}

export async function sendQaEmail(apiKey: string, opts: {
  subject: string;
  html: string;
  approveUrl: string;
}): Promise<void> {
  const res = await fetch(`https://api.agentmail.to/v0/inboxes/${QA_INBOX}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      to: [DIGEST_APPROVER_EMAIL],
      subject: opts.subject,
      html: opts.html
    })
  });
  if (!res.ok) throw new Error(`AgentMail send error: ${res.status} ${await res.text()}`);
}

// ── Stale draft cleanup ───────────────────────────────────────────────────────

export async function cleanupStaleDrafts(supabase: SupabaseClient): Promise<void> {
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
