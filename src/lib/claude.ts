import Anthropic from '@anthropic-ai/sdk';
import { Anthropic as PosthogAnthropic } from '@posthog/ai/anthropic';
import { z } from 'zod';
import { ALLOWED_TAGS, TAG_ALIASES, STATES } from '@/config/tags';
import { getPosthog, flushPosthog } from './posthog';

const STATE_SET = new Set<string>(STATES);

const MAX_SUMMARY_CHARS = 300;
const MAX_WHY_CHARS = 250;
const MAX_QUESTION_HEADLINE_CHARS = 120;
const MAX_KEY_STAT_CHARS = 150;
const MAX_KEY_QUOTE_CHARS = 200;
const MAX_TAKEAWAY_CHARS = 120;
const MAX_TAKEAWAYS = 4;

const EnrichmentResponseSchema = z.object({
  summary: z.string().min(1),
  why_it_matters: z.string().min(1),
  relevance_score: z.number().finite(),
  tags: z.array(z.string()).default([]),
  question_headline: z.string().min(1),
  key_stat: z.string().nullish().default(null),
  key_quote: z.string().nullish().default(null),
  key_takeaways: z.array(z.string()).default([])
});

export interface Enrichment {
  summary: string;
  whyItMatters: string;
  relevanceScore: number;
  tags: string[];
  questionHeadline: string;
  keyStat: string | null;
  keyQuote: string | null;
  keyTakeaways: string[];
}

export interface EnrichmentInput {
  title: string;
  content: string;
}

export function normaliseTags(raw: string[]): string[] {
  const out = new Set<string>();
  for (const t of raw) {
    const lower = t.trim().toLowerCase();
    const canonical = TAG_ALIASES[lower] ?? lower;
    const final = STATE_SET.has(canonical.toUpperCase()) ? canonical.toUpperCase() : canonical;
    if (ALLOWED_TAGS.has(final)) out.add(final);
  }
  return Array.from(out);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

export function enrichmentPrompt({ title, content }: EnrichmentInput): string {
  const tagList = Array.from(ALLOWED_TAGS).join(', ');
  return `You are an editorial assistant for an Australian trades-industry news site. Read the article below and respond with a single JSON object - no prose, no markdown fences.

Required JSON shape:
{
  "summary": "2-3 sentence summary, max 300 characters. Plain English. No marketing language.",
  "why_it_matters": "1-2 sentences, max 250 characters. Name which trade types are affected (e.g. plumbers, electricians, builders). Practical impact on their day-to-day business.",
  "relevance_score": <integer 0-100>,
  "tags": [<2-5 tags from the controlled vocabulary>],
  "question_headline": "Rephrase the article title as a direct question a tradie would Google, max 120 characters. Example: 'How will the ACT housing reforms affect my building costs?'",
  "key_stat": "ONE specific number, dollar amount, or percentage from the article that anchors the story, max 150 characters. Include context (e.g. '$2.4 billion allocated to housing in the 2026 federal budget'). Return null if no specific figure exists in the article.",
  "key_quote": "A direct quote from a named person or official mentioned in the article, max 200 characters. Include the person's name and title (e.g. \\"This will cut delays by half\\" - Jane Smith, Master Builders CEO'). Return null if no named source is quoted.",
  "key_takeaways": ["Up to 4 bullet-point sentences, max 120 chars each. Plain English. Each one should be independently quotable. Return empty array if article is too thin."]
}

Controlled tag vocabulary (use ONLY these): ${tagList}

Article title: ${title}
Article content: ${content}

Respond with JSON only.`;
}

export function parseEnrichmentResponse(text: string): Enrichment {
  const stripped = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();

  let parsed: unknown;
  try { parsed = JSON.parse(stripped); }
  catch { throw new Error(`Claude returned non-JSON: ${text.slice(0, 200)}`); }

  const validated = EnrichmentResponseSchema.parse(parsed);

  const takeaways = validated.key_takeaways
    .slice(0, MAX_TAKEAWAYS)
    .map(t => truncate(t.trim(), MAX_TAKEAWAY_CHARS))
    .filter(t => t.length > 0);

  return {
    summary: truncate(validated.summary.trim(), MAX_SUMMARY_CHARS),
    whyItMatters: truncate(validated.why_it_matters.trim(), MAX_WHY_CHARS),
    relevanceScore: Math.max(0, Math.min(100, Math.round(validated.relevance_score))),
    tags: normaliseTags(validated.tags.map(String)),
    questionHeadline: truncate(validated.question_headline.trim(), MAX_QUESTION_HEADLINE_CHARS),
    keyStat: validated.key_stat?.trim() ? truncate(validated.key_stat.trim(), MAX_KEY_STAT_CHARS) : null,
    keyQuote: validated.key_quote?.trim() ? truncate(validated.key_quote.trim(), MAX_KEY_QUOTE_CHARS) : null,
    keyTakeaways: takeaways
  };
}

export async function enrich(input: EnrichmentInput): Promise<Enrichment> {
  // import.meta.env is Astro-injected and undefined under a plain Node runtime
  // (e.g. Trigger.dev). Optional-chain so the process.env fallback actually fires.
  const apiKey = (import.meta as any).env?.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const model = ((import.meta as any).env?.CLAUDE_MODEL ?? process.env.CLAUDE_MODEL) || 'claude-sonnet-4-6';

  const createParams = {
    model,
    max_tokens: 1024,
    messages: [{ role: 'user' as const, content: enrichmentPrompt(input) }]
  };

  // When PostHog is configured, route the call through the @posthog/ai wrapper so
  // it emits an $ai_generation event (model, tokens, cost, latency). Otherwise fall
  // back to the plain SDK - PostHog must never be a hard dependency of the pipeline.
  const phClient = getPosthog();
  let response: Anthropic.Message;
  if (phClient) {
    const client = new PosthogAnthropic({ apiKey, posthog: phClient });
    try {
      // Non-streaming params, so the runtime value is always a Message; the
      // wrapper's type widens to Message | Stream, hence the narrowing cast.
      response = (await client.messages.create({
        ...createParams,
        posthogDistinctId: 'tradie-intel-pipeline',
        posthogProperties: { project: 'tradie-intel', component: 'enrich', model }
      })) as Anthropic.Message;
    } finally {
      // One item per Trigger.dev run, so flush after each call to avoid losing
      // the event when the short-lived runtime exits.
      await flushPosthog();
    }
  } else {
    const client = new Anthropic({ apiKey });
    response = await client.messages.create(createParams);
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text).join('').trim();

  return parseEnrichmentResponse(text);
}
