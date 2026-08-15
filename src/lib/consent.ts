import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExpiringPayload } from './token';

export type ConsentScope = 'tradieintel_digest' | 'grokoryai_commercial';

export const CONSENT_SCOPES: readonly ConsentScope[] = [
  'tradieintel_digest',
  'grokoryai_commercial'
] as const;

/** Signed payload of a confirmation link. One token confirms exactly one scope. */
export interface ConfirmTokenPayload extends ExpiringPayload {
  email: string;
  scope: ConsentScope;
  source: string;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  /** Signup request time, unix seconds. Source for subscriber_consents.requested_at. */
  iat: number;
}

export interface ConsentRow {
  email: string;
  scope: ConsentScope;
  requested_at: string;
  source: string | null;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  ip_hash: string | null;
  user_agent: string | null;
}

/**
 * Writes the (email, scope) consent row with first-touch semantics for ip_hash/user_agent.
 *
 * A re-clicked or retried confirmation link should refresh confirmed_at, but must NOT
 * overwrite ip_hash/user_agent on repeat hits. Corporate email security gateways
 * (Microsoft Defender Safe Links, Proofpoint, Mimecast) commonly auto-fetch links in
 * inbound mail before a human opens it - if that first hit created the row, a blind
 * upsert would let every later genuine click silently overwrite the scanner's IP/UA
 * onto a record whose whole purpose is proving who consented and from where. So: insert
 * on first sight, update only confirmed_at on every subsequent hit.
 */
export async function recordConsent(supa: SupabaseClient, row: ConsentRow): Promise<void> {
  const { data: existing, error: selectError } = await supa
    .from('subscriber_consents')
    .select('id')
    .eq('email', row.email)
    .eq('scope', row.scope)
    .maybeSingle();
  if (selectError) throw new Error(`recordConsent failed: ${selectError.message}`);

  if (existing) {
    const { error } = await supa
      .from('subscriber_consents')
      .update({ confirmed_at: new Date().toISOString() })
      .eq('id', (existing as { id: string }).id);
    if (error) throw new Error(`recordConsent failed: ${error.message}`);
    return;
  }

  const { error } = await supa
    .from('subscriber_consents')
    .insert({ ...row, confirmed_at: new Date().toISOString() });
  if (error) throw new Error(`recordConsent failed: ${error.message}`);
}
