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

    let query = supabase
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

    const { data, error } = await query;
    if (error) throw error;

    const items = (data ?? []) as DigestItem[];
    if (items.length >= 3) {
      return { articles: items.slice(0, 5), lookbackDays: days };
    }
  }

  return { articles: [], lookbackDays: 14 };
}
