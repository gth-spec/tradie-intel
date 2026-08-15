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
