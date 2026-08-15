import { verifyToken } from './token';
import type { ConfirmTokenPayload, ConsentScope, ConsentRow } from './consent';
import type { EmailProvider } from './email';

export type ConfirmOutcome =
  | { status: 'ok'; scope: ConsentScope }
  | { status: 'provider_error'; scope: ConsentScope }
  | { status: 'invalid' }
  | { status: 'expired' };

export interface ConfirmMeta {
  ipHash: string | null;
  userAgent: string | null;
}

export interface ConfirmDeps {
  secret: string;
  recordConsent: (row: ConsentRow) => Promise<void>;
  getProviderFor: (scope: ConsentScope) => EmailProvider | null;
}

export async function handleConfirm(
  rawToken: string,
  meta: ConfirmMeta,
  deps: ConfirmDeps
): Promise<ConfirmOutcome> {
  let payload: ConfirmTokenPayload;
  try {
    payload = verifyToken<ConfirmTokenPayload>(rawToken, deps.secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    return /expired/i.test(message) ? { status: 'expired' } : { status: 'invalid' };
  }

  // Consent first. A consent row with no subscription is harmless; the reverse is the
  // compliance failure this build exists to prevent. Do not reorder these two blocks.
  // If recordConsent itself throws (Supabase unreachable), this deliberately propagates
  // out of handleConfirm uncaught - confirm.astro has no try/catch around it, so the
  // request 500s. That is intentional: a confirmation that silently "succeeds" while
  // failing to record consent is worse than a visible failure the user can retry.
  await deps.recordConsent({
    email: payload.email,
    scope: payload.scope,
    requested_at: new Date(payload.iat * 1000).toISOString(),
    source: payload.source,
    referrer: payload.referrer,
    utm_source: payload.utm_source,
    utm_medium: payload.utm_medium,
    utm_campaign: payload.utm_campaign,
    ip_hash: meta.ipHash,
    user_agent: meta.userAgent
  });

  const provider = deps.getProviderFor(payload.scope);
  // No destination list for this scope yet (expected for grokoryai_commercial until one
  // is provisioned). Consent is recorded and provable; there is simply nothing to join.
  if (!provider) return { status: 'ok', scope: payload.scope };

  try {
    await provider.subscribe(payload.email, {
      consent: true,
      consent_timestamp: new Date().toISOString(), // confirmation time, not request time
      source: payload.source,
      referrer: payload.referrer,
      utm_source: payload.utm_source,
      utm_medium: payload.utm_medium,
      utm_campaign: payload.utm_campaign
    });
  } catch (err) {
    console.error('[confirm] provider subscribe failed:', err);
    return { status: 'provider_error', scope: payload.scope };
  }

  return { status: 'ok', scope: payload.scope };
}
