# Bugs and Risks

## Risks

- **Exposed API keys** - Anthropic, Supabase, Firecrawl, and Apify keys were shared in chat 2026-05-23. Rotate all before go-live.
- **CLAUDE_MODEL pinned to claude-sonnet-4-5-20250929** - May need updating as models deprecate
- **Firecrawl free tier** - 500 scrapes/month; if feed volume grows this will hit the ceiling quickly
