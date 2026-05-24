import type { APIRoute } from 'astro';
import { publicClient } from '@/lib/supabase';
import { SITE } from '@/config/site';

export const prerender = false;

export const GET: APIRoute = async () => {
  const supa = publicClient();
  const { data } = await supa
    .from('feed_items')
    .select('title, slug, summary, published_at')
    .eq('niche', SITE.niche)
    .order('published_at', { ascending: false })
    .limit(50);

  const today = new Date().toISOString().slice(0, 10);

  const articles = (data ?? [])
    .map((item: { title: string; slug: string; summary?: string; published_at: string }) => {
      const note = item.summary ? `: ${item.summary.slice(0, 120).replace(/\n/g, ' ')}` : '';
      return `- [${item.title}](${SITE.url}/news/${item.slug})${note}`;
    })
    .join('\n');

  const content = `# ${SITE.name}

> ${SITE.description} Part of the ${SITE.parent.name} network (${SITE.parent.url}). Covers AI tools, automation, industry news, and business intelligence relevant to Australian trade operators - plumbers, electricians, builders, HVAC, and related trades.

Daily AI-curated news feed for Australian tradies. All articles are filtered and summarised by AI for relevance to trade business operators. Site is updated daily via automated feed pipeline.

## Key Pages

- [Home](${SITE.url}/): Latest AI-curated news for Australian tradies
- [News Archive](${SITE.url}/news): Full archive of trade industry news and AI updates
- [About](${SITE.url}/about): What Tradie Intel is, who it is for, and how it works

## Recent Articles (last updated ${today})

${articles}
`;

  return new Response(content, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
};
