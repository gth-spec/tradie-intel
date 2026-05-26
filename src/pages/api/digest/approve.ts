import type { APIRoute } from 'astro';
import { adminClient } from '@/lib/supabase';
import { verifyApproveToken, scheduleLoopsBroadcast } from '@/lib/digest';

export const prerender = false;

function htmlPage(title: string, heading: string, message: string, isError = false, status = 200): Response {
  const color = isError ? '#dc2626' : '#0f766e';
  const icon = isError ? '⚠' : '✓';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${title} - TradieIntel</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:480px;margin:80px auto;padding:40px;background:#fff;border-radius:12px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="width:56px;height:56px;border-radius:50%;background:${color}1a;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;">
      <span style="font-size:24px;">${icon}</span>
    </div>
    <h1 style="margin:0 0 12px;font-size:22px;color:#111;">${heading}</h1>
    <p style="margin:0;font-size:15px;color:#6b7280;line-height:1.6;">${message}</p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

export const GET: APIRoute = async ({ url }) => {
  const token = url.searchParams.get('token');
  if (!token) {
    return htmlPage('Error', 'Invalid link', 'This approval link is missing its token.', true, 400);
  }

  const secret = (import.meta.env.CRON_SECRET ?? process.env.CRON_SECRET ?? '') as string;
  const loopsApiKey = (import.meta.env.EMAIL_PROVIDER_API_KEY ?? process.env.EMAIL_PROVIDER_API_KEY ?? '') as string;

  let payload: ReturnType<typeof verifyApproveToken>;
  try {
    payload = verifyApproveToken(token, secret);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    const isExpired = msg.includes('expired');
    return htmlPage(
      isExpired ? 'Link expired' : 'Error',
      isExpired ? 'This approval link has expired' : 'Invalid approval link',
      isExpired
        ? 'This digest run has been marked as expired. If you need to send a digest, trigger a new cron run.'
        : 'This link is not valid.',
      true,
      400
    );
  }

  const supa = adminClient();

  const { data: run, error: runError } = await supa
    .from('digest_runs')
    .select('id, status, broadcast_id')
    .eq('id', payload.run_id)
    .single();

  if (runError || !run) {
    return htmlPage('Error', 'Run not found', 'This digest run could not be found.', true, 404);
  }

  const typedRun = run as { id: string; status: string; broadcast_id: string | null };

  if (typedRun.status !== 'draft') {
    const alreadyDone = typedRun.status === 'approved' || typedRun.status === 'sent';
    return htmlPage(
      alreadyDone ? 'Already approved' : 'Cannot approve',
      alreadyDone ? 'Digest already approved' : 'This digest cannot be approved',
      alreadyDone
        ? 'This digest has already been approved and is scheduled to send.'
        : 'This digest run cannot be approved in its current state.',
      !alreadyDone,
      409
    );
  }

  await scheduleLoopsBroadcast(loopsApiKey, payload.broadcast_id);

  const { error: updateError } = await supa
    .from('digest_runs')
    .update({ status: 'approved', approved_at: new Date().toISOString() })
    .eq('id', payload.run_id);

  if (updateError) {
    return htmlPage('Error', 'Update failed', 'The broadcast was scheduled but the run record could not be updated. Please check the digest_runs table.', true, 500);
  }

  return htmlPage(
    'Digest approved',
    'Digest approved',
    'The digest has been approved and is scheduled to send to subscribers in approximately 15 minutes.',
    false,
    200
  );
};
