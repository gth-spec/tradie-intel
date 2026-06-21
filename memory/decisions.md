# Decisions

## 2026-05-23
- **tradieintel.com.au is canonical domain** - tradieintel.au set as 301 redirect, not a second primary
- **Cloudflare proxy disabled (DNS only)** - Vercel handles SSL directly; proxying caused SSL handshake issues with Full (Strict)
- **Email provider: Kit** - ConvertKit/Kit selected over Loops/Mailchimp for email capture
- **Scraping: Firecrawl primary, Apify fallback** - Firecrawl free tier (500 scrapes/month) is primary; Apify is fallback only

## 2026-05-27
- **Digest send day: Tuesday 07:00 AEST, not Monday** - Tradies' inboxes overflow Mondays with weekend admin catch-up; the digest gets buried. Tuesday lands when attention is back and is also stronger for B2B social engagement. Cron expression `0 21 * * 1` in vercel.json is UTC and rolls into Tue 07:00 AEST — easy to misread as Monday. Refresh-feeds runs `0 20 * * *` (06:00 AEST daily) so the Tuesday feed refresh completes 1 hour before digest selection.
- **GrokoryAI content pipeline chains off digest approval, not a parallel cron** - Greg's editorial decision on which articles matter is made once at the digest agentmail.to approve link. Both the TradieIntel subscriber digest (via Resend broadcast) and the GrokoryAI derivative content (Phase 2/3: blog, newsletter, social) use the same approved selection. The GrokoryAI content gate (~30-60 min Tue 09:00) is purely brand/voice/angle review — not "are these the right stories" relitigation. SOP: `~/ClaudeCode/processes/grokoryai/tradieintel-content-pipeline-sop.md`.
- **Email provider: Resend (replaces Loops swap that never went live)** - Kit free tier lacked broadcast API; the May-22 plan was to switch to Loops but Resend won instead. Resend handles both capture (`ResendProvider` in `src/lib/email.ts`, contacts API with `unsubscribed` toggle for consent) AND digest broadcasts (`createResendBroadcast` + `sendResendBroadcast` in `src/lib/digest.ts`). Send is immediate on approve, not the +15 min scheduled-broadcast trick Loops needed. Env: `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `RESEND_SEGMENT_ID=0dfd2746-a869-4ea0-93b3-2b308fe32b2e`, `RESEND_FROM='TradieIntel <hello@tradieintel.com.au>'`. Landed in 8 commits on `feature/digest-builder` branch; handover: `docs/superpowers/handovers/2026-05-27-resend-swap-handover.md`. **Do not reintroduce Loops anywhere.**
