# Tradie Intel - Digest Builder Design Spec

**Date:** 2026-05-26
**Status:** Approved design, ready for implementation planning
**Project owner:** Gregory Hardiman (GrokoryAI)

---

## Overview

The digest builder sends a weekly email to all Tradie Intel subscribers summarising the top 5 industry news articles from the past 7 days. It is the fulfilment of the email capture CTA: "we'll email you when the daily digest launches."

The digest runs on a Tuesday 07:00 AEST schedule via a Vercel cron job. It selects the highest-scoring articles from Supabase, assembles an HTML email, creates a broadcast draft in Loops, then sends a preview to a QA inbox (AgentMail) for human approval before the broadcast is released to subscribers.

This is a **human-in-the-loop** system. No email goes to subscribers without Greg approving it via the AgentMail QA inbox.

---

## Scope

**In scope (v1):**
- Article selection from `feed_items` (top 5 by `relevance_score`, 7-day lookback)
- HTML email assembly
- Loops broadcast draft creation via API
- AgentMail QA send with approve link
- Approval endpoint (`/api/digest/approve`) - JWT validation, schedule broadcast
- `digest_runs` Supabase table for duplicate guard and run history
- Dry-run mode (`?dryRun=1`)
- Stale draft cleanup

**Out of scope (v1):**
- Subscriber segmentation or filtering
- Per-subscriber personalisation
- Unsubscribe management (Loops handles this natively)
- Open/click analytics beyond what Loops provides
- Allied health edition

---

## Schedule

- **Cron:** `0 21 * * 1` (UTC) = Tuesday 07:00 AEST
- **Registered in:** `vercel.json` alongside existing `refresh-feeds` cron

---

## Article Selection

### Source

Query Supabase `feed_items` table:
- `niche = 'trades'`
- `published_at >= now() - interval '7 days'` (fallback: `14 days` if fewer than 5 qualify)
- `relevance_score IS NOT NULL`
- Exclude `article_ids` that appeared in the most recent completed digest run (deduplication across weeks)

### Ranking

Order by `relevance_score DESC`, take top 5.

### Minimum threshold

If fewer than 3 articles qualify after both the 7-day and 14-day lookbacks, abort the run - do not create a broadcast. Send a notification email to the QA inbox explaining why the digest was skipped, with a count of qualifying articles.

### Article fields used in email

| Field | Use |
|---|---|
| `title` | Article heading |
| `summary` | 2-3 sentence body (Claude-generated, 300 char cap) |
| `why_it_matters` | Supporting line (Claude-generated, 150 char cap) |
| `original_url` | "Read more" link |
| `source_name` | Source badge |
| `tags` | Not shown in v1 |
| `relevance_score` | Not shown in v1 |

---

## Email Structure

### Metadata

| Field | Value |
|---|---|
| From name | TradieIntel |
| From address | `hello@tradieintel.com.au` (verified sending domain in Loops) |
| Reply-to | `hello@tradieintel.com.au` |
| Subject | `This week in trades: [date range]` e.g. `This week in trades: 19-25 May` |
| Preview text | Auto-generated from first article summary, capped at 140 chars |

### Body layout

```
[Header: TradieIntel logo + "Weekly Intel" label]

[Intro line: "Here's what's worth knowing in the trades sector this week."]

[Article 1]
  Title (linked to original_url)
  Summary
  Why it matters
  Source badge | Read more →

[Article 2..5 - same pattern]

[Footer]
  Unsubscribe link (Loops-managed)
  "You're receiving this because you subscribed at tradieintel.com.au"
  © GrokoryAI
```

HTML is inline-styled for email client compatibility. No external CSS files.

---

## Loops Broadcast API

### Create draft

`POST https://app.loops.so/api/v1/campaigns` (or equivalent broadcast endpoint - verify against current Loops API docs at runtime).

Payload:
```json
{
  "name": "Weekly Digest - YYYY-MM-DD",
  "subject": "This week in trades: [date range]",
  "preheader": "[preview_text]",
  "htmlBody": "[assembled HTML]",
  "audienceFilter": null
}
```

`audienceFilter: null` targets all subscribers (Loops default).

Returns a `broadcast_id` - stored in `digest_runs`.

### Schedule broadcast (approve action)

`PATCH https://app.loops.so/api/v1/campaigns/{broadcast_id}` with:
```json
{
  "scheduledAt": "[ISO timestamp: now + 15 minutes]"
}
```

15-minute delay gives Greg a window to catch and cancel after approving if needed.

---

## AgentMail QA Flow

### Inbox

`tradieintel-qa@agentmail.to` (free tier, already provisioned).

### QA email sent by cron

Subject: `[APPROVE REQUIRED] TradieIntel digest - [date]`

Body:
- Summary: how many articles selected, date range covered
- Article list (title + source for each)
- Approve link: `https://tradieintel.com.au/api/digest/approve?token=[jwt]`
- "This digest will expire in 7 days if not approved."

### Approve link

JWT signed with `CRON_SECRET`, containing:
```json
{
  "broadcast_id": "...",
  "run_id": "...",
  "exp": [unix timestamp: now + 7 days]
}
```

### Approval endpoint (`/api/digest/approve`)

1. Validate JWT signature and expiry
2. Check `digest_runs` for run_id - confirm status is `draft` (not already approved or expired)
3. PATCH Loops broadcast to `scheduledAt: now + 15 minutes`
4. Update `digest_runs` row: `status = 'approved'`, `approved_at = now()`
5. Return a styled HTML confirmation page: "Digest approved - sending to subscribers in ~15 minutes."

If JWT is expired or run_id is not in `draft` state, return a clear error page (do not throw a 500).

---

## Supabase: `digest_runs` Table

```sql
create table digest_runs (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  status      text not null check (status in ('draft', 'approved', 'sent', 'skipped', 'expired')),
  broadcast_id text,
  article_ids uuid[] not null,
  approved_at timestamptz,
  sent_at     timestamptz,
  metadata    jsonb
);

-- RLS: admin (service role) only
alter table digest_runs enable row level security;
```

`metadata` jsonb stores: article count, date range, skip reason (if skipped), dry_run flag.

---

## Duplicate Guard

Before creating a new broadcast, query `digest_runs` for any row with:
- `created_at >= now() - interval '7 days'`
- `status in ('draft', 'approved', 'sent')`

If found, abort and log. No duplicate digest in the same 7-day window.

---

## Stale Draft Cleanup

At the start of each cron run, before article selection:
1. Query `digest_runs` for rows with `status = 'draft'` and `created_at < now() - interval '7 days'`
2. For each: PATCH Loops to cancel/archive the broadcast (if Loops supports it), update status to `expired`

This prevents orphaned drafts accumulating in Loops.

---

## Dry-Run Mode

`GET /api/cron/send-digest?dryRun=1` (with valid `Authorization: Bearer $CRON_SECRET` header):
- Runs full article selection
- Assembles HTML
- Skips Loops broadcast creation
- Skips AgentMail send
- Logs what would have been sent
- Returns JSON summary with `dry_run: true` and `articles` array

---

## New Files

```
src/lib/digest.ts
  - selectArticles(supabase, opts): selects top articles with fallback logic
  - buildEmailHtml(articles, dateRange): assembles inline-styled HTML
  - createLoopsBroadcast(apiKey, payload): POST to Loops, returns broadcast_id
  - scheduleLoopsBroadcast(apiKey, broadcastId): PATCH to send at now+15min
  - sendQaEmail(agentmailKey, digestSummary, approveUrl): POST to AgentMail
  - signApproveToken(runId, broadcastId, secret): returns signed JWT
  - verifyApproveToken(token, secret): returns payload or throws

src/pages/api/cron/send-digest.ts
  - Cron handler (same auth pattern as refresh-feeds.ts)
  - Orchestrates: cleanup → duplicate guard → select → build → create broadcast → QA send → insert digest_runs row

src/pages/api/digest/approve.ts
  - GET handler (approve link is a GET - Greg clicks it from email)
  - JWT validation → Loops PATCH → digest_runs update → HTML confirmation page

supabase/migrations/0003_digest_runs.sql
  - digest_runs table DDL + RLS

vercel.json
  - Add: { "path": "/api/cron/send-digest", "schedule": "0 21 * * 1" }
```

---

## New Environment Variables

| Variable | Purpose |
|---|---|
| `AGENTMAIL_API_KEY` | AgentMail API key (already in `~/.zshrc` - needs adding to Vercel) |
| `LOOPS_API_KEY` | Loops broadcast API key (same as `EMAIL_PROVIDER_API_KEY` if Loops - confirm) |

No new env vars needed if `EMAIL_PROVIDER_API_KEY` is already the Loops key. `AGENTMAIL_API_KEY` is the only addition.

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Fewer than 3 qualifying articles | Abort, insert `digest_runs` row with `status='skipped'`, send skip notification to QA inbox |
| Loops API error creating broadcast | Log error, do not insert `digest_runs` row, surface in cron JSON response |
| AgentMail send fails | Log warning, broadcast_id is still stored in `digest_runs` - Greg can manually trigger approval if needed |
| JWT expired on approve link | Return HTML error page: "This approval link has expired. The digest run has been marked as expired." |
| Duplicate guard triggered | Return early with `{ skipped: true, reason: 'recent_digest_exists' }` in cron JSON |

---

## Testing

Tests follow the existing pattern in `tests/lib/` (Vitest).

New test files:
- `tests/lib/digest.test.ts` - unit tests for `selectArticles`, `buildEmailHtml`, `signApproveToken`, `verifyApproveToken`
- `tests/pages/api/digest/approve.test.ts` - approve endpoint: valid JWT, expired JWT, already-approved run, missing run

Loops and AgentMail API calls are mocked in tests (same approach as existing Firecrawl/Apify mocks).

---

## Operational Notes

- **Loops API key:** In Loops dashboard → Settings → API. Use the same key already in `EMAIL_PROVIDER_API_KEY` if provider is set to `loops`.
- **AgentMail API key:** Already in `~/.zshrc` as `AGENTMAIL_API_KEY`. Add to Vercel env vars before first live run.
- **First run:** Recommend triggering `?dryRun=1` manually on the deployed site before the first live Tuesday run. Confirm article selection and HTML output look correct.
- **Cron timing note:** `refresh-feeds` runs at `0 20 * * *` UTC (06:00 AEST daily). `send-digest` runs at `0 21 * * 1` UTC (07:00 AEST Tuesday). The 1-hour gap ensures the Tuesday feed refresh completes before digest selection runs.
