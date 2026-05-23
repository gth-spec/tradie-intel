import type { APIRoute } from 'astro';
import { getProvider, type EmailProvider, type SubscribeMeta } from '@/lib/email';

export const prerender = false;

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

export async function handleSubscribe(req: Request, provider: EmailProvider): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed();

  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; }
  catch { return json({ error: 'invalid JSON body' }, 400); }

  // Honeypot: bots typically fill every visible field. The `website` input is hidden
  // via CSS in EmailCapture.astro - any value here means a bot.
  // Return 200 so the bot thinks it succeeded, but do not subscribe.
  if (typeof body.website === 'string' && body.website.length > 0) {
    return json({ ok: true }, 200);
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email) return json({ error: 'email required' }, 400);

  const consent = body.consent === true;
  if (!consent) return json({ error: 'consent required' }, 400);

  const meta: SubscribeMeta = {
    consent: true,
    consent_timestamp: new Date().toISOString(),
    source: typeof body.source === 'string' ? body.source : 'unknown',
    referrer: typeof body.referrer === 'string' ? body.referrer : null,
    utm_source: typeof body.utm_source === 'string' ? body.utm_source : null,
    utm_medium: typeof body.utm_medium === 'string' ? body.utm_medium : null,
    utm_campaign: typeof body.utm_campaign === 'string' ? body.utm_campaign : null
  };

  try {
    await provider.subscribe(email, meta);
    return json({ ok: true }, 200);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '';
    if (/invalid email/i.test(message)) return json({ error: 'invalid email' }, 400);
    return json({ error: 'subscribe failed' }, 500);
  }
}

// Only POST is supported. GET returns 405 without touching getProvider() so
// missing env vars cannot cause a 500 on idle pings (probes, crawlers, etc).
export const POST: APIRoute = async ({ request }) => handleSubscribe(request, getProvider());
export const GET: APIRoute = async () => methodNotAllowed();
export const PUT: APIRoute = async () => methodNotAllowed();
export const DELETE: APIRoute = async () => methodNotAllowed();
