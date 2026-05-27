#!/usr/bin/env node
// Verify each enabled scrape source in src/config/feeds.ts by running the
// real Firecrawl + Claude extraction pipeline against it. Exits non-zero if
// any source returns zero items.
//
// Inline copy of the enabled scrape FEEDS for verification only. Canonical
// list is in src/config/feeds.ts - keep in sync.
//
// Usage: node --env-file=.env.local scripts/verify-scrapes.mjs

import Anthropic from '@anthropic-ai/sdk';

const FEEDS = [
  { name: 'Master Electricians AU',     url: 'https://www.masterelectricians.com.au/news' },
  { name: 'National AI Centre',         url: 'https://www.ai.gov.au/news-and-insights/blog' },
  { name: 'Sourceable',                 url: 'https://sourceable.net/' },
  { name: 'HIA News',                   url: 'https://hia.com.au/our-industry/newsroom' },
  { name: 'Master Builders AU News',    url: 'https://masterbuilders.com.au/Newsroom' },
  { name: 'Fair Work Ombudsman News',   url: 'https://www.fairwork.gov.au/about-us/news-and-media-releases' },
  { name: 'Safe Work Australia News',   url: 'https://www.safeworkaustralia.gov.au/media-centre' },
  { name: 'Plumbing Connection',        url: 'https://plumbingconnection.com.au/category/industry-news' },
  { name: 'Electrical Connection',      url: 'https://electricalconnection.com.au/category/industry-news' },
  { name: 'HVAC&R News',                url: 'https://hvacrnews.com.au/' },
  { name: 'Build Australia',            url: 'https://www.buildaustralia.com.au/all-news/' }
];

const FIRECRAWL_ENDPOINT = 'https://api.firecrawl.dev/v1/scrape';
const DEFAULT_MODEL = 'claude-sonnet-4-5';

const EXTRACTION_PROMPT = `You are extracting recent news articles from a scraped news/index page for an Australian trades industry feed (plumbers, electricians, builders, allied trades).

Return a JSON array of articles found on this page. Each article must have:
- title: the article headline
- link: the URL to the full article (absolute or root-relative)
- published_at: publication date as an ISO 8601 string (best estimate if only a date is shown; if no date is visible at all, use today's date)
- content: a short excerpt or summary from the page (max ~400 chars)

Only include items that look like genuine recent news articles, regulatory updates, industry announcements, or licensing/safety/workplace bulletins relevant to Australian trades or construction. Exclude navigation links, login links, category pages, generic "about us" links, ads, and event/registration links.

Respond with ONLY a valid JSON array - no prose, no markdown code fences. If no relevant articles are present, respond with [].

Page markdown:
---
{{MARKDOWN}}
---`;

const firecrawlKey = process.env.FIRECRAWL_API_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY;
if (!firecrawlKey || !anthropicKey) {
  console.error('Missing FIRECRAWL_API_KEY or ANTHROPIC_API_KEY. Run with: node --env-file=.env.local scripts/verify-scrapes.mjs');
  process.exit(2);
}

const anthropic = new Anthropic({ apiKey: anthropicKey });

function stripCodeFences(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1] : text;
}

async function verifyOne(feed) {
  const start = Date.now();
  // Step 1: Firecrawl
  let markdown = '';
  try {
    const res = await fetch(FIRECRAWL_ENDPOINT, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: feed.url, formats: ['markdown'], onlyMainContent: true })
    });
    if (!res.ok) {
      return { name: feed.name, ok: false, items: 0, error: `Firecrawl ${res.status}`, ms: Date.now() - start };
    }
    const json = await res.json();
    markdown = json?.data?.markdown ?? '';
    if (!markdown) {
      return { name: feed.name, ok: false, items: 0, error: 'empty markdown', ms: Date.now() - start };
    }
  } catch (err) {
    return { name: feed.name, ok: false, items: 0, error: `firecrawl: ${err.message?.slice(0, 60)}`, ms: Date.now() - start };
  }

  // Step 2: Claude extraction
  let parsed;
  try {
    const response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || DEFAULT_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: EXTRACTION_PROMPT.replace('{{MARKDOWN}}', markdown) }]
    });
    const textBlock = response.content?.find(b => b.type === 'text');
    const stripped = stripCodeFences(textBlock?.text ?? '').trim();
    parsed = JSON.parse(stripped);
    if (!Array.isArray(parsed)) throw new Error('not an array');
  } catch (err) {
    return { name: feed.name, ok: false, items: 0, error: `claude: ${err.message?.slice(0, 60)}`, ms: Date.now() - start };
  }

  const sample = parsed[0] ?? {};
  return {
    name: feed.name,
    ok: parsed.length > 0,
    items: parsed.length,
    hasTitle: typeof sample.title === 'string',
    hasLink: typeof sample.link === 'string',
    hasDate: typeof sample.published_at === 'string',
    ms: Date.now() - start
  };
}

console.log(`Verifying ${FEEDS.length} scrape sources (real Firecrawl + Claude calls)...\n`);
const results = [];
for (const feed of FEEDS) {
  process.stdout.write(`  ${feed.name}... `);
  const r = await verifyOne(feed);
  const errSuffix = r.error ? ` — ${r.error}` : '';
  process.stdout.write(`${r.ok ? '✓' : '✗'} ${r.items} items (${r.ms}ms)${errSuffix}\n`);
  results.push(r);
}

// Use a printable subset for console.table so the error column survives.
// (console.table omits columns that are undefined on any row.)
console.table(results.map(r => ({
  name: r.name,
  ok: r.ok,
  items: r.items,
  hasTitle: r.hasTitle ?? false,
  hasLink:  r.hasLink  ?? false,
  hasDate:  r.hasDate  ?? false,
  ms: r.ms,
  error: r.error ?? ''
})));

const broken = results.filter(r => !r.ok || r.items === 0);
if (broken.length > 0) {
  console.error(`\n${broken.length} source(s) failed or returned 0 items.`);
  for (const b of broken) {
    console.error(`  • ${b.name}: ${b.error ?? '(no error message)'}`);
  }
  console.error(`\nTransient failures are common (Firecrawl hiccups, network blips).`);
  console.error(`Re-run once before disabling a source in src/config/feeds.ts.`);
  process.exit(1);
}
console.log('\nAll scrape sources healthy.');
