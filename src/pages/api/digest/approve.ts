import type { APIRoute } from 'astro';
import { adminClient } from '@/lib/supabase';
import { verifyApproveToken, sendResendBroadcast, escapeHtml } from '@/lib/digest';

export const prerender = false;

function html(status: number, body: string): Response {
  return new Response(
    `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:60px auto;padding:0 20px;color:#111;">${body}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

export const GET: APIRoute = async ({ url }) => {
  const token = url.searchParams.get('token');
  if (!token) return html(400, '<h2>Missing token</h2>');

  const secret = (import.meta.env.CRON_SECRET ?? process.env.CRON_SECRET ?? '') as string;
  if (!secret) return html(500, '<h2>Server misconfigured</h2><p>CRON_SECRET not set.</p>');

  const resendKey = (import.meta.env.RESEND_API_KEY ?? process.env.RESEND_API_KEY ?? '') as string;
  if (!resendKey) return html(500, '<h2>Server misconfigured</h2><p>RESEND_API_KEY not set.</p>');

  let runId: string;
  try {
    const payload = verifyApproveToken(token, secret);
    runId = payload.run_id;
  } catch {
    return html(401, '<h2>Invalid or expired link</h2>');
  }

  const supa = adminClient();
  const { data: run, error: fetchErr } = await supa
    .from('digest_runs')
    .select('id, status, broadcast_id')
    .eq('id', runId)
    .single();

  if (fetchErr || !run) return html(404, '<h2>Run not found</h2>');

  const r = run as { id: string; status: string; broadcast_id: string | null };
  if (r.status !== 'draft') return html(409, `<h2>Not draftable</h2><p>This digest has status <code>${escapeHtml(r.status)}</code> and cannot be sent.</p>`);
  if (!r.broadcast_id) return html(500, '<h2>Run missing broadcast id</h2>');

  try {
    await sendResendBroadcast(resendKey, r.broadcast_id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Resend send-broadcast failed for run', r.id, msg);
    return html(502, `<h2>Resend send failed</h2><p>The digest was not sent. The approval link is still valid — try again or check Resend status.</p><p style="font-size:12px;color:#9ca3af;">Detail: ${escapeHtml(msg)}</p>`);
  }

  const sentAt = new Date().toISOString();
  const { error: updateErr } = await supa
    .from('digest_runs')
    .update({ status: 'sent', sent_at: sentAt, approved_at: sentAt })
    .eq('id', r.id);

  if (updateErr) {
    return html(500, `<h2>Broadcast sent but DB update failed</h2><p>${escapeHtml(updateErr.message)}</p>`);
  }

  return html(200, '<h2 style="color:#0f766e;">Digest sent</h2><p>The broadcast has been queued in Resend.</p>');
};
