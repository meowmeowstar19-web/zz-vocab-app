-- Anti-scraping Phase 6 — 切片2 (c): real-time request gate.
-- ENFORCEMENT (unlike 切片1 which only observes). Two checks run per content
-- batch request, both designed so a real learner can NEVER trip them:
--
--   1) machine-flood speed line — token bucket, refill 5/sec, burst 30.
--      Absorbs the client's open-burst (filling its look-ahead window fetches a
--      few pages back-to-back) AND any refill-when-low burst, because the bucket
--      starts/refills with 30 tokens. Only SUSTAINED firing above 5/sec (a loop
--      hammering the Edge endpoint) drains the bucket and gets a silent 429.
--
--   2) no-interaction gate (the drip-feed "interaction" lock, real-time form) —
--      this is about whether the account is INTERACTING WHILE LEARNING RIGHT NOW,
--      NOT its all-time total. Each word a real user sees gets an answer or a
--      skip (both write progress → mastered); a scraper just pulls words with
--      ZERO interaction. So we capture each account's progress count when its
--      day STARTS (first fetch of the UTC day → progress_at_start) and block only
--      when it has pulled a LOT today (>= 500 items) yet TODAY'S progress has not
--      moved at all (current progress - progress_at_start == 0). An account that
--      learned plenty in the past but is now pure-pulling is still caught; a user
--      who answered/skipped even once today is immune. The windowed client can't
--      reach 500 fetched with zero today-interaction (refill is interaction-gated
--      client-side), so this only fires on a bot looping the API directly.
--
-- ⚠️ DEPLOY ORDER: the windowed-fetch client (commit 8a4696e) MUST be live and
-- rolled out BEFORE these checks are wired into the Edge Functions, or the line
-- hits old clients still bulk-pulling and walls our own users. This migration is
-- inert until the Edge Functions call antiscrape_request_gate (切片2 (c)).
--
-- Fail-open everywhere: any error in the gate must let the request through. A
-- gate bug must never block a real learner.

-- ── rate_limit_bucket: per-account token bucket ──────────────────────────────
-- One row per account. tokens is a fractional count refilled by elapsed time.
-- Locked down like the other anti-scrape tables: service_role only.
create table if not exists public.rate_limit_bucket (
  user_id    uuid        primary key,
  tokens     numeric     not null,
  updated_at timestamptz not null default now()
);
alter table public.rate_limit_bucket enable row level security;
revoke all on table public.rate_limit_bucket from anon, authenticated, public;

-- ── check_rate_limit: token-bucket take-one ──────────────────────────────────
-- Refills by (elapsed seconds * p_refill) capped at p_burst, then spends one
-- token if available. Returns true (allowed) / false (throttled). Row-locked so
-- concurrent requests for the same account don't double-spend.
create or replace function public.check_rate_limit(p_user_id uuid, p_refill numeric, p_burst numeric)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now     timestamptz := now();
  v_tokens  numeric;
  v_updated timestamptz;
begin
  if p_user_id is null then
    return true;
  end if;

  select tokens, updated_at into v_tokens, v_updated
    from public.rate_limit_bucket
    where user_id = p_user_id
    for update;

  if not found then
    -- First request: full bucket, spend one.
    insert into public.rate_limit_bucket (user_id, tokens, updated_at)
      values (p_user_id, p_burst - 1, v_now);
    return true;
  end if;

  v_tokens := least(p_burst, v_tokens + extract(epoch from (v_now - v_updated)) * p_refill);
  if v_tokens >= 1 then
    update public.rate_limit_bucket
      set tokens = v_tokens - 1, updated_at = v_now
      where user_id = p_user_id;
    return true;
  else
    -- Out of tokens: bank the refill (so it keeps accruing) but don't spend.
    update public.rate_limit_bucket
      set tokens = v_tokens, updated_at = v_now
      where user_id = p_user_id;
    return false;
  end if;
end;
$$;

revoke all on function public.check_rate_limit(uuid, numeric, numeric) from public, anon, authenticated;
grant execute on function public.check_rate_limit(uuid, numeric, numeric) to service_role;

-- ── daily_activity.progress_at_start: today's interaction baseline ───────────
-- The no-interaction gate measures TODAY'S progress delta, so it needs the
-- progress count as it stood when the account's day began. Captured on the first
-- fetch of the day (the INSERT branch of bump_daily_activity). Nullable: rows
-- created by 切片1 before this migration have no baseline → the gate treats them
-- as unmeasurable and never blocks them.
alter table public.daily_activity add column if not exists progress_at_start int;

-- Replace bump_daily_activity (originally from 20260530000000) so the first
-- fetch of the day records progress_at_start. derive_progress_count runs ONLY on
-- the day's first fetch (guarded by the not-exists check), never on every bump.
create or replace function public.bump_daily_activity(p_user_id uuid, p_count int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now  timestamptz := now();
  v_day  date := (v_now at time zone 'UTC')::date;
  v_base int;
begin
  if p_user_id is null or coalesce(p_count, 0) <= 0 then
    return;
  end if;
  -- Baseline only matters when we're about to INSERT the day's first row.
  if not exists (
    select 1 from public.daily_activity where user_id = p_user_id and day = v_day
  ) then
    v_base := public.derive_progress_count(p_user_id);
  end if;
  insert into public.daily_activity as da
    (user_id, day, words_fetched, first_ts, last_ts, max_gap_sec, progress_at_start)
  values (p_user_id, v_day, p_count, v_now, v_now, 0, v_base)
  on conflict (user_id, day) do update
    set words_fetched = da.words_fetched + excluded.words_fetched,
        max_gap_sec   = greatest(da.max_gap_sec, extract(epoch from (v_now - da.last_ts))::int),
        last_ts       = v_now;
end;
$$;

revoke all on function public.bump_daily_activity(uuid, int) from public, anon, authenticated;
grant execute on function public.bump_daily_activity(uuid, int) to service_role;

-- ── antiscrape_request_gate: the combined per-request decision ────────────────
-- Returns 'ok' | 'rate' | 'noprogress'. The Edge Functions call this before
-- serving a content batch and map anything other than 'ok' to a silent 429.
--
-- Tuning lives here (5/sec, burst 30, fetch threshold 500) so the Edge code
-- stays trivial. The progress scan is short-circuited: it only runs once an
-- account has already pulled >= 500 today, so 99.9% of requests skip it.
create or replace function public.antiscrape_request_gate(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fetched  int;
  v_base     int;
  v_progress int;
begin
  if p_user_id is null then
    return 'ok';
  end if;

  -- 1) machine-flood speed line (5/sec, burst 30).
  if not public.check_rate_limit(p_user_id, 5, 30) then
    return 'rate';
  end if;

  -- 2) no-interaction gate — only consider blocking once a lot was pulled today,
  --    and only block if TODAY'S progress hasn't moved at all (pure pulling, no
  --    answer/skip). progress_at_start = progress when the day's first fetch hit.
  select words_fetched, progress_at_start into v_fetched, v_base
    from public.daily_activity
    where user_id = p_user_id
      and day = (now() at time zone 'UTC')::date;

  if coalesce(v_fetched, 0) >= 500 then
    -- Legacy row with no captured baseline → can't measure today's delta → allow.
    if v_base is null then
      return 'ok';
    end if;
    v_progress := public.derive_progress_count(p_user_id);
    if v_progress - v_base <= 0 then
      return 'noprogress';
    end if;
  end if;

  return 'ok';
end;
$$;

revoke all on function public.antiscrape_request_gate(uuid) from public, anon, authenticated;
grant execute on function public.antiscrape_request_gate(uuid) to service_role;
