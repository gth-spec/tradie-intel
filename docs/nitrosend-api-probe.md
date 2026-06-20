# NitroSend REST API — Task 0 probe findings (2026-06-20)

Live-confirmed against `https://api.nitrosend.com/v1/my` with the account API key (`NITROSEND_API_KEY`, Bearer). Backend = **managed SES** (Resend disconnected from NitroSend; BYO Resend is a future fast-follow, code-identical). Send list = **`NITROSEND_LIST_ID = 265`** ("TradieIntel Weekly Digest").

## Confirmed call shapes

### Contacts (Task 1 / Task 7)
- **Create:** `POST /contacts` body `{ "email": "...", "opt_in": true|false }` → `200/201 { "id": <int>, ... }`. (`opt_in` may echo `null` in the response but is applied.) Treat a duplicate as success (idempotent subscribe).
- **Add to list:** `POST /lists/{listId}/contacts/bulk` body **`{ "action": "add", "emails": ["..."] }`** → `{ "added": n, "already_in_list": [...], "invalid_emails": [...] }`.
  - **`action` is REQUIRED** — omitting it returns `422 invalid_action "Unknown action: "`. Values: `"add"` / `"remove"`. (This corrects the plan's Task 1 draft, which sent `{emails}` with no action.)

### Suppression (compliance gate — PASS)
Confirmed earlier via MCP: a campaign targeting a list containing one `opt_in:true` + one `opt_in:false` contact reports **audience count = 1** ("1 subscribed contacts"). NitroSend **excludes opted-out contacts** from list sends. Spam Act suppression holds at send time.

### Campaign send sequence (the decision gate — Task 3 / Task 5)
A campaign **auto-creates its own bound template**; you edit *that*, not a standalone template. `PATCH /campaigns/{id}` rejects `template_id` ("not a valid update key"). Confirmed sequence:

1. `POST /campaigns` body `{ "name": "...", "channel": "email" }` → `{ "id": <campaignId>, "status": "draft", ... }`.
2. Read the bound template from `GET /campaigns/{id}` → `template.id` and `template.version` (fresh campaigns: empty `design`, `version: 1`).
3. `PATCH /templates/{boundTemplateId}` body `{ "subject": "...", "preheader": "...", "if_version": <currentVersion>, "design": { "version": 2, "theme": {}, "sections": [ <header>, <text…>, <footer> ] } }` → sets content; bumps `version`. **`if_version` is REQUIRED** (optimistic concurrency).
4. `PATCH /campaigns/{id}` body `{ "trigger_attributes": { "event": "manual", "audience_type": "lists", "contact_list_ids": [265] } }` → sets audience. (Send audience-only; do NOT include `template_id`.)
5. Send: `POST /campaigns/{id}/send` (live). Test: `POST /campaigns/{id}/send_test` body `{ "send_test_to": ["addr", ...] }` → `{ "sent": n, "results": [{email, success}] }` — **verified end-to-end to a Gmail seed via managed SES.**

So `createNitrosendCampaign` (Task 3) = steps 1→4 returning `campaignId`; `sendNitrosendCampaign` = step 5. The plan's Task-3 skeleton (separate `POST /templates` + PATCH campaign `template_id`) is **superseded by the above** — use the campaign's bound template.

### Sections (design) shape
`design.sections[]` items are `{ "type": "header"|"text"|"footer"|…, "props": { … } }`. Header wordmark: `{ "type":"header", "props": { "variant":"wordmark", "wordmark_text":"TradieIntel", "wordmark_color":"#ffffff", "background_color":"#0f766e" } }`. Text: `{ "type":"text", "props": { "content": "<html…>" } }`. Footer: `{ "type":"footer" }` (auto-fills company name + physical address + unsubscribe from the brand kit).

## Gotchas
- **Rate limit: 2 requests/sec.** Space calls (a burst caused duplicate-domain entries earlier in the saga).
- **No campaign DELETE** (campaigns: GET/POST/PATCH/send only). Task 6 cleanup = mark `digest_runs` row `expired` in our DB; optionally `PATCH /campaigns/{id} {status:"cancelled"}` if needed (not required).
- **Template update needs `if_version`**; a stale token returns `409`.
- Probe artifacts left in the account (harmless, no API delete): standalone template 2546, campaigns 790/793/940. List 265 is clean.
