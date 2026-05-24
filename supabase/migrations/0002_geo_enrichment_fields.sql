-- Adds GEO credibility fields extracted by the enrichment pipeline.
-- All columns are nullable so existing rows remain valid without backfill.

alter table feed_items
  add column if not exists question_headline text,
  add column if not exists key_stat text,
  add column if not exists key_quote text,
  add column if not exists key_takeaways text[] default '{}';
