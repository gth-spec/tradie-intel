# Next Actions

## RESUME HERE - Digest Builder Smoke Test + Deploy

**Status:** Build complete on `feature/digest-builder` branch. 16 commits, 89 tests passing. Ready to merge + ship.

**Worktree:** `/Users/Greg/ClaudeCode/projects/tradie-intel/.worktrees/digest-builder` (on branch `feature/digest-builder`)

### Steps to ship (in order)

1. **Add `AGENTMAIL_API_KEY` to Vercel**
   - Value is in `~/.zshrc` as `AGENTMAIL_API_KEY`
   - Vercel dashboard → `tradie-intel` project → Settings → Environment Variables → add for Production

2. **Verify other Vercel env vars are correct:**
   - `EMAIL_PROVIDER=loops`
   - `EMAIL_PROVIDER_API_KEY=3d0926bd55211346e5dbee3c3c08d826` (Loops API key)
   - `CRON_SECRET` (existing)
   - `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `ANTHROPIC_API_KEY` (existing)

3. **Merge to main and push**
   ```bash
   cd /Users/Greg/ClaudeCode/projects/tradie-intel
   git checkout main
   git merge feature/digest-builder
   git push origin main
   ```
   Vercel auto-deploys on push.

4. **Run dry-run on deployed site**
   ```bash
   CRON_SECRET=$(grep CRON_SECRET .env | cut -d= -f2)
   curl -s -H "Authorization: Bearer $CRON_SECRET" \
     'https://tradieintel.com.au/api/cron/send-digest?dryRun=1' | jq .
   ```
   Expected: `articles_selected: 5`, `lookback_days: 7` or 14, `dry_run_lmx_length: ~2000+`. If `articles_selected: 0`, the `feed_items` table is empty - trigger refresh-feeds cron first.

5. **Clean up Loops test campaign**
   - Campaign `cmpmmjxdu2r630jx81hajrl2l` ("API Probe Test Campaign") was created during API verification
   - Delete from Loops UI (no DELETE API available)

6. **First live Tuesday run will fire automatically at UTC 21:00 Monday = AEST 07:00 Tuesday**
   - QA email will land at `gth@gthdigitalmarketing.com.au` from `tradieintel-qa@agentmail.to`
   - Click button in email → opens Loops UI campaign editor
   - Review the rendered LMX preview in Loops
   - Click Send in Loops UI to send to subscribers

### Worktree cleanup (after merge)

```bash
cd /Users/Greg/ClaudeCode/projects/tradie-intel
git worktree remove .worktrees/digest-builder
git branch -d feature/digest-builder
```

## Architecture notes (post-pivot)

Original plan assumed Loops had send/schedule API endpoints. Live probing revealed:
- ❌ Loops API does NOT accept raw HTML - requires their proprietary LMX markup
- ❌ Loops API does NOT support send/schedule - campaigns must be sent from the UI
- ✅ Loops API CAN create draft campaigns and update content with LMX

The implementation now:
1. Cron creates a Loops draft campaign with LMX content (auto-formatted from articles)
2. AgentMail emails Greg a link to the Loops UI campaign
3. Greg reviews + clicks Send in Loops UI (manual)
4. `digest_runs` row stays in `draft` status (no webhook back from Loops to mark sent yet)

Backlog item: add a Loops webhook handler to update `digest_runs.status` to `sent` when Greg sends from the UI. Not blocking v1.

## Backlog

- [ ] Create `subscribers` Supabase migration - local record of signups for analytics/export/backup. Loops is source of truth. Not urgent.
- [ ] AgentMail upgrade to Developer ($20/month) when digest launches - enables branded inboxes (digest@tradieintel.com.au etc.)
- [ ] Wire AgentMail triage inbox for reader replies once digest is live
- [ ] Per-source relevance threshold config (Energy Magazine disabled due to 75% fail rate - may want to revisit other low-performing sources)
- [ ] `/news` page: consider adding trade/state tag filtering UI as article volume grows
- [ ] Loops webhook → update `digest_runs.status` to `sent` after manual send (closes the tracking loop)
- [ ] Tighten DMARC from `p=none` to `p=quarantine` once sending history is clean (weeks not days)
- [ ] **r/tradies Reddit feed** - Reddit blocks Node fetch (TLS fingerprint mismatch). Use Reddit OAuth API (register app at reddit.com/prefs/apps, bearer token). Pull root post only, no comments. Filter by upvote threshold to reduce noise (community Q&A, not news). Add as new source type in feeds.ts + fetchSource handler in refresh-feeds.ts.
