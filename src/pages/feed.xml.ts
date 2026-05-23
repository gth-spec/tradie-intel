import type { APIRoute } from 'astro';
import { publicClient } from '@/lib/supabase';
import { SITE } from '@/config/site';

export const prerender = false;

function escape(s: string): string {
  return s.replace(/[<>&'"]/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!
  ));
}

export const GET: APIRoute = async () => {
  const supa = publicClient();
  const { data } = await supa
    .from('feed_items')
    .select('*')
    .eq('niche', SITE.niche)
    .gte('relevance_score', 40)
    .order('published_at', { ascending: false })
    .limit(30);

  const items = (data ?? []).map((i: {
    title: string; slug: string; ai_summary: string; published_at: string; original_url: string;
  }) => `  <item>
    <title>${escape(i.title)}</title>
    <link>${SITE.url}/news/${i.slug}</link>
    <guid isPermaLink="true">${SITE.url}/news/${i.slug}</guid>
    <description>${escape(i.ai_summary ?? '')}</description>
    <pubDate>${new Date(i.published_at).toUTCString()}</pubDate>
    <source url="${escape(i.original_url)}">External source</source>
  </item>`).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${escape(SITE.name)}</title>
  <link>${SITE.url}</link>
  <description>${escape(SITE.email.ctaSubhead)}</description>
  <language>en-au</language>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
</channel>
</rss>`;

  return new Response(xml, {
    status: 200,
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' }
  });
};
