import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface FeedItem {
  id: string;
  source: string;
  source_url: string;
  original_url: string;
  title: string;
  original_content: string | null;
  published_at: string;
  niche: 'trades' | 'allied-health';
  ai_summary: string | null;
  why_it_matters: string | null;
  relevance_score: number | null;
  tags: string[];
  slug: string;
  created_at: string;
  question_headline: string | null;
  key_stat: string | null;
  key_quote: string | null;
  key_takeaways: string[];
}

let _adminClient: SupabaseClient | null = null;
let _publicClient: SupabaseClient | null = null;

/** Server-only client using the secret key (sb_secret_...) - writes allowed, bypasses RLS. */
export function adminClient(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      (import.meta as any).env?.SUPABASE_URL ?? process.env.SUPABASE_URL,
      (import.meta as any).env?.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SECRET_KEY
    );
  }
  return _adminClient;
}

/** Public client using the publishable key (sb_publishable_...) - reads only via RLS. */
export function publicClient(): SupabaseClient {
  if (!_publicClient) {
    _publicClient = createClient(
      (import.meta as any).env?.SUPABASE_URL ?? process.env.SUPABASE_URL,
      (import.meta as any).env?.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY
    );
  }
  return _publicClient;
}
