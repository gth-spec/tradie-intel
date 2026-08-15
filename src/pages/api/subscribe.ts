import type { APIRoute } from 'astro';
import { isValidEmail } from '@/lib/email';
import { signToken } from '@/lib/token';
import { checkRateLimit as realCheckRateLimit } from '@/lib/rate-limit';
import { sendConfirmationEmail as realSendConfirmationEmail, type ConfirmLink } from '@/lib/confirmation-email';
import { adminClient } from '@/lib/supabase';
import type { ConfirmTokenPayload, ConsentScope } from '@/lib/consent';

export const prerender = false;

const TOKEN_TTL_SECONDS = 48 * 60 * 60;

const SCOPE_LABELS: Record<ConsentScope, string> = {
  tradieintel_digest: 'Confirm the weekly digest',
  grokoryai_commercial: 'Confirm GrokoryAI emails'
};

export interface SubscribeDeps {
  secret: string;
  siteUrl: string;
  checkRateLimit: (email: string, ip: string | null) => Promise<{ allowed: boolean }>;
  sendConfirmationEmail: (to: string, links: ConfirmLink[]) => Promise<void>;
}

function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ error: 'method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json', Allow: 'POST' }
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

const ok = () => json({ ok: true }, 200);

export async function handleSubscribe(req: Request, deps: SubscribeDeps): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed();

  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; }
  catch { return json({ error: 'invalid JSON body' }, 400); }

  // Honeypot: the `website` input is CSS-hidden in EmailCapture.astro, so any value
  // means a bot. Return 200 so the bot believes it succeeded, but do nothing.
  if (typeof body.website === 'string' && body.website.length > 0) return ok();

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email) return json({ error: 'email required' }, 400);
  // Validate here rather than relying on a provider throwing - no provider is called now.
  if (!isValidEmail(email)) return json({ error: 'invalid email' }, 400);

  if (body.consent_digest !== true) return json({ error: 'consent required' }, 400);
  const consentCommercial = body.consent_commercial === true;

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  // Return the ordinary 200 when throttled: a distinct status would let an attacker
  // probe the limiter, and a real user retrying shortly after is indistinguishable.
  if (!(await deps.checkRateLimit(email, ip)).allowed) return ok();

  const str = (k: string) => typeof body[k] === 'string' ? body[k] as string : null;
  const iat = Math.floor(Date.now() / 1000);

  const scopes: ConsentScope[] = ['tradieintel_digest'];
  if (consentCommercial) scopes.push('grokoryai_commercial');

  const links: ConfirmLink[] = scopes.map(scope => {
    const token = signToken<ConfirmTokenPayload>({
      email,
      scope,
      source: str('source') ?? 'unknown',
      referrer: str('referrer'),
      utm_source: str('utm_source'),
      utm_medium: str('utm_medium'),
      utm_campaign: str('utm_campaign'),
      iat,
      exp: iat + TOKEN_TTL_SECONDS
    }, deps.secret);
    return {
      scope,
      label: SCOPE_LABELS[scope],
      url: `${deps.siteUrl}/confirm?t=${encodeURIComponent(token)}`
    };
  });

  try {
    await deps.sendConfirmationEmail(email, links);
  } catch (err) {
    console.error('[subscribe] confirmation send failed:', err);
    return json({ error: 'could not send confirmation' }, 502);
  }

  return ok();
}

function liveDeps(secret: string, siteUrl: string): SubscribeDeps {
  const supa = adminClient();
  return {
    secret,
    siteUrl,
    checkRateLimit: (email, ip) => realCheckRateLimit(supa, email, ip),
    sendConfirmationEmail: (to, links) => realSendConfirmationEmail(
      to, links, (import.meta.env.RESEND_API_KEY ?? process.env.RESEND_API_KEY) as string
    )
  };
}

// Same guard pattern as src/pages/confirm.astro and src/pages/api/digest/approve.ts:
// resolve each var into a local const with an empty-string fallback (so `??` doesn't let
// an explicitly-empty env var slip through), then fail closed before either is used.
//
// SUBSCRIBE_TOKEN_SECRET: without this, an unset var would make signToken either throw
// unpredictably or silently sign with `undefined`; an explicitly-empty var would let HMAC
// run with an empty key - a deterministic, publicly-computable function, making every
// minted token forgeable. This endpoint mints the tokens confirm.astro verifies, so it
// needs the same discipline, not a laxer one.
//
// PUBLIC_SITE_URL: no hardcoded-domain fallback here (unlike cron/send-digest.ts's
// precedent for this same var) - Task 9 exercises this flow against a Vercel preview
// deployment, not production. A hardcoded prod fallback would silently mint confirmation
// links pointing at production while a misconfigured preview still returns 200 and still
// sends a real email, which is a worse failure than a loud one: it looks like it worked.
export const POST: APIRoute = async ({ request }) => {
  const secret = (import.meta.env.SUBSCRIBE_TOKEN_SECRET ?? process.env.SUBSCRIBE_TOKEN_SECRET ?? '') as string;
  const siteUrl = (import.meta.env.PUBLIC_SITE_URL ?? process.env.PUBLIC_SITE_URL ?? '') as string;
  if (!secret || !siteUrl) {
    console.error('[subscribe] misconfigured:', !secret ? 'SUBSCRIBE_TOKEN_SECRET' : 'PUBLIC_SITE_URL', 'not set');
    return json({ error: 'server misconfigured' }, 500);
  }
  return handleSubscribe(request, liveDeps(secret, siteUrl));
};
export const GET: APIRoute = async () => methodNotAllowed();
export const PUT: APIRoute = async () => methodNotAllowed();
export const DELETE: APIRoute = async () => methodNotAllowed();
