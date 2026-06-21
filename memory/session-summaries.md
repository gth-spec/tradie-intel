## 2026-05-26

### AgentMail setup
- Evaluated AgentMail as a tool stack addition - recommended free tier for TradieIntel only (not GrokoryAI yet)
- Installed AgentMail CLI globally via npm (`agentmail-cli` v0.7.12)
- Added `AGENTMAIL_API_KEY` to `~/.zshrc` (persists across sessions)
- Created all 3 free-tier inboxes:
  - `tradieintel-monitor@agentmail.to` - source monitoring (low priority - RSS/Firecrawl already handles ingestion)
  - `tradieintel-qa@agentmail.to` - digest QA before send
  - `tradieintel-triage@agentmail.to` - reader replies once digest launches
- Free tier now at capacity (3/3 inboxes). Upgrade to Developer ($20/month) when digest goes live and branded addresses needed
- Added Kit MCP server (`https://app.kit.com/mcp`) to `~/.claude/settings.json` - requires Claude Code restart + OAuth to activate

### TradieIntel site - deployed to production
- Added all 11 env vars to Vercel via CLI (was previously blocked on EMAIL_LIST_ID - already in .env)
- Deployed tradieintel.com.au to production - live and clean
- Fixed article date timezone bug: dates now render in `Australia/Sydney` time (was rendering UTC, showing previous day for AEST readers)
- Fixed news archive relevance filter: `/news` now filters `relevance_score >= 40` (was showing all 54 items including low-quality noise)

### Feed config changes
- Disabled Energy Magazine AU (RSS): 75% of articles failing relevance filter, avg score 28
- Added National AI Centre as scrape source (`ai.gov.au/news-and-insights`) - no RSS available, Firecrawl scrape works cleanly
- Added Master Electricians AU as scrape source (`masterelectricians.com.au/news`) - RSS previously failed, scrape confirmed working, high-relevance content
- Active feed roster now 7 sources: Master Plumbers AU (RSS), Master Electricians AU (scrape), National AI Centre (scrape), Sourceable (scrape), HIA News (scrape), Master Builders AU News (scrape), Fair Work Ombudsman News (scrape), Safe Work Australia News (scrape)

### Digest builder - design scoped (not yet built)
- Full brainstorm completed. Design approved in sections. Spec NOT yet written - session ended at final revision stage
- Architecture: weekly digest, Tuesday 7am AEST, top 5 articles by relevance score, human approval via AgentMail QA inbox, Kit broadcast API for send
- Two hard blockers discovered - must resolve before implementation begins (see Next Actions)
- See docs/superpowers/specs/ for spec once written next session

### Supabase state
- 54 articles in feed_items (trades niche), 40 passing relevance filter
- No `subscribers` table (Kit is source of truth for subscribers - local table backlog item)
- No `digest_runs` table yet (part of digest builder spec)

## 2026-05-24

- Checked Firecrawl account usage via dashboard (Chrome MCP): Free plan, 983/1,000 credits remaining, 317 credits used over last 30 days (~32% of allocation)
- Max concurrency is 2 on free plan - identified as the likely bottleneck causing slow scraping, not credit limits
- Decision: if scraping performance becomes a blocker, upgrade Firecrawl to Hobby (~$16 USD/month) before considering Apify paid; Apify free ($5/month) is too limited to justify migration

## 2026-05-23

- Moved tradieintel.com.au and tradieintel.au nameservers to Cloudflare; SSL upgraded to Full (Strict)
- Fixed DNS: tradieintel.com.au A record updated from 103.42.108.46 → 76.76.21.21 (Vercel); tradieintel.au A record already correct at 76.76.21.21 - both set to DNS only (grey cloud)
- Configured tradieintel.au as 301 redirect → https://tradieintel.com.au in Vercel
- Created tradie-intel Vercel project linked to gth-spec/tradie-intel GitHub repo; Astro preset confirmed
- Updated .env: EMAIL_PROVIDER set to kit, EMAIL_PROVIDER_API_KEY added; FIRECRAWL_API_KEY and APIFY_TOKEN identified for Vercel env vars
- Env vars staged for Vercel deployment; Kit EMAIL_LIST_ID and API key rotation still outstanding
