#!/usr/bin/env node
// One-time backfill: re-enriches existing feed_items that have null question_headline
// with the new GEO fields (question_headline, key_stat, key_quote, key_takeaways).
// Run from project root: node scripts/backfill-geo.mjs
// (The script loads .env automatically from the project root.)
// Flags:
//   --dry-run   print what would be written, no DB updates
//   --max=N     only process first N items (default 9999)

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

// Load .env from project root (one level above scripts/)
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');
try {
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key) {
      process.env[key] = val;
    }
  }
} catch {
  // .env not found - rely on existing process.env (e.g. CI/production)
}

const DELAY_MS = 500;          // ms between Claude calls to avoid rate limiting
const DRY_RUN = process.argv.includes('--dry-run');
const MAX_ITEMS = parseInt(process.argv.find(a => a.startsWith('--max='))?.split('=')[1] ?? '9999', 10);

// Validate required env vars early
const required = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'ANTHROPIC_API_KEY'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';

// Character limits matching src/lib/claude.ts constants
const MAX_QUESTION_HEADLINE_CHARS = 120;
const MAX_KEY_STAT_CHARS = 150;
const MAX_KEY_QUOTE_CHARS = 200;
const MAX_TAKEAWAY_CHARS = 120;
const MAX_TAKEAWAYS = 4;

function truncate(s, n) {
  if (!s || s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

// Prompt mirrors enrichmentPrompt() in src/lib/claude.ts but requests only the four GEO fields
function buildGeoPrompt(title, content) {
  return `You are an editorial assistant for an Australian trades-industry news site. Read the article below and respond with a single JSON object - no prose, no markdown fences.

Required JSON shape:
{
  "question_headline": "Rephrase the article title as a direct question a tradie would Google, max 120 characters. Example: 'How will the ACT housing reforms affect my building costs?'",
  "key_stat": "ONE specific number, dollar amount, or percentage from the article that anchors the story, max 150 characters. Include context (e.g. '$2.4 billion allocated to housing in the 2026 federal budget'). Return null if no specific figure exists in the article.",
  "key_quote": "A direct quote from a named person or official mentioned in the article, max 200 characters. Include the person's name and title (e.g. \\"This will cut delays by half\\" - Jane Smith, Master Builders CEO'). Return null if no named source is quoted.",
  "key_takeaways": ["Up to 4 bullet-point sentences, max 120 chars each. Plain English. Each one should be independently quotable. Return empty array if article is too thin."]
}

Article title: ${title}
Article content: ${content}

Respond with JSON only.`;
}

async function enrichGeoFields(title, content) {
  const response = await anthropic.messages.create({
    model,
    max_tokens: 512,
    messages: [{ role: 'user', content: buildGeoPrompt(title, content ?? title) }]
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text).join('').trim()
    .replace(/^```(?:json)?\s*|\s*```$/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response: ${text.slice(0, 200)}`);
  }

  return {
    question_headline: parsed.question_headline?.trim()
      ? truncate(parsed.question_headline.trim(), MAX_QUESTION_HEADLINE_CHARS)
      : null,
    key_stat: parsed.key_stat?.trim()
      ? truncate(parsed.key_stat.trim(), MAX_KEY_STAT_CHARS)
      : null,
    key_quote: parsed.key_quote?.trim()
      ? truncate(parsed.key_quote.trim(), MAX_KEY_QUOTE_CHARS)
      : null,
    key_takeaways: (parsed.key_takeaways ?? [])
      .slice(0, MAX_TAKEAWAYS)
      .map(t => truncate(t?.trim(), MAX_TAKEAWAY_CHARS))
      .filter(Boolean)
  };
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchPending() {
  const { data, error } = await supabase
    .from('feed_items')
    .select('id, title, original_content')
    .eq('niche', 'trades')
    .is('question_headline', null)
    .order('published_at', { ascending: false })
    .limit(MAX_ITEMS);
  if (error) throw error;
  return data ?? [];
}

// --- Main ---
const items = await fetchPending();
console.log(`Found ${items.length} items to backfill${DRY_RUN ? ' (DRY RUN - no writes)' : ''}.`);
console.log(`Model: ${model}`);
console.log('');

let ok = 0;
let failed = 0;

for (const item of items) {
  try {
    const fields = await enrichGeoFields(item.title, item.original_content);

    if (DRY_RUN) {
      console.log(`[dry-run] ${item.id.slice(0, 8)} -> ${fields.question_headline}`);
    } else {
      const { error } = await supabase
        .from('feed_items')
        .update(fields)
        .eq('id', item.id);
      if (error) throw error;
      console.log(`+ ${item.id.slice(0, 8)} - ${fields.question_headline}`);
    }
    ok++;
  } catch (err) {
    console.error(`x ${item.id.slice(0, 8)} - ${err.message}`);
    failed++;
  }

  if (items.indexOf(item) < items.length - 1) {
    await sleep(DELAY_MS);
  }
}

console.log('');
console.log(`Done. ${ok} ${DRY_RUN ? 'would update' : 'updated'}, ${failed} failed.`);
