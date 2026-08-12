#!/usr/bin/env node
// Print Supabase storage stats for the shared TradieIntel + grokoryai-website
// project + 12-month growth projection.
//
// NOTE: this project (ref in SUPABASE_URL, named "TradieIntel" in the Supabase
// dashboard) is shared by TWO apps: projects/tradie-intel (feed_items, digest_runs)
// and projects/grokoryai-website/astro-poc (policies, scorecard_leads,
// ops_map_leads, ops_prefill_cache). Both draw on the same free-tier budget —
// see reference_tradieintel_resource_limits memory. Confirmed 2026-08-12 via
// live schema introspection (all four Astro tables exist, columns as below).
//
// Usage:
//   unset ANTHROPIC_API_KEY && node --env-file=.env scripts/db-stats.mjs
//
// Sizes are estimated using calibrated per-row constants (not pg_total_relation_size,
// which would need a Postgres function migration). Estimates include index overhead.
// Calibration assumptions live in TABLE_SPECS below — tune if a table changes shape.
//
// Headroom is calculated against Supabase free tier limits (500 MB database).
// If you upgrade to Pro tier (8 GB), divide the % numbers by ~16.

import { createClient } from '@supabase/supabase-js';

const FREE_TIER_DB_BYTES = 500 * 1024 * 1024; // 500 MB
const KB = 1024;
const MB = 1024 * 1024;

// Per-table size assumptions. Each row's serialised size including index overhead.
// Reasoned estimates from column shape, not measured (no pg_total_relation_size
// RPC deployed) — tune if a table changes shape.
//
// feed_items: most fields are bounded; original_content capped at 500 chars;
//   Claude-generated fields ~100-400 chars each; indexes ~30% overhead.
// digest_runs: jsonb metadata can carry full HTML payload during draft state;
//   most rows are status records (small) but the active draft can be ~50 KB.
//   Using 5 KB average across the lifecycle.
// policies: mostly bounded text fields + two small text[] arrays, no large jsonb.
// scorecard_leads: `answers` + `result` (full RetentionResult snapshot for the
//   report page) + `utm` jsonb — heavier than policies, comparable to feed_items.
// ops_map_leads: `answers` + `inputs` are small state objects, no report snapshot —
//   lightest of the lead tables.
// ops_prefill_cache: `facts` jsonb (GBP profile facts), keyed by `domain` not `id`
//   (this table has no id column). Self-pruning — purgeExpired() deletes rows past
//   a 30-day TTL, so this one does NOT grow unbounded like the others; 0 rows as
//   of 2026-08-12.
const TABLE_SPECS = {
  feed_items:        { bytesPerRow: 3 * KB,   label: 'Articles (tradie-intel)' },
  digest_runs:       { bytesPerRow: 5 * KB,   label: 'Digest runs (tradie-intel)' },
  policies:          { bytesPerRow: 1.5 * KB, label: 'AI policies (astro-poc)' },
  scorecard_leads:   { bytesPerRow: 3 * KB,   label: 'Scorecard leads (astro-poc)' },
  ops_map_leads:     { bytesPerRow: 1.5 * KB, label: 'Ops Map leads (astro-poc)' },
  ops_prefill_cache: { bytesPerRow: 1 * KB,   label: 'Ops Map prefill cache (astro-poc)', idColumn: 'domain' }
};

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY. Run with: node --env-file=.env scripts/db-stats.mjs');
  process.exit(2);
}

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

function fmtBytes(bytes) {
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(2)} MB`;
}

function fmtPct(part, whole) {
  return `${((part / whole) * 100).toFixed(3)}%`;
}

async function statsForTable(tableName, spec) {
  const idCol = spec.idColumn ?? 'id'; // ops_prefill_cache has no `id` column — keyed by `domain`

  // 1. Row count
  const { count, error: countErr } = await supa
    .from(tableName)
    .select(idCol, { count: 'exact', head: true });
  if (countErr) {
    return { tableName, error: countErr.message };
  }

  // 2. Oldest + newest timestamps for growth rate
  const { data: oldest } = await supa
    .from(tableName)
    .select('created_at')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const { data: newest } = await supa
    .from(tableName)
    .select('created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const oldestDate = oldest?.created_at ? new Date(oldest.created_at) : null;
  const newestDate = newest?.created_at ? new Date(newest.created_at) : null;
  const daysElapsed = oldestDate && newestDate
    ? Math.max(1, (newestDate - oldestDate) / (1000 * 60 * 60 * 24))
    : null;
  const rowsPerDay = (count && daysElapsed) ? count / daysElapsed : 0;

  const estimatedBytes = (count ?? 0) * spec.bytesPerRow;
  const projected12mRows = (count ?? 0) + Math.round(rowsPerDay * 365);
  const projected12mBytes = projected12mRows * spec.bytesPerRow;

  return {
    tableName,
    label: spec.label,
    count: count ?? 0,
    oldestDate,
    newestDate,
    daysElapsed,
    rowsPerDay,
    estimatedBytes,
    projected12mRows,
    projected12mBytes
  };
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Shared Supabase project storage stats (TradieIntel + astro-poc)');
console.log(`  Generated ${new Date().toISOString()}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

let totalBytes = 0;
let totalProjected12m = 0;

for (const [name, spec] of Object.entries(TABLE_SPECS)) {
  const s = await statsForTable(name, spec);
  if (s.error) {
    console.log(`${spec.label} (${name}):`);
    console.log(`  ERROR: ${s.error}\n`);
    continue;
  }

  totalBytes += s.estimatedBytes;
  totalProjected12m += s.projected12mBytes;

  console.log(`${s.label} (${s.tableName}):`);
  console.log(`  Rows now:        ${s.count.toLocaleString()}`);
  console.log(`  Size estimate:   ${fmtBytes(s.estimatedBytes)} (${spec.bytesPerRow / KB} KB/row × ${s.count})`);
  if (s.daysElapsed) {
    console.log(`  Date range:      ${s.oldestDate.toISOString().slice(0, 10)} → ${s.newestDate.toISOString().slice(0, 10)} (${s.daysElapsed.toFixed(1)} days)`);
    console.log(`  Growth rate:     ${s.rowsPerDay.toFixed(2)} rows/day`);
    console.log(`  12-mo projection: ${s.projected12mRows.toLocaleString()} rows → ${fmtBytes(s.projected12mBytes)}`);
  } else {
    console.log(`  (no rows — growth rate unknown)`);
  }
  console.log();
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Totals + free tier headroom');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log(`Total now:           ${fmtBytes(totalBytes)} (${fmtPct(totalBytes, FREE_TIER_DB_BYTES)} of 500 MB free tier)`);
console.log(`Total in 12 months:  ${fmtBytes(totalProjected12m)} (${fmtPct(totalProjected12m, FREE_TIER_DB_BYTES)} of 500 MB free tier)`);

const monthsToCap = totalBytes > 0 && totalProjected12m > totalBytes
  ? (FREE_TIER_DB_BYTES - totalBytes) / ((totalProjected12m - totalBytes) / 12)
  : Infinity;
const yearsToCap = monthsToCap / 12;

if (Number.isFinite(yearsToCap)) {
  console.log(`Time to free-tier cap (at current growth): ~${yearsToCap.toFixed(1)} years`);
} else {
  console.log(`Time to free-tier cap: not measurable (no growth signal yet)`);
}

console.log(`\nFree tier limits to also watch (Resend/Firecrawl are TradieIntel-only; not covered here):`);
console.log(`  • Resend: 3,000 emails/month, 100/day  →  hits at ~750 subscribers × 4 sends`);
console.log(`  • Firecrawl: 500 scrapes/month         →  hits if scrape sources >~30 weekly`);
console.log(`  • Vercel: 100 GB bandwidth/month       →  hits at ~100K+ pageviews/month (both sites combined)`);
console.log(`  • Grafana Cloud (connected 2026-08-12) covers DB infra/connections, NOT these ceilings`);
console.log(`\nCalibration: edit TABLE_SPECS in scripts/db-stats.mjs if a table shape changes.`);
