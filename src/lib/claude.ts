import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { ALLOWED_TAGS, TAG_ALIASES, STATES } from '@/config/tags';

const STATE_SET = new Set<string>(STATES);

// Operational caps - prevents the AI returning paragraphs where a sentence is asked for.
const MAX_SUMMARY_CHARS = 300;
const MAX_WHY_CHARS = 150;

const EnrichmentResponseSchema = z.object({
  summary: z.string().min(1),
  why_it_matters: z.string().min(1),
  relevance_score: z.number(),
  tags: z.array(z.string()).default([])
});

export interface Enrichment {
  summary: string;
  whyItMatters: string;
  relevanceScore: number;
  tags: string[];
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
  "why_it_matters": "ONE sentence, max 150 characters. Practical impact on a trades operator's day-to-day business.",
  "relevance_score": <integer 0-100>,
  "tags": [<2-5 tags from the controlled vocabulary>]
}

Controlled tag vocabulary (use ONLY these): ${tagList}

Article title: ${title}
Article content: ${content}

Respond with JSON only.`;
}

export async function enrich(input: EnrichmentInput): Promise<Enrichment> {
  const apiKey = import.meta.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const model = (import.meta.env.CLAUDE_MODEL ?? process.env.CLAUDE_MODEL) || 'claude-sonnet-4-5-20250929';
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: enrichmentPrompt(input) }]
  });
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text).join('').trim();

  // Tolerate Claude wrapping JSON in code fences despite instructions.
  const stripped = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();

  let parsed: unknown;
  try { parsed = JSON.parse(stripped); }
  catch { throw new Error(`Claude returned non-JSON: ${text.slice(0, 200)}`); }

  const validated = EnrichmentResponseSchema.parse(parsed);

  return {
    summary: truncate(validated.summary.trim(), MAX_SUMMARY_CHARS),
    whyItMatters: truncate(validated.why_it_matters.trim(), MAX_WHY_CHARS),
    relevanceScore: Math.max(0, Math.min(100, Math.round(validated.relevance_score) || 0)),
    tags: normaliseTags(validated.tags.map(String))
  };
}
