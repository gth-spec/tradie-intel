# Confirmed Opt-In (Double Opt-In) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No email address reaches a TradieIntel or GrokoryAI send list until someone with access to that mailbox clicks a scoped confirmation link, with a per-sender consent record stored as Spam Act evidence.

**Architecture:** Signup mints a signed, self-expiring HMAC token per consent scope and sends one transactional confirmation email; nothing is subscribed at signup. Clicking a link writes the consent audit row first, then subscribes to that scope's list. Consent is split into two independent scopes (`tradieintel_digest` required, `grokoryai_commercial` optional) so a feeder subscription is never treated as consent to be marketed by the parent business. No pending-subscribers table exists — an unconfirmed signup leaves zero state.

**Tech Stack:** Astro 5 (SSR via `@astrojs/vercel`), TypeScript, Supabase (`@supabase/supabase-js`), Vitest 2, Node `crypto` (HMAC-SHA256), Resend REST API (raw `fetch`, no SDK), NitroSend/Kit/Mailchimp behind the existing `EmailProvider` interface.

**Spec:** `docs/superpowers/specs/2026-08-12-confirmed-opt-in-design.md` (critical-reviewed, PASS)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/token.ts` | **New.** Generic `signToken`/`verifyToken` (HMAC-SHA256, `exp`-in-payload). Pure, no I/O. Extracted from `digest.ts` so one HMAC implementation serves both flows |
| `src/lib/digest.ts` | **Modify** (lines 47-77). `signApproveToken`/`verifyApproveToken` become thin wrappers over `token.ts` |
| `src/lib/consent.ts` | **New.** Consent scopes, token payload type, `recordConsent()` upsert against Supabase |
| `src/lib/confirmation-email.ts` | **New.** Builds and sends the confirmation email via Resend REST |
| `src/lib/rate-limit.ts` | **New.** Per-address and per-IP throttles, hashed, fail-open |
| `src/lib/confirm.ts` | **New.** `handleConfirm()` — the testable core of the confirm route |
| `src/lib/email.ts` | **Modify.** `getProvider(scope)` resolves per-scope list IDs, returns `null` for an unconfigured scope |
| `src/pages/confirm.astro` | **New.** Thin route: parse token, call `handleConfirm()`, render outcome, set security headers |
| `src/pages/api/subscribe.ts` | **Modify.** Split consent, rate-limit, mint tokens, send email. No longer subscribes |
| `src/config/site.ts` | **Modify.** Two consent strings instead of one bundled string |
| `src/components/EmailCapture.astro` | **Modify.** Two checkboxes; success copy tells the user to check their inbox |
| `src/pages/privacy.astro` | **Modify.** Document the confirmation step and two-scope model |
| `src/env.d.ts` | **Modify.** Type the four new env vars |
| `public/robots.txt` | **Modify.** Disallow `/confirm` in every user-agent block |
| `supabase/migrations/0004_consent.sql` | **New.** `subscriber_consents` + `subscribe_attempts` |

**Deviation from spec §4, deliberate:** the spec put the confirm logic in `confirm.astro`. This plan puts it in `src/lib/confirm.ts` with the route as a thin shim, matching the existing `handleSubscribe(req, deps)` pattern in `subscribe.ts` — Astro pages are not unit-testable in this repo's Vitest setup (`environment: 'node'`, `include: ['tests/**/*.test.ts']`), and the spec's own §5 requires a `confirm` test that asserts the audit row survives a thrown provider error. Same behaviour, testable.

---

## Task 0: Prerequisites and environment scaffolding

Nothing in this plan runs without these. Do this task first and do not proceed if Step 1 fails.

**Files:**
- Modify: `src/env.d.ts`
- Modify: `.env.example`
- Modify: `.env` (local only, gitignored, never committed)

- [ ] **Step 1: Confirm a usable `RESEND_API_KEY` exists**

**Status as of 2026-08-12: done.** `RESEND_API_KEY` (sending-access scope) is in local `.env` and in both Vercel Production and Preview, alongside `SUBSCRIBE_TOKEN_SECRET`, `PUBLIC_SITE_URL`, and `DIGEST_APPROVER_EMAIL` — all four confirmed present in both scopes independently via `vercel env ls production` / `vercel env ls preview`. If picking this plan up fresh, re-verify with the same two commands before assuming this step is still satisfied.

`.env` does not auto-load into a plain shell — that's Astro/Vite/dotenv behaviour, not bash's — so the `curl` below still needs `RESEND_API_KEY` as an exported shell variable. Source it from `.env` rather than retyping the key (retyping is exactly how an earlier pass introduced a trailing-space bug that silently broke the Bearer token):

```bash
set -a && source .env && set +a
```

Then verify the key works and the sending domain is verified:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST 'https://api.resend.com/emails' \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"from":"TradieIntel <hello@tradieintel.com.au>","to":["<your-own-mailbox>"],"subject":"resend preflight","html":"<p>preflight</p>"}'
```

Expected: `200`. A `403` means the domain is not verified on this account; a `401` means the key is wrong. **Stop and resolve before continuing** — Task 4 builds directly against this endpoint.

- [ ] **Step 2: Generate the token secret**

**Status as of 2026-08-12: done.** Generated and confirmed distinct from `CRON_SECRET`. Reusing `CRON_SECRET` would let one leaked value forge both subscriber confirmations and digest approvals — if regenerating, keep that constraint.

```bash
openssl rand -base64 32
```

- [ ] **Step 3: Add env vars to `.env` and `.env.example`**

**Use `.env`, not `.env.local`.** This repo keeps every real key in `.env` (`NITROSEND_API_KEY`, `CRON_SECRET`, `SUPABASE_*` all live there); `.env.local` contains only `VERCEL_OIDC_TOKEN` and is machine-generated by the Vercel CLI, so anything hand-added there is liable to be overwritten. Both are gitignored.

**`.env` — status: done.** `SUBSCRIBE_TOKEN_SECRET`, `RESEND_API_KEY`, `PUBLIC_SITE_URL` (`http://localhost:4321`, correct for local dev), and `DIGEST_APPROVER_EMAIL` (`hello@tradieintel.com.au`, matching the value already live on Vercel — see Step 1) are all present with real values. `NITROSEND_LIST_ID_COMMERCIAL` / `EMAIL_LIST_ID_COMMERCIAL` correctly left unset.

**`.env.example` — status: done.** Added as placeholders:

```bash
# Confirmed opt-in (double opt-in) - generate with `openssl rand -base64 32`.
# Must differ from CRON_SECRET: reusing it would let one leaked value forge
# both subscriber confirmations and digest approvals.
SUBSCRIBE_TOKEN_SECRET=
# Resend - sends the confirmation email. Sending-access scope only.
RESEND_API_KEY=
# Optional - only set once a GrokoryAI commercial list exists in NitroSend/Kit.
# Unset means consent is still recorded, the subscribe call is skipped.
NITROSEND_LIST_ID_COMMERCIAL=
EMAIL_LIST_ID_COMMERCIAL=
```

`PUBLIC_SITE_URL` and `DIGEST_APPROVER_EMAIL` were already present in `.env.example` before this build — no change needed there.

If picking this plan up fresh, verify with `grep -E "SUBSCRIBE_TOKEN_SECRET|RESEND_API_KEY|PUBLIC_SITE_URL|DIGEST_APPROVER_EMAIL" .env .env.example` rather than trusting this note — it recorded a point-in-time state.

- [ ] **Step 4: Type the new env vars**

In `src/env.d.ts`, add these four lines inside `interface ImportMetaEnv`, after the existing `NITROSEND_LIST_ID` line:

```ts
  readonly SUBSCRIBE_TOKEN_SECRET: string;
  readonly RESEND_API_KEY: string;
  readonly NITROSEND_LIST_ID_COMMERCIAL: string;
  readonly EMAIL_LIST_ID_COMMERCIAL: string;
```

- [ ] **Step 5: Verify the project still builds**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/env.d.ts .env.example
git commit -m "chore(consent): scaffold env vars for confirmed opt-in"
```

---

## Task 1: Generic signed-token helpers

**Files:**
- Create: `src/lib/token.ts`
- Modify: `src/lib/digest.ts:47-77`
- Test: `tests/lib/token.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/token.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { signToken, verifyToken } from '@/lib/token';

interface TestPayload { who: string; exp: number; }

const SECRET = 'test-secret-value';
const future = () => Math.floor(Date.now() / 1000) + 3600;
const past = () => Math.floor(Date.now() / 1000) - 10;

describe('signToken / verifyToken', () => {
  it('round-trips a payload', () => {
    const token = signToken<TestPayload>({ who: 'a@b.com', exp: future() }, SECRET);
    expect(verifyToken<TestPayload>(token, SECRET).who).toBe('a@b.com');
  });

  it('rejects a tampered payload', () => {
    const token = signToken<TestPayload>({ who: 'a@b.com', exp: future() }, SECRET);
    const forged = Buffer.from(JSON.stringify({ who: 'evil@b.com', exp: future() })).toString('base64url');
    const tampered = `${forged}.${token.slice(token.indexOf('.') + 1)}`;
    expect(() => verifyToken<TestPayload>(tampered, SECRET)).toThrow(/signature/i);
  });

  it('rejects a tampered signature', () => {
    const token = signToken<TestPayload>({ who: 'a@b.com', exp: future() }, SECRET);
    expect(() => verifyToken<TestPayload>(`${token}x`, SECRET)).toThrow(/signature/i);
  });

  it('rejects a token signed with a different secret', () => {
    const token = signToken<TestPayload>({ who: 'a@b.com', exp: future() }, 'other-secret');
    expect(() => verifyToken<TestPayload>(token, SECRET)).toThrow(/signature/i);
  });

  it('rejects an expired token', () => {
    const token = signToken<TestPayload>({ who: 'a@b.com', exp: past() }, SECRET);
    expect(() => verifyToken<TestPayload>(token, SECRET)).toThrow(/expired/i);
  });

  it('rejects a malformed token', () => {
    expect(() => verifyToken<TestPayload>('no-dot-here', SECRET)).toThrow(/format/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/token.test.ts`
Expected: FAIL — cannot resolve `@/lib/token`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/token.ts`. This is the existing `digest.ts` logic made generic — same wire format (`payloadB64.sigB64url`), same `exp`-in-payload convention, same `timingSafeEqual` comparison:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Every token payload carries its own expiry as unix seconds. */
export interface ExpiringPayload {
  exp: number;
}

/** Wire format: `<base64url(JSON payload)>.<base64url(HMAC-SHA256)>` */
export function signToken<T extends ExpiringPayload>(payload: T, secret: string): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

/** Throws on malformed, tampered, or expired tokens. Never returns a partial result. */
export function verifyToken<T extends ExpiringPayload>(token: string, secret: string): T {
  const dotIdx = token.indexOf('.');
  if (dotIdx === -1) throw new Error('Invalid token format');
  const payloadB64 = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);

  const expected = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  const expectedBuf = Buffer.from(expected, 'ascii');
  const sigBuf = Buffer.from(sig, 'ascii');
  // Length check first: timingSafeEqual throws on length mismatch.
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Invalid token signature');
  }

  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as T;
  } catch {
    throw new Error('Invalid token format');
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');
  return payload;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/token.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Refactor `digest.ts` to use the shared helpers**

In `src/lib/digest.ts`, add to the import block at the top:

```ts
import { signToken, verifyToken } from './token';
```

Then replace the whole token-utilities block (lines 47-77, from `export function signApproveToken` through the end of `verifyApproveToken`) with:

```ts
export function signApproveToken(runId: string, broadcastId: string, secret: string): string {
  return signToken<ApproveTokenPayload>({
    run_id: runId,
    broadcast_id: broadcastId,
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
  }, secret);
}

export function verifyApproveToken(token: string, secret: string): ApproveTokenPayload {
  return verifyToken<ApproveTokenPayload>(token, secret);
}
```

`createHmac` and `timingSafeEqual` may now be unused in `digest.ts` — if so, remove them from its `node:crypto` import. `ApproveTokenPayload` already has an `exp: number` field, so it satisfies `ExpiringPayload` with no change.

- [ ] **Step 6: Run the full suite — the existing digest tests are the regression check**

Run: `npx vitest run`
Expected: PASS. `tests/lib/digest.test.ts` must still pass unchanged; it exercises `signApproveToken`/`verifyApproveToken` and proves the refactor preserved the wire format.

- [ ] **Step 7: Commit**

```bash
git add src/lib/token.ts src/lib/digest.ts tests/lib/token.test.ts
git commit -m "refactor(token): extract shared HMAC sign/verify from digest.ts"
```

---

## Task 2: Consent and abuse-control tables

**Files:**
- Create: `supabase/migrations/0004_consent.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0004_consent.sql`, following the style of `0003_digest_runs.sql`:

```sql
-- Confirmed opt-in (double opt-in) support.
--   subscriber_consents: Spam Act 2003 evidence trail, one row per (email, scope).
--                        `scope` keeps feeder consent and GrokoryAI commercial consent
--                        independently provable - a feeder subscription is NOT consent
--                        to be marketed by the parent business.
--   subscribe_attempts:  abuse control for the signup endpoint. Hashed, short-lived.
-- RLS: service role only on both; no public read policy.

create table subscriber_consents (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  scope        text not null check (scope in ('tradieintel_digest', 'grokoryai_commercial')),
  confirmed_at timestamptz not null default now(),
  requested_at timestamptz not null,
  source       text,
  referrer     text,
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  ip_hash      text,
  user_agent   text,
  unique (email, scope)
);

alter table subscriber_consents enable row level security;

create index subscriber_consents_email_idx on subscriber_consents (email);

create table subscribe_attempts (
  id         uuid primary key default gen_random_uuid(),
  email_hash text not null,
  ip_hash    text,
  created_at timestamptz not null default now()
);

alter table subscribe_attempts enable row level security;

create index subscribe_attempts_email_idx on subscribe_attempts (email_hash, created_at desc);
create index subscribe_attempts_ip_idx on subscribe_attempts (ip_hash, created_at desc);
```

- [ ] **Step 2: Apply the migration**

Run: `npx supabase db push`
Expected: migration `0004_consent` applied.

If the project uses the hosted dashboard rather than the CLI for migrations, paste the SQL into the SQL editor and run it there instead. Verify either way with Step 3.

- [ ] **Step 3: Verify both tables exist with the unique constraint**

Run (verified against `supabase` CLI 2.101.0 — the subcommand is `db query`, not `db execute`):

```bash
npx supabase db query --linked "insert into subscriber_consents (email, scope, requested_at) values ('probe@example.com','tradieintel_digest', now()); insert into subscriber_consents (email, scope, requested_at) values ('probe@example.com','tradieintel_digest', now());"
```

Expected: the second insert FAILS with a unique-constraint violation on `(email, scope)`. That failure is the pass condition — it proves re-confirmation cannot duplicate a consent row.

Clean up: `npx supabase db query --linked "delete from subscriber_consents where email = 'probe@example.com';"`

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0004_consent.sql
git commit -m "feat(consent): add subscriber_consents and subscribe_attempts tables"
```

---

## Task 3: Per-scope provider resolution

**Files:**
- Modify: `src/lib/email.ts` (the `getProvider` function at the bottom)
- Create: `src/lib/consent.ts`
- Test: `tests/lib/email.test.ts` — **replace** the existing `describe('getProvider')` block at lines 130-226, do not append alongside it

- [ ] **Step 1: Create the shared scope type**

Create `src/lib/consent.ts` (the `recordConsent` function is added in Task 5; this task only needs the types):

```ts
import type { ExpiringPayload } from './token';

export type ConsentScope = 'tradieintel_digest' | 'grokoryai_commercial';

export const CONSENT_SCOPES: readonly ConsentScope[] = [
  'tradieintel_digest',
  'grokoryai_commercial'
] as const;

/** Signed payload of a confirmation link. One token confirms exactly one scope. */
export interface ConfirmTokenPayload extends ExpiringPayload {
  email: string;
  scope: ConsentScope;
  source: string;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  /** Signup request time, unix seconds. Source for subscriber_consents.requested_at. */
  iat: number;
}
```

- [ ] **Step 2: Replace the existing `getProvider` test block**

`tests/lib/email.test.ts:130-226` already has a `describe('getProvider', ...)` block with six calls to `getProvider()` with no arguments — one of them, `'EMAIL_PROVIDER=nitrosend throws when NITROSEND_LIST_ID is missing'`, asserts a `.toThrow()` that the new per-scope design deliberately replaces with a `null` return. Left as-is, this block fails after Step 5 and, if "fixed" by making `getProvider` throw again, silently deletes the null-provider mechanism Task 5 depends on.

Replace the entire block (lines 130-226) with this one — it keeps the file's existing per-key save/restore + `vi.resetModules()` + dynamic-import pattern (do not switch to wholesale `process.env` reassignment), adds the two new commercial-list env keys to the saved set, updates every call site to pass a scope, and turns the one inverted test into its null-return equivalent:

```ts
describe('getProvider(scope)', () => {
  // Save and restore process.env around each test so env mutations don't bleed.
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      EMAIL_PROVIDER: process.env.EMAIL_PROVIDER,
      EMAIL_PROVIDER_API_KEY: process.env.EMAIL_PROVIDER_API_KEY,
      EMAIL_LIST_ID: process.env.EMAIL_LIST_ID,
      EMAIL_LIST_ID_COMMERCIAL: process.env.EMAIL_LIST_ID_COMMERCIAL,
      NITROSEND_API_KEY: process.env.NITROSEND_API_KEY,
      NITROSEND_LIST_ID: process.env.NITROSEND_LIST_ID,
      NITROSEND_LIST_ID_COMMERCIAL: process.env.NITROSEND_LIST_ID_COMMERCIAL,
    };
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
  });

  it('EMAIL_PROVIDER=dual returns DualProvider with Kit primary and NitroSend secondary', async () => {
    process.env.EMAIL_PROVIDER = 'dual';
    process.env.EMAIL_PROVIDER_API_KEY = 'kit_key';
    process.env.EMAIL_LIST_ID = 'kit_form_id';
    process.env.NITROSEND_API_KEY = 'ns_key';
    process.env.NITROSEND_LIST_ID = 'ns_list_id';

    vi.resetModules();
    // Import all class refs from the same fresh module so instanceof checks use
    // the same constructor identity as the one getProvider() used to build the object.
    const email = await import('@/lib/email');
    const p = email.getProvider('tradieintel_digest');

    expect(p).toBeInstanceOf(email.DualProvider);
    expect((p as any).primary).toBeInstanceOf(email.KitProvider);
    expect((p as any).secondary).toBeInstanceOf(email.NitrosendProvider);
  });

  it('EMAIL_PROVIDER=nitrosend throws when NITROSEND_API_KEY is missing', async () => {
    process.env.EMAIL_PROVIDER = 'nitrosend';
    delete process.env.NITROSEND_API_KEY;
    process.env.NITROSEND_LIST_ID = 'ns_list_id';

    vi.resetModules();
    const { getProvider } = await import('@/lib/email');
    expect(() => getProvider('tradieintel_digest')).toThrow(/NITROSEND_API_KEY/);
  });

  it('EMAIL_PROVIDER=nitrosend returns null for the digest scope when NITROSEND_LIST_ID is missing', async () => {
    process.env.EMAIL_PROVIDER = 'nitrosend';
    process.env.NITROSEND_API_KEY = 'ns_key';
    delete process.env.NITROSEND_LIST_ID;

    vi.resetModules();
    const { getProvider } = await import('@/lib/email');
    expect(getProvider('tradieintel_digest')).toBeNull();
  });

  it('EMAIL_PROVIDER=nitrosend returns NitrosendProvider when env is complete', async () => {
    process.env.EMAIL_PROVIDER = 'nitrosend';
    process.env.NITROSEND_API_KEY = 'ns_key';
    process.env.NITROSEND_LIST_ID = 'ns_list_id';

    vi.resetModules();
    // Same-module import so instanceof uses the same constructor identity.
    const email = await import('@/lib/email');
    const p = email.getProvider('tradieintel_digest');

    expect(p).toBeInstanceOf(email.NitrosendProvider);
  });

  it('EMAIL_PROVIDER=dual throws when NITROSEND_API_KEY is missing', async () => {
    process.env.EMAIL_PROVIDER = 'dual';
    process.env.EMAIL_PROVIDER_API_KEY = 'kit_key';
    process.env.EMAIL_LIST_ID = 'kit_form_id';
    delete process.env.NITROSEND_API_KEY;
    process.env.NITROSEND_LIST_ID = 'ns_list_id';

    vi.resetModules();
    const { getProvider } = await import('@/lib/email');
    expect(() => getProvider('tradieintel_digest')).toThrow(/NITROSEND_API_KEY/);
  });

  it('EMAIL_PROVIDER=dual throws when EMAIL_PROVIDER_API_KEY is missing', async () => {
    process.env.EMAIL_PROVIDER = 'dual';
    delete process.env.EMAIL_PROVIDER_API_KEY;
    process.env.EMAIL_LIST_ID = 'kit_form_id';
    process.env.NITROSEND_API_KEY = 'ns_key';
    process.env.NITROSEND_LIST_ID = 'ns_list_id';

    vi.resetModules();
    const { getProvider } = await import('@/lib/email');
    expect(() => getProvider('tradieintel_digest')).toThrow(/EMAIL_PROVIDER_API_KEY/);
  });

  it('returns null for the commercial scope when no commercial list is configured', async () => {
    process.env.EMAIL_PROVIDER = 'nitrosend';
    process.env.NITROSEND_API_KEY = 'ns_key';
    process.env.NITROSEND_LIST_ID = 'ns_list_id';
    delete process.env.NITROSEND_LIST_ID_COMMERCIAL;

    vi.resetModules();
    const { getProvider } = await import('@/lib/email');
    expect(getProvider('grokoryai_commercial')).toBeNull();
  });

  it('returns a provider for the commercial scope once its list is configured', async () => {
    process.env.EMAIL_PROVIDER = 'nitrosend';
    process.env.NITROSEND_API_KEY = 'ns_key';
    process.env.NITROSEND_LIST_ID_COMMERCIAL = 'list-commercial';

    vi.resetModules();
    const email = await import('@/lib/email');
    expect(email.getProvider('grokoryai_commercial')).toBeInstanceOf(email.NitrosendProvider);
  });

  it('memory provider ignores list configuration entirely', async () => {
    process.env.EMAIL_PROVIDER = 'memory';

    vi.resetModules();
    const email = await import('@/lib/email');
    expect(email.getProvider('grokoryai_commercial')).toBeInstanceOf(email.MemoryProvider);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/lib/email.test.ts`
Expected: FAIL — `getProvider` currently takes no arguments, so every call above compiles but ignores the scope argument, and the null-return assertions fail against the old throw-based behaviour.

- [ ] **Step 4: Rewrite `getProvider`**

First add this import to the **top** of `src/lib/email.ts` (the file currently has no imports; put it on line 1):

```ts
import type { ConsentScope } from './consent';
```

`consent.ts` imports only from `token.ts`, and `token.ts` imports nothing local, so this creates no import cycle.

Then replace the entire existing `getProvider()` function at the bottom of `src/lib/email.ts` with:

```ts
/**
 * Resolves the provider for one consent scope.
 *
 * Returns `null` - not an error - when the scope has no destination list configured.
 * That is the expected state for `grokoryai_commercial` until a commercial list is
 * provisioned: consent is still recorded, the subscribe call is simply skipped.
 *
 * NOTE: env vars are read with static property access on `import.meta.env`, never a
 * computed key. Vite/Astro statically replaces `import.meta.env.FOO` at build time;
 * `import.meta.env[expr]` is NOT replaced and resolves to undefined in production.
 */
export function getProvider(scope: ConsentScope): EmailProvider | null {
  const which = (import.meta.env.EMAIL_PROVIDER ?? process.env.EMAIL_PROVIDER) as string;
  const apiKey = (import.meta.env.EMAIL_PROVIDER_API_KEY ?? process.env.EMAIL_PROVIDER_API_KEY ?? '') as string;
  const nitroKey = (import.meta.env.NITROSEND_API_KEY ?? process.env.NITROSEND_API_KEY ?? '') as string;

  const commercial = scope === 'grokoryai_commercial';
  const listId = ((commercial
    ? (import.meta.env.EMAIL_LIST_ID_COMMERCIAL ?? process.env.EMAIL_LIST_ID_COMMERCIAL)
    : (import.meta.env.EMAIL_LIST_ID ?? process.env.EMAIL_LIST_ID)) ?? '') as string;
  const nitroList = ((commercial
    ? (import.meta.env.NITROSEND_LIST_ID_COMMERCIAL ?? process.env.NITROSEND_LIST_ID_COMMERCIAL)
    : (import.meta.env.NITROSEND_LIST_ID ?? process.env.NITROSEND_LIST_ID)) ?? '') as string;

  switch (which) {
    case 'memory':    return new MemoryProvider();
    case 'kit':       return listId ? new KitProvider(apiKey, listId) : null;
    case 'mailchimp': return listId ? new MailchimpProvider(apiKey, listId) : null;
    case 'nitrosend':
      if (!nitroKey) throw new Error('NITROSEND_API_KEY is required when EMAIL_PROVIDER=nitrosend');
      return nitroList ? new NitrosendProvider(nitroKey, nitroList) : null;
    case 'dual': {
      if (!apiKey)   throw new Error('EMAIL_PROVIDER_API_KEY (Kit API key) is required when EMAIL_PROVIDER=dual');
      if (!nitroKey) throw new Error('NITROSEND_API_KEY is required when EMAIL_PROVIDER=dual');
      if (!listId || !nitroList) return null;
      return new DualProvider(
        new KitProvider(apiKey, listId),
        new NitrosendProvider(nitroKey, nitroList)
      );
    }
    default: throw new Error(`Unknown EMAIL_PROVIDER: ${which}`);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/lib/email.test.ts`
Expected: PASS, 9 tests (all under the single `getProvider(scope)` describe block).

- [ ] **Step 6: Check for stale call sites**

Run: `grep -rn "getProvider(" src/ tests/`
Expected: every call in `tests/lib/email.test.ts` now passes a scope. The only remaining zero-argument call is in `src/pages/api/subscribe.ts:61`, which Task 7 replaces. Leave it for now — it is a type error `tsc` will flag; that is expected until Task 7.

- [ ] **Step 7: Commit**

```bash
git add src/lib/email.ts src/lib/consent.ts tests/lib/email.test.ts
git commit -m "feat(consent): resolve email provider per consent scope"
```

---

## Task 4: Confirmation email via Resend

**Files:**
- Create: `src/lib/confirmation-email.ts`
- Test: `tests/lib/confirmation-email.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/confirmation-email.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildConfirmationHtml, sendConfirmationEmail } from '@/lib/confirmation-email';

const links = [
  { scope: 'tradieintel_digest' as const, url: 'https://x.test/confirm?t=aaa', label: 'Confirm the weekly digest' },
  { scope: 'grokoryai_commercial' as const, url: 'https://x.test/confirm?t=bbb', label: 'Confirm GrokoryAI emails' }
];

describe('buildConfirmationHtml', () => {
  it('includes one link per scope', () => {
    const html = buildConfirmationHtml(links);
    expect(html).toContain('https://x.test/confirm?t=aaa');
    expect(html).toContain('https://x.test/confirm?t=bbb');
  });

  it('states that ignoring the email means nothing further is sent', () => {
    expect(buildConfirmationHtml(links).toLowerCase()).toContain('ignore');
  });

  it('renders only the digest link when only the digest was requested', () => {
    const html = buildConfirmationHtml([links[0]]);
    expect(html).toContain('aaa');
    expect(html).not.toContain('bbb');
  });
});

describe('sendConfirmationEmail', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs to the Resend endpoint with bearer auth and a List-Unsubscribe header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"id":"e1"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendConfirmationEmail('a@b.com', links, 'test-key');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body);
    expect(body.to).toEqual(['a@b.com']);
    expect(body.from).toContain('hello@tradieintel.com.au');
    expect(body.headers['List-Unsubscribe']).toBeTruthy();
  });

  it('throws when Resend returns a non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 422 })));
    await expect(sendConfirmationEmail('a@b.com', links, 'test-key')).rejects.toThrow(/422/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/confirmation-email.test.ts`
Expected: FAIL — cannot resolve `@/lib/confirmation-email`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/confirmation-email.ts`. Raw `fetch` matches the house pattern in `email.ts` — no SDK dependency. Endpoint and body shape verified against Resend docs 2026-08-12:

```ts
import type { ConsentScope } from './consent';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const FROM = 'TradieIntel <hello@tradieintel.com.au>';
const UNSUBSCRIBE_MAILTO = 'mailto:hello@tradieintel.com.au?subject=unsubscribe';

export interface ConfirmLink {
  scope: ConsentScope;
  url: string;
  label: string;
}

export function buildConfirmationHtml(links: ConfirmLink[]): string {
  const buttons = links.map(l => `
    <p style="margin:24px 0;">
      <a href="${l.url}"
         style="background:#1a1a1a;color:#fff;padding:12px 20px;border-radius:6px;
                text-decoration:none;display:inline-block;font-weight:600;">${l.label}</a>
    </p>
    <p style="font-size:12px;color:#666;margin:0 0 16px;">
      Or paste this into your browser:<br><span style="word-break:break-all;">${l.url}</span>
    </p>`).join('');

  return `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.5;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px;">
  <h1 style="font-size:20px;">Confirm your subscription</h1>
  <p>Someone (hopefully you) asked to hear from us. Confirm below and you're set.</p>
  <p><strong>The TradieIntel weekly digest</strong> is AI-filtered trades news for Australian operators, sent every Tuesday morning.</p>
  ${buttons}
  <hr style="border:none;border-top:1px solid #e5e5e5;margin:28px 0;">
  <p style="font-size:12px;color:#666;">
    If you ignore this email, nothing further will be sent. You will not be added to any list unless you click above.
  </p>
</body></html>`;
}

/** Sends one confirmation email covering every requested scope. Throws on a non-OK response. */
export async function sendConfirmationEmail(
  to: string,
  links: ConfirmLink[],
  apiKey: string
): Promise<void> {
  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject: 'Confirm your TradieIntel subscription',
      html: buildConfirmationHtml(links),
      headers: { 'List-Unsubscribe': `<${UNSUBSCRIBE_MAILTO}>` }
    })
  });
  if (!res.ok) {
    throw new Error(`Resend send error: ${res.status} ${await res.text()}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lib/confirmation-email.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Send one real email to yourself**

Mocked tests prove the request shape, not that Resend accepts it. Rather than fight a `.ts` loader for a one-off manual check, add a temporary throwaway test that calls the real function and actually asserts nothing — Vitest already knows how to run `.ts` through this project's `@` alias, which is the whole problem plain `node -e` has:

Vitest does not populate `process.env` from `.env`, so load both values into this shell first (this is a new shell from Task 0, so its earlier export is gone). Both are already in `.env` (confirmed in Task 0), so source rather than retype:

```bash
set -a && source .env && set +a
```

```bash
cat > /tmp/send-preview.test.ts <<'EOF'
import { it } from 'vitest';
import { sendConfirmationEmail } from '@/lib/confirmation-email';

it('manual: sends a real confirmation email', async () => {
  await sendConfirmationEmail(process.env.DIGEST_APPROVER_EMAIL!, [
    { scope: 'tradieintel_digest', url: 'https://tradieintel.com.au/confirm?t=demo', label: 'Confirm the weekly digest' }
  ], process.env.RESEND_API_KEY!);
});
EOF
npx vitest run /tmp/send-preview.test.ts
rm /tmp/send-preview.test.ts
```

Expected: the test passes (meaning Resend returned 200) and the email arrives in the inbox at `DIGEST_APPROVER_EMAIL` with a rendered, clickable button. Delete the scratch file immediately after — it is not part of the repo's test suite.

- [ ] **Step 6: Commit**

```bash
git add src/lib/confirmation-email.ts tests/lib/confirmation-email.test.ts
git commit -m "feat(consent): send confirmation email via Resend"
```

---

## Task 5: Confirmation handler

The ordering here is the point of the task: **the consent row is written before the subscribe call.** A consent record with no subscription is harmless; a subscription with no consent record is the exact compliance failure this whole build exists to prevent.

**Files:**
- Modify: `src/lib/consent.ts` (add `recordConsent`)
- Create: `src/lib/confirm.ts`
- Create: `src/pages/confirm.astro`
- Test: `tests/lib/confirm.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/confirm.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { handleConfirm } from '@/lib/confirm';
import { signToken } from '@/lib/token';
import { MemoryProvider } from '@/lib/email';
import type { ConfirmTokenPayload, ConsentScope } from '@/lib/consent';

const SECRET = 'confirm-test-secret';
const now = () => Math.floor(Date.now() / 1000);

function token(over: Partial<ConfirmTokenPayload> = {}): string {
  return signToken<ConfirmTokenPayload>({
    email: 'a@b.com',
    scope: 'tradieintel_digest',
    source: 'homepage-hero',
    referrer: null,
    utm_source: 'meta',
    utm_medium: null,
    utm_campaign: null,
    iat: now(),
    exp: now() + 3600,
    ...over
  }, SECRET);
}

/** Captures recordConsent calls instead of hitting Supabase. */
function deps(provider: MemoryProvider | null, recorded: any[] = []) {
  return {
    secret: SECRET,
    recordConsent: async (row: any) => { recorded.push(row); },
    getProviderFor: (_s: ConsentScope) => provider,
    recorded
  };
}

const meta = { ipHash: 'iphash', userAgent: 'vitest' };

describe('handleConfirm', () => {
  it('records consent and subscribes on a valid token', async () => {
    const provider = new MemoryProvider();
    const d = deps(provider);
    const out = await handleConfirm(token(), meta, d);

    expect(out).toEqual({ status: 'ok', scope: 'tradieintel_digest' });
    expect(provider.list()).toEqual(['a@b.com']);
    expect(d.recorded).toHaveLength(1);
    expect(d.recorded[0]).toMatchObject({
      email: 'a@b.com', scope: 'tradieintel_digest', source: 'homepage-hero', utm_source: 'meta'
    });
  });

  it('writes the consent row even when the provider throws', async () => {
    const provider = new MemoryProvider();
    vi.spyOn(provider, 'subscribe').mockRejectedValue(new Error('nitrosend 503'));
    const d = deps(provider);

    const out = await handleConfirm(token(), meta, d);

    expect(out).toEqual({ status: 'provider_error', scope: 'tradieintel_digest' });
    expect(d.recorded).toHaveLength(1); // consent survived the provider failure
  });

  it('records consent and skips subscribing when the scope has no provider', async () => {
    const d = deps(null);
    const out = await handleConfirm(token({ scope: 'grokoryai_commercial' }), meta, d);

    expect(out).toEqual({ status: 'ok', scope: 'grokoryai_commercial' });
    expect(d.recorded).toHaveLength(1);
  });

  it('rejects a tampered token without recording or subscribing', async () => {
    const provider = new MemoryProvider();
    const d = deps(provider);
    const out = await handleConfirm(token() + 'x', meta, d);

    expect(out).toEqual({ status: 'invalid' });
    expect(d.recorded).toHaveLength(0);
    expect(provider.list()).toEqual([]);
  });

  it('rejects an expired token without recording or subscribing', async () => {
    const provider = new MemoryProvider();
    const d = deps(provider);
    const out = await handleConfirm(token({ exp: now() - 10 }), meta, d);

    expect(out).toEqual({ status: 'expired' });
    expect(d.recorded).toHaveLength(0);
    expect(provider.list()).toEqual([]);
  });

  it('is idempotent across a repeated click', async () => {
    const provider = new MemoryProvider();
    const d = deps(provider);
    const t = token();
    await handleConfirm(t, meta, d);
    const out = await handleConfirm(t, meta, d);

    expect(out).toEqual({ status: 'ok', scope: 'tradieintel_digest' });
    expect(provider.list()).toEqual(['a@b.com']); // MemoryProvider dedupes via Set
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/confirm.test.ts`
Expected: FAIL — cannot resolve `@/lib/confirm`.

- [ ] **Step 3: Add `recordConsent` to `src/lib/consent.ts`**

Append to `src/lib/consent.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ConsentRow {
  email: string;
  scope: ConsentScope;
  requested_at: string;
  source: string | null;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  ip_hash: string | null;
  user_agent: string | null;
}

/**
 * Upserts on (email, scope) so a re-clicked or retried confirmation link refreshes
 * confirmed_at rather than erroring or duplicating.
 */
export async function recordConsent(supa: SupabaseClient, row: ConsentRow): Promise<void> {
  const { error } = await supa
    .from('subscriber_consents')
    .upsert({ ...row, confirmed_at: new Date().toISOString() }, { onConflict: 'email,scope' });
  if (error) throw new Error(`recordConsent failed: ${error.message}`);
}
```

- [ ] **Step 4: Write `src/lib/confirm.ts`**

```ts
import { verifyToken } from './token';
import type { ConfirmTokenPayload, ConsentScope, ConsentRow } from './consent';
import type { EmailProvider } from './email';

export type ConfirmOutcome =
  | { status: 'ok'; scope: ConsentScope }
  | { status: 'provider_error'; scope: ConsentScope }
  | { status: 'invalid' }
  | { status: 'expired' };

export interface ConfirmMeta {
  ipHash: string | null;
  userAgent: string | null;
}

export interface ConfirmDeps {
  secret: string;
  recordConsent: (row: ConsentRow) => Promise<void>;
  getProviderFor: (scope: ConsentScope) => EmailProvider | null;
}

export async function handleConfirm(
  rawToken: string,
  meta: ConfirmMeta,
  deps: ConfirmDeps
): Promise<ConfirmOutcome> {
  let payload: ConfirmTokenPayload;
  try {
    payload = verifyToken<ConfirmTokenPayload>(rawToken, deps.secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    return /expired/i.test(message) ? { status: 'expired' } : { status: 'invalid' };
  }

  // Consent first. A consent row with no subscription is harmless; the reverse is the
  // compliance failure this build exists to prevent. Do not reorder these two blocks.
  // If recordConsent itself throws (Supabase unreachable), this deliberately propagates
  // out of handleConfirm uncaught - confirm.astro has no try/catch around it, so the
  // request 500s. That is intentional: a confirmation that silently "succeeds" while
  // failing to record consent is worse than a visible failure the user can retry.
  await deps.recordConsent({
    email: payload.email,
    scope: payload.scope,
    requested_at: new Date(payload.iat * 1000).toISOString(),
    source: payload.source,
    referrer: payload.referrer,
    utm_source: payload.utm_source,
    utm_medium: payload.utm_medium,
    utm_campaign: payload.utm_campaign,
    ip_hash: meta.ipHash,
    user_agent: meta.userAgent
  });

  const provider = deps.getProviderFor(payload.scope);
  // No destination list for this scope yet (expected for grokoryai_commercial until one
  // is provisioned). Consent is recorded and provable; there is simply nothing to join.
  if (!provider) return { status: 'ok', scope: payload.scope };

  try {
    await provider.subscribe(payload.email, {
      consent: true,
      consent_timestamp: new Date().toISOString(), // confirmation time, not request time
      source: payload.source,
      referrer: payload.referrer,
      utm_source: payload.utm_source,
      utm_medium: payload.utm_medium,
      utm_campaign: payload.utm_campaign
    });
  } catch (err) {
    console.error('[confirm] provider subscribe failed:', err);
    return { status: 'provider_error', scope: payload.scope };
  }

  return { status: 'ok', scope: payload.scope };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/lib/confirm.test.ts`
Expected: PASS, 6 tests. The second test (`writes the consent row even when the provider throws`) is the one that proves the ordering requirement.

- [ ] **Step 6: Write the route**

Create `src/pages/confirm.astro`:

```astro
---
import { createHash } from 'node:crypto';
import { handleConfirm } from '@/lib/confirm';
import { recordConsent } from '@/lib/consent';
import { getProvider } from '@/lib/email';
import { adminClient } from '@/lib/supabase';

export const prerender = false;

// Token is in the URL, so keep it out of the Referer of any outbound request.
Astro.response.headers.set('Referrer-Policy', 'no-referrer');

const token = Astro.url.searchParams.get('t') ?? '';
const ip = Astro.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
const supa = adminClient();

const outcome = token
  ? await handleConfirm(
      token,
      {
        ipHash: ip ? createHash('sha256').update(ip).digest('hex') : null,
        userAgent: Astro.request.headers.get('user-agent')
      },
      {
        secret: import.meta.env.SUBSCRIBE_TOKEN_SECRET ?? process.env.SUBSCRIBE_TOKEN_SECRET,
        recordConsent: (row) => recordConsent(supa, row),
        getProviderFor: (scope) => getProvider(scope)
      }
    )
  : { status: 'invalid' as const };

if (outcome.status === 'invalid' || outcome.status === 'expired') Astro.response.status = 400;
if (outcome.status === 'provider_error') Astro.response.status = 502;

const copy = {
  ok: {
    heading: "You're confirmed",
    body: 'Thanks. That address is now on the list, and you can unsubscribe from any email we send.'
  },
  expired: {
    heading: 'That link has expired',
    body: 'Confirmation links are valid for 48 hours. Sign up again and we will send a fresh one.'
  },
  invalid: {
    heading: 'That link is not valid',
    body: 'It may have been copied incorrectly. Sign up again and we will send a fresh one.'
  },
  provider_error: {
    heading: 'Almost there',
    body: 'Your consent was recorded but we could not finish adding you. Click the link in your email again in a minute.'
  }
}[outcome.status];
---

<html lang="en-AU">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>{copy.heading} | Tradie Intel</title>
  </head>
  <body style="font-family:system-ui,-apple-system,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.5rem;line-height:1.6;">
    <h1 style="font-size:1.5rem;">{copy.heading}</h1>
    <p>{copy.body}</p>
    <p><a href="/">Back to Tradie Intel</a></p>
  </body>
</html>
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: the only error is the stale zero-argument `getProvider()` call in `src/pages/api/subscribe.ts` (fixed in Task 7).

- [ ] **Step 8: Commit**

```bash
git add src/lib/confirm.ts src/lib/consent.ts src/pages/confirm.astro tests/lib/confirm.test.ts
git commit -m "feat(consent): add confirmation handler and /confirm route"
```

---

## Task 6: Rate limiting

This must land **before** Task 7. Task 7 turns `/api/subscribe` into an endpoint that sends an email per submission; shipping that without a throttle turns the endpoint into a list-bombing amplifier pointed at people who never signed up.

**Files:**
- Create: `src/lib/rate-limit.ts`
- Test: `tests/lib/rate-limit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/rate-limit.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { checkRateLimit, hashValue } from '@/lib/rate-limit';

/** Minimal stub of the Supabase query chain used by checkRateLimit. */
function stubSupa(rows: any[], opts: { throwOnSelect?: boolean } = {}) {
  const inserted: any[] = [];
  return {
    inserted,
    from() {
      return {
        select() {
          return {
            gte() {
              return {
                or() {
                  if (opts.throwOnSelect) throw new Error('supabase down');
                  return Promise.resolve({ data: rows, error: null });
                }
              };
            }
          };
        },
        insert(row: any) { inserted.push(row); return Promise.resolve({ error: null }); },
        delete() { return { lt: () => Promise.resolve({ error: null }) }; }
      };
    }
  } as any;
}

describe('checkRateLimit', () => {
  it('allows a first-time address', async () => {
    const supa = stubSupa([]);
    expect(await checkRateLimit(supa, 'a@b.com', '1.1.1.1')).toMatchObject({ allowed: true });
  });

  it('blocks a repeat of the same address inside the window', async () => {
    const recent = { email_hash: hashValue('a@b.com'), ip_hash: hashValue('9.9.9.9'), created_at: new Date().toISOString() };
    const supa = stubSupa([recent]);
    expect(await checkRateLimit(supa, 'a@b.com', '1.1.1.1')).toMatchObject({ allowed: false });
  });

  it('blocks a sixth signup from the same IP within the hour', async () => {
    const ipHash = hashValue('1.1.1.1');
    const rows = Array.from({ length: 5 }, (_, i) => ({
      email_hash: hashValue(`other${i}@b.com`), ip_hash: ipHash, created_at: new Date().toISOString()
    }));
    const supa = stubSupa(rows);
    expect(await checkRateLimit(supa, 'new@b.com', '1.1.1.1')).toMatchObject({ allowed: false });
  });

  it('fails open when the store is unreachable', async () => {
    const supa = stubSupa([], { throwOnSelect: true });
    expect(await checkRateLimit(supa, 'a@b.com', '1.1.1.1')).toMatchObject({ allowed: true });
  });

  it('hashes rather than storing raw values', () => {
    expect(hashValue('a@b.com')).not.toContain('a@b.com');
    expect(hashValue('A@B.com')).toBe(hashValue('a@b.com'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/rate-limit.test.ts`
Expected: FAIL — cannot resolve `@/lib/rate-limit`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/rate-limit.ts`:

```ts
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const ADDRESS_WINDOW_MS = 15 * 60 * 1000;  // one confirmation per address per 15 min
const IP_WINDOW_MS = 60 * 60 * 1000;       // rolling hour
const IP_MAX_PER_WINDOW = 5;

/** Hash before storage so the abuse-control table is not itself a PI store. */
export function hashValue(v: string): string {
  return createHash('sha256').update(v.trim().toLowerCase()).digest('hex');
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: 'address_window' | 'ip_cap';
}

/**
 * Fails OPEN: if the store is unreachable, allow the signup rather than block real
 * users on an infra blip. The honeypot and confirmed opt-in remain as backstops.
 */
export async function checkRateLimit(
  supa: SupabaseClient,
  email: string,
  ip: string | null
): Promise<RateLimitResult> {
  const emailHash = hashValue(email);
  const ipHash = ip ? hashValue(ip) : null;
  const since = new Date(Date.now() - IP_WINDOW_MS).toISOString();

  try {
    const { data, error } = await supa
      .from('subscribe_attempts')
      .select('email_hash, ip_hash, created_at')
      .gte('created_at', since)
      .or(`email_hash.eq.${emailHash}${ipHash ? `,ip_hash.eq.${ipHash}` : ''}`);
    if (error) throw new Error(error.message);

    const rows = data ?? [];
    const addressCutoff = Date.now() - ADDRESS_WINDOW_MS;
    const sameAddressRecently = rows.some(
      r => r.email_hash === emailHash && new Date(r.created_at).getTime() > addressCutoff
    );
    if (sameAddressRecently) return { allowed: false, reason: 'address_window' };

    if (ipHash && rows.filter(r => r.ip_hash === ipHash).length >= IP_MAX_PER_WINDOW) {
      return { allowed: false, reason: 'ip_cap' };
    }

    await supa.from('subscribe_attempts').insert({ email_hash: emailHash, ip_hash: ipHash });
    // Sweep on write - no cron needed at this volume.
    await supa.from('subscribe_attempts').delete().lt('created_at', since);

    return { allowed: true };
  } catch (err) {
    console.error('[rate-limit] check failed, failing open:', err);
    return { allowed: true };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lib/rate-limit.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rate-limit.ts tests/lib/rate-limit.test.ts
git commit -m "feat(consent): rate-limit the subscribe endpoint"
```

---

## Task 7: Rewire the subscribe endpoint (the switch-over)

This is the task that changes live behaviour. Everything before it was additive.

**Files:**
- Modify: `src/pages/api/subscribe.ts`
- Test: `tests/api/subscribe.test.ts` (three existing tests change)

- [ ] **Step 1: Rewrite the test file**

Two existing tests invert (they currently assert the provider was called; it must no longer be) and a third changes mechanism. Replace the whole of `tests/api/subscribe.test.ts` with:

```ts
import { describe, it, expect, vi } from 'vitest';
import { handleSubscribe, type SubscribeDeps } from '@/pages/api/subscribe';
import { verifyToken } from '@/lib/token';
import type { ConfirmTokenPayload } from '@/lib/consent';

const SECRET = 'subscribe-test-secret';

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://x/api/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

function deps(over: Partial<SubscribeDeps> = {}): SubscribeDeps & { sent: any[] } {
  const sent: any[] = [];
  return {
    secret: SECRET,
    siteUrl: 'https://x.test',
    checkRateLimit: async () => ({ allowed: true }),
    sendConfirmationEmail: async (to, links) => { sent.push({ to, links }); },
    sent,
    ...over
  } as SubscribeDeps & { sent: any[] };
}

describe('handleSubscribe', () => {
  it('returns 200 and sends a confirmation without subscribing anyone', async () => {
    const d = deps();
    const res = await handleSubscribe(post({ email: 'a@b.com', consent_digest: true }), d);

    expect(res.status).toBe(200);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].to).toBe('a@b.com');
    expect(d.sent[0].links).toHaveLength(1);
    expect(d.sent[0].links[0].scope).toBe('tradieintel_digest');
  });

  it('mints two scoped tokens when both boxes are ticked', async () => {
    const d = deps();
    await handleSubscribe(post({ email: 'a@b.com', consent_digest: true, consent_commercial: true }), d);

    const scopes = d.sent[0].links.map((l: any) => l.scope);
    expect(scopes).toEqual(['tradieintel_digest', 'grokoryai_commercial']);
    expect(d.sent).toHaveLength(1); // one email, two links - never two emails
  });

  it('carries attribution metadata into the token', async () => {
    const d = deps();
    await handleSubscribe(post({
      email: 'a@b.com', consent_digest: true,
      source: 'homepage-hero', referrer: 'https://google.com', utm_source: 'meta'
    }), d);

    const url = new URL(d.sent[0].links[0].url);
    const payload = verifyToken<ConfirmTokenPayload>(url.searchParams.get('t')!, SECRET);
    expect(payload).toMatchObject({
      email: 'a@b.com', source: 'homepage-hero', referrer: 'https://google.com', utm_source: 'meta'
    });
    expect(payload.iat).toBeGreaterThan(0);
  });

  it('returns 400 on invalid email format before sending anything', async () => {
    const d = deps();
    const res = await handleSubscribe(post({ email: 'garbage', consent_digest: true }), d);
    expect(res.status).toBe(400);
    expect(d.sent).toHaveLength(0);
  });

  it('returns 400 when digest consent is missing or false', async () => {
    const d = deps();
    expect((await handleSubscribe(post({ email: 'a@b.com' }), d)).status).toBe(400);
    expect((await handleSubscribe(post({ email: 'a@b.com', consent_digest: false }), d)).status).toBe(400);
    expect(d.sent).toHaveLength(0);
  });

  it('returns 400 on missing email field', async () => {
    const d = deps();
    expect((await handleSubscribe(post({ consent_digest: true }), d)).status).toBe(400);
  });

  it('silently accepts (200) but sends nothing when the honeypot is filled', async () => {
    const d = deps();
    const res = await handleSubscribe(
      post({ email: 'a@b.com', consent_digest: true, website: 'http://bot.com' }), d
    );
    expect(res.status).toBe(200);
    expect(d.sent).toHaveLength(0);
  });

  it('returns 200 without sending when rate-limited, so the response cannot probe the limiter', async () => {
    const d = deps({ checkRateLimit: async () => ({ allowed: false, reason: 'ip_cap' as const }) });
    const res = await handleSubscribe(post({ email: 'a@b.com', consent_digest: true }), d);
    expect(res.status).toBe(200);
    expect(d.sent).toHaveLength(0);
  });

  it('returns 200 identically whether or not the address already exists', async () => {
    const d = deps();
    const first = await handleSubscribe(post({ email: 'a@b.com', consent_digest: true }), d);
    const second = await handleSubscribe(post({ email: 'a@b.com', consent_digest: true }), d);
    expect(await first.text()).toBe(await second.text());
    expect(first.status).toBe(second.status);
  });

  it('returns 405 on non-POST', async () => {
    const d = deps();
    const res = await handleSubscribe(new Request('http://x/api/subscribe', { method: 'GET' }), d);
    expect(res.status).toBe(405);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/subscribe.test.ts`
Expected: FAIL — `handleSubscribe` still takes a provider, and `SubscribeDeps` does not exist.

- [ ] **Step 3: Rewrite the endpoint**

Replace the whole of `src/pages/api/subscribe.ts` with:

```ts
import type { APIRoute } from 'astro';
import { isValidEmail } from '@/lib/email';
import { signToken } from '@/lib/token';
import { checkRateLimit as realCheckRateLimit } from '@/lib/rate-limit';
import { sendConfirmationEmail as realSendConfirmationEmail, type ConfirmLink } from '@/lib/confirmation-email';
import { adminClient } from '@/lib/supabase';
import type { ConfirmTokenPayload, ConsentScope } from '@/lib/consent';

export const prerender = false;

const TOKEN_TTL_SECONDS = 48 * 60 * 60;

const SCOPE_LABELS: Record<ConsentScope, string> = {
  tradieintel_digest: 'Confirm the weekly digest',
  grokoryai_commercial: 'Confirm GrokoryAI emails'
};

export interface SubscribeDeps {
  secret: string;
  siteUrl: string;
  checkRateLimit: (email: string, ip: string | null) => Promise<{ allowed: boolean }>;
  sendConfirmationEmail: (to: string, links: ConfirmLink[]) => Promise<void>;
}

function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ error: 'method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json', Allow: 'POST' }
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

const ok = () => json({ ok: true }, 200);

export async function handleSubscribe(req: Request, deps: SubscribeDeps): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed();

  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; }
  catch { return json({ error: 'invalid JSON body' }, 400); }

  // Honeypot: the `website` input is CSS-hidden in EmailCapture.astro, so any value
  // means a bot. Return 200 so the bot believes it succeeded, but do nothing.
  if (typeof body.website === 'string' && body.website.length > 0) return ok();

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email) return json({ error: 'email required' }, 400);
  // Validate here rather than relying on a provider throwing - no provider is called now.
  if (!isValidEmail(email)) return json({ error: 'invalid email' }, 400);

  if (body.consent_digest !== true) return json({ error: 'consent required' }, 400);
  const consentCommercial = body.consent_commercial === true;

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  // Return the ordinary 200 when throttled: a distinct status would let an attacker
  // probe the limiter, and a real user retrying shortly after is indistinguishable.
  if (!(await deps.checkRateLimit(email, ip)).allowed) return ok();

  const str = (k: string) => typeof body[k] === 'string' ? body[k] as string : null;
  const iat = Math.floor(Date.now() / 1000);

  const scopes: ConsentScope[] = ['tradieintel_digest'];
  if (consentCommercial) scopes.push('grokoryai_commercial');

  const links: ConfirmLink[] = scopes.map(scope => {
    const token = signToken<ConfirmTokenPayload>({
      email,
      scope,
      source: str('source') ?? 'unknown',
      referrer: str('referrer'),
      utm_source: str('utm_source'),
      utm_medium: str('utm_medium'),
      utm_campaign: str('utm_campaign'),
      iat,
      exp: iat + TOKEN_TTL_SECONDS
    }, deps.secret);
    return {
      scope,
      label: SCOPE_LABELS[scope],
      url: `${deps.siteUrl}/confirm?t=${encodeURIComponent(token)}`
    };
  });

  try {
    await deps.sendConfirmationEmail(email, links);
  } catch (err) {
    console.error('[subscribe] confirmation send failed:', err);
    return json({ error: 'could not send confirmation' }, 502);
  }

  return ok();
}

function liveDeps(): SubscribeDeps {
  const supa = adminClient();
  return {
    secret: (import.meta.env.SUBSCRIBE_TOKEN_SECRET ?? process.env.SUBSCRIBE_TOKEN_SECRET) as string,
    siteUrl: (import.meta.env.PUBLIC_SITE_URL ?? process.env.PUBLIC_SITE_URL) as string,
    checkRateLimit: (email, ip) => realCheckRateLimit(supa, email, ip),
    sendConfirmationEmail: (to, links) => realSendConfirmationEmail(
      to, links, (import.meta.env.RESEND_API_KEY ?? process.env.RESEND_API_KEY) as string
    )
  };
}

export const POST: APIRoute = async ({ request }) => handleSubscribe(request, liveDeps());
export const GET: APIRoute = async () => methodNotAllowed();
export const PUT: APIRoute = async () => methodNotAllowed();
export const DELETE: APIRoute = async () => methodNotAllowed();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/api/subscribe.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, no type errors. The stale `getProvider()` call from Task 3 Step 6 is now gone.

- [ ] **Step 6: Commit**

```bash
git add src/pages/api/subscribe.ts tests/api/subscribe.test.ts
git commit -m "feat(consent): require confirmed opt-in before subscribing"
```

---

## Task 8: Front-end, copy, and crawler directives

**Files:**
- Modify: `src/config/site.ts`
- Modify: `src/components/EmailCapture.astro`
- Modify: `src/pages/privacy.astro`
- Modify: `public/robots.txt`

- [ ] **Step 1: Split the consent copy**

In `src/config/site.ts`, replace the single `consentText` line inside `email:` with:

```ts
    consentTextDigest: 'Send me the TradieIntel weekly digest.',
    consentTextCommercial: 'Also send me occasional emails from GrokoryAI about AI tools for trades businesses.',
```

Note for the implementer: audience-facing copy, so no emdashes and no spaced hyphen bracketing a phrase.

- [ ] **Step 2: Replace the single checkbox with two**

In `src/components/EmailCapture.astro`, replace the existing single consent `<label>` block with:

```astro
  <label class="flex items-start gap-2 text-xs text-white/80">
    <input type="checkbox" name="consent_digest" required class="mt-0.5" />
    <span>{SITE.email.consentTextDigest}</span>
  </label>

  <label class="flex items-start gap-2 text-xs text-white/80 mt-2">
    <input type="checkbox" name="consent_commercial" class="mt-0.5" />
    <span>{SITE.email.consentTextCommercial}</span>
  </label>
```

Only the first carries `required`. The second is genuinely optional — do not add `required` or pre-check it.

- [ ] **Step 3: Update the submit handler**

In the same file's `<script>` block, replace the `const consent = ...` line and the `consent` field in the fetch body:

```ts
      const consentDigest = data.get('consent_digest') === 'on';
      const consentCommercial = data.get('consent_commercial') === 'on';
```

and in the JSON body, replace `consent,` with:

```ts
            consent_digest: consentDigest,
            consent_commercial: consentCommercial,
```

- [ ] **Step 4: Update the success message**

In the same `<script>` block, the success path currently reports a completed subscription. It must now tell the user to go and confirm — otherwise a user who never opens their email believes they are subscribed:

```ts
        msg.textContent = 'Almost done. Check your inbox and click the confirmation link.';
```

Also update the in-flight message from `'Subscribing...'` to `'Sending confirmation...'`.

- [ ] **Step 5: Disallow `/confirm` for crawlers**

`public/robots.txt` has ten user-agent blocks, each with `Disallow: /api/`. Add a `Disallow: /confirm` line directly beneath **every** `Disallow: /api/` line — a token-bearing URL must not be indexable, and a directive in only the first block leaves the other nine crawlers free to index it.

Verify all ten landed:

```bash
grep -c "Disallow: /confirm" public/robots.txt
```

Expected: `10`.

- [ ] **Step 6: Document the change on the privacy page**

In `src/pages/privacy.astro`, replace the subscription section with this copy (AU spelling, no emdashes, no bracketing hyphens, per the house rule for audience-facing text):

```html
<h2>Subscribing and consent</h2>

<p>
  When you subscribe, we send a confirmation link to the address you entered. You are
  not added to any list until you click it. If you ignore that email, nothing further
  is sent to you.
</p>

<p>
  There are two separate things you can agree to, and you can choose either one on its
  own. The first is the TradieIntel weekly digest. The second is occasional email from
  GrokoryAI, the company that publishes TradieIntel, about AI tools for trades
  businesses. Agreeing to the digest does not sign you up for GrokoryAI email, and each
  one is confirmed by its own link.
</p>

<p>
  When you confirm, we keep a record of it: the address, which of the two you agreed to,
  the time you asked and the time you confirmed, the page you signed up from, and your
  IP address stored as a one-way hash rather than in readable form. We keep this as
  proof that consent was given, as required under the Spam Act 2003.
</p>

<p>
  You can withdraw either consent at any time using the unsubscribe link in any email we
  send, or by emailing <a href="mailto:hello@tradieintel.com.au">hello@tradieintel.com.au</a>.
</p>
```

Match the surrounding markup: if the existing page wraps sections in a styled container or uses different heading levels, follow that rather than pasting these tags verbatim.

- [ ] **Step 7: Verify the form end to end locally**

Start the dev server via the preview tooling (not `npm run dev` in a shell), submit the form with only the required box ticked, and confirm: the network request body contains `consent_digest: true` and no `consent_commercial: true`, the response is 200, and the success message tells the user to check their inbox.

- [ ] **Step 8: Commit**

```bash
git add src/config/site.ts src/components/EmailCapture.astro src/pages/privacy.astro public/robots.txt
git commit -m "feat(consent): split consent checkboxes and update subscriber-facing copy"
```

---

## Task 9: End-to-end verification on preview

Unit tests use mocks; mocks accept anything. This task is the only proof the real chain works.

**Files:** none — verification only.

- [ ] **Step 1: Deploy to a Vercel preview with the new env vars set**

Set `SUBSCRIBE_TOKEN_SECRET`, `RESEND_API_KEY` in the Vercel project (preview scope). Leave `NITROSEND_LIST_ID_COMMERCIAL` **unset** — that is the intended launch state and Step 4 verifies it behaves correctly.

- [ ] **Step 2: Happy path, both boxes ticked**

Submit the form on the preview URL with a mailbox you control, both boxes ticked. Verify in order:

1. One email arrives (not two), containing two distinct confirmation links
2. Click the digest link → success page renders, HTTP 200
3. `select email, scope, requested_at, utm_source from subscriber_consents where email = '<yours>';` returns a `tradieintel_digest` row with `requested_at` earlier than `confirmed_at`
4. The address appears subscribed in NitroSend: `nitro_query` on contacts, or the dashboard

- [ ] **Step 3: Confirm the second scope independently**

Click the GrokoryAI link from the same email. Verify a second row appears with `scope = 'grokoryai_commercial'`, and that the digest row is unchanged. This proves the two consents are genuinely independent.

- [ ] **Step 4: Unconfigured commercial scope does not error**

Because `NITROSEND_LIST_ID_COMMERCIAL` is unset, Step 3 should have rendered the ordinary success page with no provider call and no 502. Confirm the Vercel function logs show no provider error for that request. This is the audit-only path from spec §3.2b.

- [ ] **Step 5: Provider failure keeps the consent record — the ordering proof**

Temporarily set `NITROSEND_API_KEY` to an invalid value in the preview environment. Sign up a second address and click its digest link. Verify:

1. The page shows the "Almost there" retry copy, HTTP 502 — **not** a success page
2. A `subscriber_consents` row for that address **exists anyway**
3. Clicking the same link again after restoring the real key completes the subscription

Restore `NITROSEND_API_KEY` immediately afterwards.

- [ ] **Step 6: Expired and tampered links are refused**

Append a character to a valid token in the URL → 400, "not valid" copy, and no new `subscriber_consents` row. This is a live check of the same property `tests/lib/confirm.test.ts` asserts.

- [ ] **Step 7: `/confirm` is not indexable**

```bash
curl -s https://<preview-url>/confirm?t=x | grep -i "noindex"
curl -sI https://<preview-url>/confirm?t=x | grep -i "referrer-policy"
```

Expected: the `noindex, nofollow` meta tag is present, and `Referrer-Policy: no-referrer` is in the response headers.

- [ ] **Step 8: Clean up test data**

Run via `db query --linked`, the same subcommand verified in Task 2 (there is no `db execute`):

```bash
npx supabase db query --linked "delete from subscriber_consents where email in ('<test addresses>'); delete from subscribe_attempts;"
```

Also unsubscribe or delete the test contacts from NitroSend so they do not become the same kind of junk that started this work.

- [ ] **Step 9: Commit any fixes and promote to production**

```bash
git add -A
git commit -m "fix(consent): address end-to-end verification findings"
```

Deploy to production only after every step above passes.

---

## Post-implementation

Once live, two follow-ups sit outside this plan and are tracked in spec §7 and §8:

1. **Cloudflare Turnstile** on the signup form. Confirmed opt-in plus rate limiting covers the immediate risk; Turnstile is the next increment.
2. **Move `tradieintel.com.au` off NitroSend's shared sending pool** onto the account's own Resend infrastructure (`byo_routing.mismatch: true` as of 2026-08-12), so complaint reputation stops landing on a shared resource.

Spec §8 Q6 also remains open: whether to provision a GrokoryAI commercial list before launch or ship consent-capture-only. This plan ships correctly either way.
