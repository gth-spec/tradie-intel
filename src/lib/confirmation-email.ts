import type { ConsentScope } from './consent';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const FROM = 'TradieIntel <hello@tradieintel.com.au>';
const UNSUBSCRIBE_MAILTO = 'mailto:hello@tradieintel.com.au?subject=unsubscribe';

/**
 * Invariant: `label` must come from a fixed internal map and `url` must be
 * self-generated (never taken from user input) — neither is HTML-escaped
 * before being interpolated below.
 */
export interface ConfirmLink {
  scope: ConsentScope;
  url: string;
  label: string;
}

export function buildConfirmationHtml(links: ConfirmLink[]): string {
  if (links.length === 0) {
    throw new Error('buildConfirmationHtml requires at least one link');
  }

  const hasDigest = links.some(l => l.scope === 'tradieintel_digest');

  const buttons = links.map(l => `
    <p style="margin:24px 0;">
      <a href="${l.url}"
         style="background:#1a1a1a;color:#fff;padding:12px 20px;border-radius:6px;
                text-decoration:none;display:inline-block;font-weight:600;">${l.label}</a>
    </p>
    <p style="font-size:12px;color:#666;margin:0 0 16px;">
      Or paste this into your browser:<br><span style="word-break:break-all;">${l.url}</span>
    </p>`).join('');

  return `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.5;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px;">
  <h1 style="font-size:20px;">Confirm your subscription</h1>
  <p>Someone (hopefully you) asked to hear from us. Confirm below and you're set.</p>
  ${hasDigest ? '<p><strong>The TradieIntel weekly digest</strong> is AI-filtered trades news for Australian operators, sent every Tuesday morning.</p>' : ''}
  ${buttons}
  <hr style="border:none;border-top:1px solid #e5e5e5;margin:28px 0;">
  <p style="font-size:12px;color:#666;">
    If you ignore this email, nothing further will be sent. You will not be added to any list unless you click above.
  </p>
</body></html>`;
}

/**
 * Sends one confirmation email covering every requested scope.
 * Throws on a non-OK response, or if `links` is empty (via buildConfirmationHtml).
 */
export async function sendConfirmationEmail(
  to: string,
  links: ConfirmLink[],
  apiKey: string
): Promise<void> {
  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject: 'Confirm your TradieIntel subscription',
      html: buildConfirmationHtml(links),
      headers: { 'List-Unsubscribe': `<${UNSUBSCRIBE_MAILTO}>` }
    })
  });
  if (!res.ok) {
    throw new Error(`Resend send error: ${res.status} ${await res.text()}`);
  }
}
