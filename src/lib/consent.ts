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
