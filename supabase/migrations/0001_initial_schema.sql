-- Tradie Intel initial schema
-- Apply via Supabase Dashboard → SQL Editor → New query → paste → Run
-- Designed to support both 'trades' and (future) 'allied-health' niches in
-- the same table, distinguished by the niche column.

create extension if not exists "uuid-ossp";

create table feed_items (
  id uuid primary key default uuid_generate_v4(),
  source text not null,
  source_url text not null,
  original_url text not null,
  title text not null,
  original_content text,
  published_at timestamptz not null,
  niche text not null check (niche in ('trades', 'allied-health')),
  ai_summary text,
  why_it_matters text,
  relevance_score int check (relevance_score between 0 and 100),
  tags text[] default '{}',
  slug text not null,
  created_at timestamptz not null default now()
);

-- Uniqueness scoped by niche so each niche site can store its own copy if needed
-- and slugs/URLs don't collide across satellite sites sharing this table.
create unique index feed_items_niche_original_url_unique
  on feed_items (niche, original_url);

create unique index feed_items_niche_slug_unique
  on feed_items (niche, slug);

create index feed_items_niche_published_idx on feed_items (niche, published_at desc);
create index feed_items_niche_relevance_idx on feed_items (niche, relevance_score desc);
create index feed_items_tags_gin on feed_items using gin (tags);

-- Row Level Security: public anon role can only read trades items.
-- The service_role key bypasses RLS for writes (cron job, server-side queries).
alter table feed_items enable row level security;

create policy "public read trades items"
  on feed_items for select
  using (niche = 'trades');
