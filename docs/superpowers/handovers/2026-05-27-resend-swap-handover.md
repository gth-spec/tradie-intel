# Handover - Resend swap (2026-05-27)

**Branch:** `feature/digest-builder` (worktree at `.worktrees/digest-builder`)
**Plan:** `docs/superpowers/plans/2026-05-27-resend-swap.md`
**Status:** All code work complete. Smoke test + Vercel env are the only remaining steps.

---

## What landed today (8 commits, 1 follow-up)

| Commit | What |
|---|---|
| `90c3348` | Env vars: `RESEND_API_KEY`, `RESEND_SEGMENT_ID`, `RESEND_FROM`, `DIGEST_APPROVER_EMAIL`, `PUBLIC_SITE_URL` in `env.d.ts` + `.env.example` |
| `51f0bb8` + `bdd7a59` | Reverted yesterday's two pivot commits to restore the HTML builder + approve endpoint scaffolding |
| `33dbd9e` | `createResendBroadcast` / `sendResendBroadcast` in `src/lib/digest.ts` (replaced Loops broadcast funcs) |
| `dac131b` | `/api/digest/approve.ts` now calls Resend send; status guard widened to `!== 'draft'`; HTML errors escaped; 502 on Resend failure |
| `81f3bdb` | Cron `/api/cron/send-digest.ts` creates Resend draft, signs HMAC token, emails approve link via AgentMail; QA email copy is now "Approve and send" |
| `64647fe` | `ResendProvider` in `src/lib/email.ts` with consent → `unsubscribed` forwarding; fast-fail env-var guards in `getProvider()` |
| `6ff7173` | Follow-up: `deleteResendBroadcast` helper + `cleanupStaleDrafts(supa, resendKey?)` cancels orphan Resend drafts on expiry |

**Tests:** 114 / 114 passing across 11 files.
**TypeScript:** 0 new errors. One pre-existing unrelated error in `tests/lib/related.test.ts` (`question_headline` type mismatch) — not introduced here.

---

## What is NOT done (Task 7)

The Vercel-side work needs your hands. From the plan:

### 1. Set Vercel env vars (project `tradieintel`, Production)
- `RESEND_API_KEY` — paste from Resend dashboard → API Keys
- `RESEND_SEGMENT_ID` = `0dfd2746-a869-4ea0-93b3-2b308fe32b2e`
- `RESEND_FROM` = `TradieIntel <hello@tradieintel.com.au>`
- `DIGEST_APPROVER_EMAIL` = `hello@tradieintel.com.au`
- `PUBLIC_SITE_URL` = `https://tradieintel.com.au`
- `EMAIL_PROVIDER` = `resend`

### 2. Push the branch
```bash
cd /Users/Greg/ClaudeCode/projects/tradie-intel/.worktrees/digest-builder
git push -u origin feature/digest-builder
```

### 3. Dry-run against the preview deploy
```bash
curl -s "https://<preview-url>/api/cron/send-digest?dryRun=1" \
  -H "Authorization: Bearer $CRON_SECRET" | jq
```
Expected: `dry_run: true`, `articles_selected >= 3`, `subject`, `dry_run_html_length > 0`. No Resend call.

### 4. Real run against preview
```bash
curl -s "https://<preview-url>/api/cron/send-digest" \
  -H "Authorization: Bearer $CRON_SECRET" | jq
```
Expected fields: `broadcast_id`, `run_id`, `approve_url`, `qa_email_sent: true`.

### 5. Verify
- Resend dashboard → Broadcasts: new draft with the expected subject + HTML preview
- AgentMail QA inbox forwards the approval email to `hello@tradieintel.com.au`
- Supabase `digest_runs` table: new row with `status='draft'` and matching `broadcast_id`

### 6. Click the approve link
Browser should show "Digest sent". Resend broadcast status flips draft → sending → sent. `digest_runs.status` flips to `sent` with `sent_at` populated. The General segment is empty, so no actual delivery happens — this validates the API plumbing.

### 7. Negative smokes
- Hit the approve URL a second time → 409 "Not draftable" with current status shown
- Hit `/api/digest/approve?token=garbage` → 401 "Invalid or expired link"

### 8. Open the PR
```bash
gh pr create --base main --title "Replace Loops with Resend for digest broadcast and subscribe form" --body "$(cat <<'EOF'
## Summary
- Replaces Loops with Resend across the weekly digest cron and the subscribe form
- Restores the one-click approve flow (pre-pivot) - cron creates Resend draft, AgentMail sends signed approve link to hello@tradieintel.com.au, click triggers Resend send-broadcast
- cleanupStaleDrafts now cancels orphan Resend drafts when expiring rows

## Test plan
- [x] All unit tests green (114/114)
- [ ] Vercel preview deploy is green
- [ ] Dry-run cron returns articles_selected >= 3 and dry_run_html_length > 0
- [ ] Real cron creates Resend draft, inserts digest_runs row, sends QA email
- [ ] Approve link flips broadcast to sent and digest_runs.status to sent
- [ ] Second click returns 409 with status shown
- [ ] Bad token returns 401
EOF
)"
```

---

## Architectural changes worth noting

### Token shape
The HMAC token payload is `{ run_id, broadcast_id, exp }` (from the pre-pivot code). The plan originally assumed a simpler runId-only payload — kept the existing 3-field shape because the broadcast_id in the token closes a tiny TOCTOU window vs reading it back from the DB only. The approve endpoint still treats the DB row as the source of truth; the token field is verified-but-unused.

### Status guard widening
The approve endpoint's 409 now fires for any `status !== 'draft'` (not just `'sent'`). This catches `expired`, `skipped`, and the unused `approved` state. The user gets the actual status in the response.

### Resend draft cleanup
`cleanupStaleDrafts` now takes an optional `resendKey`. With it, orphan Resend drafts are DELETEd; without it (or when key is empty), only the DB row flips to `expired`. 404 tolerated silently; other failures logged via `console.warn` so one bad row doesn't block the rest.

---

## Resend account state (verified 2026-05-27)

- Domain `tradieintel.com.au` — **verified**, sending enabled, region ap-northeast-1
- Segment "General" — id `0dfd2746-a869-4ea0-93b3-2b308fe32b2e`, currently **empty** (zero contacts)
- API shapes confirmed against live docs:
  - `POST /broadcasts` — body `{ segment_id, from, subject, html, name, reply_to? }` → `{id}`
  - `POST /broadcasts/{id}/send` — optional body `{ scheduled_at }` → `{id}`
  - `DELETE /broadcasts/{id}` — drafts only, 404 if already gone → `{object, id, deleted}`
  - `POST /contacts` — body `{ email, segments: [{id}], properties?, unsubscribed? }` → `{object, id}`

No Loops→Resend contact migration was needed (empty segment, no existing subscribers).

---

## Files you might want to revisit

- `src/lib/digest.ts` - all the Resend client functions, HMAC token helpers, QA email helpers, cleanup
- `src/pages/api/cron/send-digest.ts` - the orchestrator
- `src/pages/api/digest/approve.ts` - the user-clickable approve handler
- `src/lib/email.ts` - subscribe-form ResendProvider
- `docs/superpowers/plans/2026-05-27-resend-swap.md` - the full plan (with API freshness notes in header)
- `tests/lib/digest.test.ts` - 33 tests; main digest coverage
- `tests/lib/email.test.ts` - 11 tests; ResendProvider coverage
- `tests/pages/api/digest/approve.test.ts` - 7 tests; approve endpoint coverage

---

## Open items / future work

- Once subscribers exist in the General segment, the Loops workspace can be torn down (no migration needed).
- `LoopsProvider` class still lives in `src/lib/email.ts` as a sibling. Safe to delete in a future cleanup pass.
- The `'loops'` literal in `EMAIL_PROVIDER` union (env.d.ts:8) and the `'loops'` case in `getProvider()` switch are dead but harmless — same future cleanup pass.
