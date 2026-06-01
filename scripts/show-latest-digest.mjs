#!/usr/bin/env node
// Pull the most recent approved or sent digest and write it as a markdown
// source brief for the GrokoryAI /content pipeline.
//
// Usage:
//   unset ANTHROPIC_API_KEY && node --env-file=.env scripts/show-latest-digest.mjs
//   unset ANTHROPIC_API_KEY && node --env-file=.env scripts/show-latest-digest.mjs --output /tmp/my-digest.md
//
// Writes to /tmp/digest-YYYY-WWxx.md by default (ISO week format).
// Prints the output path on completion so you can pipe it straight into /content.

import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY.');
  console.error('Run with: unset ANTHROPIC_API_KEY && node --env-file=.env scripts/show-latest-digest.mjs');
  process.exit(2);
}

// ── ISO week helper ───────────────────────────────────────────────────────────

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week: weekNo };
}

function isoWeekLabel(date) {
  const { year, week } = isoWeek(date);
  return `${year}-WW${String(week).padStart(2, '0')}`;
}

// ── Parse args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const outputFlagIdx = args.indexOf('--output');
const explicitOutput = outputFlagIdx !== -1 ? args[outputFlagIdx + 1] : null;

// ── Supabase ──────────────────────────────────────────────────────────────────

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

// 1. Get latest approved or sent digest run
const { data: runs, error: runErr } = await supa
  .from('digest_runs')
  .select('id, created_at, status, article_ids, approved_at, sent_at, metadata')
  .in('status', ['approved', 'sent'])
  .order('created_at', { ascending: false })
  .limit(1);

if (runErr) {
  console.error('Failed to query digest_runs:', runErr.message);
  process.exit(1);
}

if (!runs || runs.length === 0) {
  console.error('No approved or sent digest runs found.');
  console.error('Has a digest been approved yet? Check the agentmail.to QA inbox.');
  process.exit(1);
}

const run = runs[0];
const runDate = new Date(run.created_at);
const approvedAt = run.approved_at ? new Date(run.approved_at) : null;
const sentAt = run.sent_at ? new Date(run.sent_at) : null;

console.log(`Found digest run: ${run.id}`);
console.log(`  Status:      ${run.status}`);
console.log(`  Created:     ${runDate.toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })} AEST`);
if (approvedAt) console.log(`  Approved:    ${approvedAt.toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })} AEST`);
if (sentAt)     console.log(`  Sent:        ${sentAt.toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })} AEST`);
console.log(`  Articles:    ${run.article_ids.length} selected`);

// 2. Fetch the actual articles
const { data: articles, error: articleErr } = await supa
  .from('feed_items')
  .select('id, title, ai_summary, why_it_matters, original_url, source, published_at, relevance_score, tags')
  .in('id', run.article_ids);

if (articleErr) {
  console.error('Failed to fetch articles:', articleErr.message);
  process.exit(1);
}

if (!articles || articles.length === 0) {
  console.error('Digest run found but no matching articles in feed_items. Data integrity issue.');
  process.exit(1);
}

// Sort by relevance_score descending (same order the digest was built in)
articles.sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0));

// 3. Build markdown source brief
const weekLabel = isoWeekLabel(runDate);
const subject = run.metadata?.subject ?? `Trades digest ${weekLabel}`;
const articleCount = articles.length;

const articleBlocks = articles.map((a, i) => {
  const pubDate = new Date(a.published_at).toLocaleDateString('en-AU', {
    timeZone: 'Australia/Sydney',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
  const tags = Array.isArray(a.tags) && a.tags.length > 0
    ? `\nTags: ${a.tags.join(', ')}`
    : '';

  return `## Article ${i + 1}: ${a.title}

**Source:** ${a.source}
**Published:** ${pubDate}
**Relevance score:** ${a.relevance_score ?? 'n/a'}
**URL:** ${a.original_url}${tags}

### Summary
${a.ai_summary}

### Why it matters
${a.why_it_matters}`;
}).join('\n\n---\n\n');

const markdown = `---
digest_run_id: ${run.id}
week: ${weekLabel}
status: ${run.status}
created_at: ${run.created_at}
article_count: ${articleCount}
source: tradieintel.com.au
brand: grokoryai
niche: trades
subject: "${subject}"
---

# TradieIntel Digest Source Brief - ${weekLabel}

> This file is the approved article selection from the TradieIntel weekly digest.
> Feed it into the GrokoryAI /content pipeline as the source brief.
> Command: /content source=${explicitOutput ?? `/tmp/digest-${weekLabel}.md`} brand=grokoryai

**Digest subject:** ${subject}
**Articles in this digest:** ${articleCount}
**Digest run ID:** ${run.id}

---

${articleBlocks}
`;

// 4. Write to file
const outputPath = explicitOutput ?? `/tmp/digest-${weekLabel}.md`;
writeFileSync(outputPath, markdown, 'utf-8');

console.log(`\n✓ Digest written to: ${outputPath}`);
console.log(`\nNext step:`);
console.log(`  /content source=${outputPath} brand=grokoryai`);
