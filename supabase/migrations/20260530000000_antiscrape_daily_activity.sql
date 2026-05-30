-- Anti-scraping Phase 6 — 切片1 (slice 1): server-side behaviour metering.
-- OBSERVE-ONLY. Nothing here rejects, throttles, or changes what the app
-- serves. It only counts how much content each account pulls per day and lets a
-- daily pg_cron job flag the obvious bot signature ("pulled a lot, learned
-- nothing"). Enforcement (drip-feed gate, 3/sec line, client windowed fetch)
-- is 切片2 and intentionally NOT in this migration.
--
-- Why this is safe to ship before the client stops bulk-pulling: the counter is
-- incremented fire-and-forget from the Edge Functions and is read by NOBODY in
-- the request path. Even while the client still streams the whole library,
-- words_fetched just runs high — the flag logic keys on progress_count = 0, and
-- a real learner always writes progress, so high counts alone never flag them.

-- ── daily_activity: one row per account per (UTC) day ────────────────────────
-- words_fetched counts content items handed out by BOTH batch endpoints
-- (words + phrases) — it's "content rows served", not a per-event audit log.
-- We deliberately store NO word_id and NO IP:极轻, privacy-cheap.
create table if not exists public.daily_activity (
  user_id     uuid        not null,
  day         date        not null,
  words_fetched int       not null default 0,
  first_ts    timestamptz not null default now(),
  last_ts     timestamptz not null default now(),
  -- Largest gap (seconds) between two consecutive fetches that day. A grinding
  -- bot has a small max_gap for hours; a human takes breaks.
  max_gap_sec int         not null default 0,
  primary key (user_id, day)
);

-- Lock it down: clients must never read or write this directly (same posture as
-- the content tables). Only service_role (Edge Functions / pg_cron) touches it.
alter table public.daily_activity enable row level security;
revoke all on table public.daily_activity from anon, authenticated, public;

-- ── account_flags: output of the daily scan (待复核 / 自动封候选) ──────────────
-- 切片1 only WRITES flags for observation. NOTHING consults this table yet, so
-- flagging an account has zero user-facing effect. Wiring enforcement to read
-- `status = 'banned'` is a later step (切片2+). Ban is always recoverable
-- (delete the row / set status back).
create table if not exists public.account_flags (
  user_id       uuid        primary key,
  status        text        not null,   -- 'review' | 'auto_ban_candidate' | 'banned'
  reason        text,
  flagged_day   date,
  words_fetched int,
  progress_count int,
  span_sec      int,
  max_gap_sec   int,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.account_flags enable row level security;
revoke all on table public.account_flags from anon, authenticated, public;

-- ── bump_daily_activity: atomic per-fetch counter upsert ─────────────────────
-- Called by the Edge Functions (fire-and-forget) after handing out a batch.
-- Computes the inter-fetch gap server-side so the Edge code stays trivial.
-- Day bucket is UTC — fine for a coarse daily behaviour signal.
create or replace function public.bump_daily_activity(p_user_id uuid, p_count int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_day date := (v_now at time zone 'UTC')::date;
begin
  if p_user_id is null or coalesce(p_count, 0) <= 0 then
    return;
  end if;
  insert into public.daily_activity as da (user_id, day, words_fetched, first_ts, last_ts, max_gap_sec)
  values (p_user_id, v_day, p_count, v_now, v_now, 0)
  on conflict (user_id, day) do update
    set words_fetched = da.words_fetched + excluded.words_fetched,
        max_gap_sec   = greatest(da.max_gap_sec, extract(epoch from (v_now - da.last_ts))::int),
        last_ts       = v_now;
end;
$$;

revoke all on function public.bump_daily_activity(uuid, int) from public, anon, authenticated;
grant execute on function public.bump_daily_activity(uuid, int) to service_role;

-- ── derive_progress_count: 已学词条数 from the user_progress blob ─────────────
-- progress_writes is NOT a stored event counter — we derive it from the
-- existing user_progress.data->'progress' map (word_id -> entry, per target
-- lang). Total learned entries across all targets. This reuses the signal
-- progressSync.js already writes; no new client beacon, no extra cost.
-- (skip counts as a write too — it sets the word mastered — so even a
-- frantic-skipping human has progress_count > 0 and is never flagged.)
create or replace function public.derive_progress_count(p_user_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select sum((select count(*) from jsonb_object_keys(t.value)))::int
    from public.user_progress up,
         lateral jsonb_each(coalesce(up.data->'progress', '{}'::jsonb)) t
    where up.user_id = p_user_id
      and jsonb_typeof(t.value) = 'object'
  ), 0);
$$;

revoke all on function public.derive_progress_count(uuid) from public, anon, authenticated;
grant execute on function public.derive_progress_count(uuid) to service_role;

-- ── antiscrape_scan_daily_activity: the daily pg_cron job ─────────────────────
-- Scans YESTERDAY's rows (a full UTC day is settled) and flags the bot
-- signature. Two bands, both conservative — slice 1 is observe-only so the
-- 'auto_ban_candidate' status does NOT auto-ban anything yet; it just labels
-- the highest-confidence rows so a human can confirm before we wire real bans.
--
-- Thresholds (tune later from real data):
--   • review band: pulled >= 300 content items in a day with progress_count = 0.
--     A real learner who pulls that much has necessarily written progress.
--   • auto_ban_candidate band: pulled >= 1000, progress_count = 0, span > 2h,
--     and never paused longer than 5 min — i.e. a machine grinding nonstop.
create or replace function public.antiscrape_scan_daily_activity()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := ((now() at time zone 'UTC')::date) - 1;
begin
  insert into public.account_flags as af
    (user_id, status, reason, flagged_day, words_fetched, progress_count, span_sec, max_gap_sec)
  select
    da.user_id,
    case
      when da.words_fetched >= 1000
       and pc.cnt = 0
       and extract(epoch from (da.last_ts - da.first_ts)) >= 7200
       and da.max_gap_sec <= 300
        then 'auto_ban_candidate'
      else 'review'
    end as status,
    'fetched=' || da.words_fetched || ' progress=' || pc.cnt
      || ' span=' || extract(epoch from (da.last_ts - da.first_ts))::int || 's'
      || ' maxgap=' || da.max_gap_sec || 's' as reason,
    da.day,
    da.words_fetched,
    pc.cnt,
    extract(epoch from (da.last_ts - da.first_ts))::int,
    da.max_gap_sec
  from public.daily_activity da
  cross join lateral (select public.derive_progress_count(da.user_id) as cnt) pc
  where da.day = v_day
    and da.words_fetched >= 300
    and pc.cnt = 0
  on conflict (user_id) do update
    set status         = excluded.status,
        reason         = excluded.reason,
        flagged_day    = excluded.flagged_day,
        words_fetched  = excluded.words_fetched,
        progress_count = excluded.progress_count,
        span_sec       = excluded.span_sec,
        max_gap_sec    = excluded.max_gap_sec,
        updated_at     = now()
  -- Never downgrade an account already marked 'banned' by a human.
  where af.status <> 'banned';
end;
$$;

revoke all on function public.antiscrape_scan_daily_activity() from public, anon, authenticated;
grant execute on function public.antiscrape_scan_daily_activity() to service_role;

-- ── Schedule it (requires the pg_cron extension) ─────────────────────────────
-- Enable once in Supabase: Dashboard → Database → Extensions → pg_cron.
-- Runs every day at 01:15 UTC, after the prior UTC day has fully closed.
-- Safe to re-run this block: unschedule-if-exists then schedule.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'antiscrape-daily-scan') then
      perform cron.unschedule('antiscrape-daily-scan');
    end if;
    perform cron.schedule(
      'antiscrape-daily-scan',
      '15 1 * * *',
      $cron$ select public.antiscrape_scan_daily_activity(); $cron$
    );
  else
    raise notice 'pg_cron not installed — enable it, then re-run the cron.schedule block.';
  end if;
end;
$$;
