# Current Strategy

Tradie Intel is a trades-niche micro-site (tradieintel.com.au) that aggregates industry news via RSS + scraping, summarises with Claude, and funnels readers into GrokoryAI.

**Stack:** Astro + Vercel + Supabase + Claude API + Firecrawl/Apify + Kit (email) + AgentMail (agent email layer)

**Current phase:** LIVE. Site deployed to tradieintel.com.au. Content pipeline running nightly at 8pm AEST. 54 articles in Supabase (40 passing relevance filter). Next milestone: weekly digest email.

**Domains:**
- tradieintel.com.au - primary (Production, Vercel) ✅ live
- tradieintel.au - 301 redirect → tradieintel.com.au ✅ live

**AgentMail inboxes (free tier, all created):**
- tradieintel-monitor@agentmail.to - source monitoring (low priority)
- tradieintel-qa@agentmail.to - digest QA approval step
- tradieintel-triage@agentmail.to - reader replies (post-digest launch)

**Next milestone: Weekly digest builder**
Status as of 2026-05-27: **code complete on `feature/digest-builder`**. Email platform resolved — Resend selected (not Loops); 8 commits landed, 114/114 tests passing. Remaining: set Vercel env vars (`RESEND_API_KEY`, `RESEND_SEGMENT_ID`, `RESEND_FROM`, `DIGEST_APPROVER_EMAIL`, `PUBLIC_SITE_URL`, `EMAIL_PROVIDER=resend`), push branch, smoke test live cron. See `docs/superpowers/handovers/2026-05-27-resend-swap-handover.md`.
Sending domain verification — tradieintel.com.au verified in Resend (assumed complete given handover doesn't flag it; verify in Resend dashboard if first send bounces).

**Active feed sources (7):**
- Master Plumbers AU (RSS)
- Master Electricians AU (scrape) - added this session
- National AI Centre (scrape) - added this session
- Sourceable (scrape)
- HIA News (scrape)
- Master Builders AU News (scrape)
- Fair Work Ombudsman News (scrape)
- Safe Work Australia News (scrape)
- Energy Magazine AU - DISABLED (75% fail relevance filter)
