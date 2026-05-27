-- Tracks each digest run: draft → approved → sent lifecycle.
-- RLS: service role (admin) writes only; no public read.

create table digest_runs (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  status       text not null check (status in ('draft', 'approved', 'sent', 'skipped', 'expired')),
  broadcast_id text,
  article_ids  uuid[] not null default '{}',
  approved_at  timestamptz,
  sent_at      timestamptz,
  metadata     jsonb
);

alter table digest_runs enable row level security;

-- No public read policy - this table is internal only.
-- The service role key used by the cron and approve endpoint bypasses RLS.

create index digest_runs_status_created_idx on digest_runs (status, created_at desc);
