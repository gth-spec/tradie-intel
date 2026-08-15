import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const ADDRESS_WINDOW_MS = 15 * 60 * 1000;  // one confirmation per address per 15 min
const IP_WINDOW_MS = 60 * 60 * 1000;       // rolling hour
const IP_MAX_PER_WINDOW = 5;

/** Hash before storage so the abuse-control table is not itself a PI store. */
export function hashValue(v: string): string {
  return createHash('sha256').update(v.trim().toLowerCase()).digest('hex');
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: 'address_window' | 'ip_cap';
}

/**
 * Fails OPEN: if the store is unreachable, allow the signup rather than block real
 * users on an infra blip. The honeypot and confirmed opt-in remain as backstops.
 */
export async function checkRateLimit(
  supa: SupabaseClient,
  email: string,
  ip: string | null
): Promise<RateLimitResult> {
  const emailHash = hashValue(email);
  const ipHash = ip ? hashValue(ip) : null;
  const since = new Date(Date.now() - IP_WINDOW_MS).toISOString();

  try {
    const { data, error } = await supa
      .from('subscribe_attempts')
      .select('email_hash, ip_hash, created_at')
      .gte('created_at', since)
      .or(`email_hash.eq.${emailHash}${ipHash ? `,ip_hash.eq.${ipHash}` : ''}`);
    if (error) throw new Error(error.message);

    const rows = data ?? [];
    const addressCutoff = Date.now() - ADDRESS_WINDOW_MS;
    const sameAddressRecently = rows.some(
      r => r.email_hash === emailHash && new Date(r.created_at).getTime() > addressCutoff
    );
    if (sameAddressRecently) return { allowed: false, reason: 'address_window' };

    if (ipHash && rows.filter(r => r.ip_hash === ipHash).length >= IP_MAX_PER_WINDOW) {
      return { allowed: false, reason: 'ip_cap' };
    }

    await supa.from('subscribe_attempts').insert({ email_hash: emailHash, ip_hash: ipHash });
    // Sweep on write - no cron needed at this volume.
    await supa.from('subscribe_attempts').delete().lt('created_at', since);

    return { allowed: true };
  } catch (err) {
    console.error('[rate-limit] check failed, failing open:', err);
    return { allowed: true };
  }
}
