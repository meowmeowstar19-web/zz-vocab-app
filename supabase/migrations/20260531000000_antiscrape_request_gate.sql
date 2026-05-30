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
--   2) zero-progress gate (the drip-feed "interaction" lock, real-time form) —
--      blocks ONLY an account that has pulled a LOT today (>= 500 content items)
--      AND has written ZERO learning progress all-time. The client cannot reach
--      500 fetched with zero progress (refill is interaction-gated client-side),
--      so this only fires on a bot looping the API directly. ANY progress (one
--      answer, one skip → mastered) makes the account immune. Same signal slice
--      1's daily scan uses ("零进度=爬虫 / 真人有进度→免疫"), just enforced live.
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
  v_progress int;
begin
  if p_user_id is null then
    return 'ok';
  end if;

  -- 1) machine-flood speed line (5/sec, burst 30).
  if not public.check_rate_limit(p_user_id, 5, 30) then
    return 'rate';
  end if;

  -- 2) zero-progress gate — only consider blocking once a lot was pulled today.
  select words_fetched into v_fetched
    from public.daily_activity
    where user_id = p_user_id
      and day = (now() at time zone 'UTC')::date;

  if coalesce(v_fetched, 0) >= 500 then
    v_progress := public.derive_progress_count(p_user_id);
    if v_progress = 0 then
      return 'noprogress';
    end if;
  end if;

  return 'ok';
end;
$$;

revoke all on function public.antiscrape_request_gate(uuid) from public, anon, authenticated;
grant execute on function public.antiscrape_request_gate(uuid) to service_role;
