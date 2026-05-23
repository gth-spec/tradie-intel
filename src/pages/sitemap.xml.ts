import type { APIRoute } from 'astro';
import { publicClient } from '@/lib/supabase';
import { SITE } from '@/config/site';

export const prerender = false;

export const GET: APIRoute = async () => {
  const supa = publicClient();
  const { data } = await supa
    .from('feed_items')
    .select('slug, published_at')
    .eq('niche', SITE.niche)
    .order('published_at', { ascending: false })
    .limit(5000);

  const today = new Date().toISOString().slice(0, 10);
  const staticUrls = [
    { loc: `${SITE.url}/`, lastmod: today, changefreq: 'daily', priority: '1.0' },
    { loc: `${SITE.url}/news`, lastmod: today, changefreq: 'daily', priority: '0.9' },
    { loc: `${SITE.url}/about`, lastmod: today, changefreq: 'monthly', priority: '0.5' },
    { loc: `${SITE.url}/privacy`, lastmod: today, changefreq: 'yearly', priority: '0.2' },
    { loc: `${SITE.url}/terms`, lastmod: today, changefreq: 'yearly', priority: '0.2' },
  ];

  const itemUrls = (data ?? []).map((item: { slug: string; published_at: string }) => ({
    loc: `${SITE.url}/news/${item.slug}`,
    lastmod: item.published_at.slice(0, 10),
    changefreq: 'monthly',
    priority: '0.7'
  }));

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...staticUrls, ...itemUrls].map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${u.lastmod}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

  return new Response(xml, {
    status: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' }
  });
};
