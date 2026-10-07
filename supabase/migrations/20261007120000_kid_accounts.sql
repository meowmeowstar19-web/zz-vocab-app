-- 13岁以下账号（2026-10-07，从 miracleZZ 移植；方案 = miracleZZ webapp/docs/kids-account-plan.md，
-- PW 差异见 docs/kids-account.md）。ZZ 的两份迁移（kid_accounts + kid_retention）在这里合成一份。
--
-- 1. rate_hit()：按 IP 限频的计数器，kid-signup 函数和「请家长帮忙」表共用。
--    IP 在 COPPA 里算持久标识 → 原值不落盘，只存「加盐哈希 + 时间」，一天后删。
-- 2. parent_help_requests：「请家长帮忙」表单。匿名只能插入、不能读；中台用
--    service_role 看请求、重置密码，处理完把家长邮箱清掉。
-- 3. admin_kid_lookup()：中台用用户名查儿童号（auth.users 不对外暴露），只给 service_role。
-- 4. 保存期限（隐私政策 §8，36 个月）：儿童号连续 36 个月没用过 → 连同进度一起删；
--    家长求助请求 36 个月后删。pg_cron 每周日 04:41 UTC 跑。
--
-- 儿童号本身不需要表：就是 auth.users 里 app_metadata.kid = true 的邮箱+密码账号，
-- 邮箱是 <用户名>@kids.plushieword.invalid（kid-signup 函数用 service role 建）。
-- ⚠️ 域名四处必须一致：本文件（admin_kid_lookup + kid_accounts_due_for_purge +
-- purge_inactive_kid_accounts）、login-auth-ui/theme.js KID_EMAIL_DOMAIN、
-- supabase/functions/kid-signup/config.ts。

/* ------------------------------------------------------------ rate limit */
create table if not exists public.rate_salt (
  id   int primary key default 1 check (id = 1),
  salt text not null
);
insert into public.rate_salt (id, salt)
values (1, replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
on conflict (id) do nothing;
alter table public.rate_salt enable row level security; -- 没有策略：只有 service_role / definer 函数碰得到

create table if not exists public.rate_hits (
  bucket  text not null,
  ip_hash text not null,
  at      timestamptz not null default now()
);
create index if not exists rate_hits_lookup on public.rate_hits (bucket, ip_hash, at);
create index if not exists rate_hits_at on public.rate_hits (at);
alter table public.rate_hits enable row level security; -- 没有策略

-- 记一次并返回「放不放行」：窗口内已满 p_max 次 → false（这次不记）。窗口最长一天。
create or replace function public.rate_hit(p_bucket text, p_ip text, p_max int, p_window_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  h text;
  n int;
begin
  select encode(sha256(convert_to(s.salt || '|' || coalesce(nullif(btrim(p_ip), ''), 'unknown'), 'UTF8')), 'hex')
    into h from public.rate_salt s where s.id = 1;
  delete from public.rate_hits where at < now() - interval '1 day';
  select count(*) into n from public.rate_hits
    where bucket = p_bucket and ip_hash = h and at > now() - make_interval(secs => least(p_window_seconds, 86400));
  if n >= p_max then
    return false;
  end if;
  insert into public.rate_hits (bucket, ip_hash) values (p_bucket, h);
  return true;
end
$$;
revoke all on function public.rate_hit(text, text, int, int) from public, anon, authenticated;
grant execute on function public.rate_hit(text, text, int, int) to service_role;

/* --------------------------------------------------- parent help requests */
create table if not exists public.parent_help_requests (
  id           uuid primary key default gen_random_uuid(),
  username     text not null check (username ~ '^[a-z0-9_]{3,16}$'),
  parent_email text check (parent_email is null or (char_length(parent_email) <= 254 and parent_email ~ '^[^@[:space:]]+@[^@[:space:]]+$')),
  message      text check (message is null or char_length(message) <= 1000),
  created_at   timestamptz not null default now(),
  handled_at   timestamptz -- 中台点「处理完」：同时清掉 parent_email
);
create index if not exists parent_help_open on public.parent_help_requests (created_at desc) where handled_at is null;
alter table public.parent_help_requests enable row level security;

-- 匿名（没登录的孩子）和已登录都只能插，不能读 / 改 / 删
drop policy if exists parent_help_insert on public.parent_help_requests;
create policy parent_help_insert on public.parent_help_requests
  for insert to anon, authenticated
  with check (handled_at is null);
revoke all on public.parent_help_requests from anon, authenticated;
grant insert on public.parent_help_requests to anon, authenticated;

-- 插入前：规整字段、钉死时间、按 IP 限频（每 IP 每小时 5 条，全站每天 300 条兜底）。
-- IP 取 PostgREST 转进来的请求头。
create or replace function public.parent_help_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  hdrs json := nullif(current_setting('request.headers', true), '')::json;
  ip   text := coalesce(
    nullif(btrim(split_part(hdrs ->> 'x-forwarded-for', ',', 1)), ''),
    hdrs ->> 'cf-connecting-ip',
    hdrs ->> 'x-real-ip'
  );
begin
  new.username := lower(btrim(new.username));
  new.parent_email := nullif(btrim(new.parent_email), '');
  new.message := nullif(btrim(new.message), '');
  new.created_at := now();
  new.handled_at := null;
  if not public.rate_hit('parent-help', ip, 5, 3600) then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  if not public.rate_hit('parent-help-all', 'all', 300, 86400) then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function public.parent_help_guard() from public, anon, authenticated;

drop trigger if exists parent_help_guard on public.parent_help_requests;
create trigger parent_help_guard
  before insert on public.parent_help_requests
  for each row execute function public.parent_help_guard();

/* ------------------------------------------------------- admin: kid lookup */
create or replace function public.admin_kid_lookup(p_username text)
returns table (id uuid, created_at timestamptz, last_sign_in_at timestamptz, kid boolean)
language sql
stable
security definer
set search_path = public, auth
as $$
  select u.id, u.created_at, u.last_sign_in_at, coalesce((u.raw_app_meta_data ->> 'kid')::boolean, false)
  from auth.users u
  where u.email = lower(btrim(p_username)) || '@kids.plushieword.invalid'
$$;
revoke all on function public.admin_kid_lookup(text) from public, anon, authenticated;
grant execute on function public.admin_kid_lookup(text) to service_role;

/* ---------------------------------------------------------------- retention */
-- 「用过」取下面几个里最晚的：建号、登录、会话刷新（一直保持登录的孩子不会再「登录」，
-- 但每次打开 app 都会刷新会话）、云端进度最后写入（user_progress.updated_at）、
-- 反爬每日活动记录（daily_activity.last_ts）。
-- ⚠️ 只碰儿童号：app_metadata.kid = true 并且 邮箱是 @kids.plushieword.invalid，两个条件
-- 都满足才算。删 auth.users 会级联删 user_progress / feedback（on delete cascade）；
-- daily_activity / account_flags 没有外键，在 purge 里手动删。

create extension if not exists pg_cron with schema pg_catalog;

-- 只读：现在到期的儿童号（中台 / 排查时可以先看名单）。p_inactive 只给排查用，删除固定 36 个月。
create or replace function public.kid_accounts_due_for_purge(p_inactive interval default interval '36 months')
returns table (id uuid, email text, last_active timestamptz)
language sql
stable
security definer
set search_path = public, auth
as $$
  select u.id, u.email::text, a.last_active
  from auth.users u
  cross join lateral (
    select greatest(
      u.created_at,
      u.last_sign_in_at,
      (select max(greatest(s.updated_at, s.refreshed_at::timestamptz)) from auth.sessions s where s.user_id = u.id),
      (select p.updated_at from public.user_progress p where p.user_id = u.id),
      (select max(d.last_ts) from public.daily_activity d where d.user_id = u.id)
    ) as last_active
  ) a
  where u.raw_app_meta_data ->> 'kid' = 'true'
    and u.email like '%@kids.plushieword.invalid'
    and a.last_active < now() - p_inactive
$$;
revoke all on function public.kid_accounts_due_for_purge(interval) from public, anon, authenticated;
grant execute on function public.kid_accounts_due_for_purge(interval) to service_role;

-- 真删。返回删掉的儿童号个数。
create or replace function public.purge_inactive_kid_accounts()
returns int
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  ids uuid[];
  n int;
begin
  select coalesce(array_agg(u.id), '{}') into ids
  from auth.users u
  join public.kid_accounts_due_for_purge(interval '36 months') d on d.id = u.id
  where u.raw_app_meta_data ->> 'kid' = 'true'          -- 再核一遍：绝不碰普通账号
    and u.email like '%@kids.plushieword.invalid';
  delete from public.daily_activity where user_id = any(ids);
  delete from public.account_flags where user_id = any(ids);
  delete from auth.users where id = any(ids);
  get diagnostics n = row_count;
  delete from public.parent_help_requests where created_at < now() - interval '36 months';
  return n;
end
$$;
revoke all on function public.purge_inactive_kid_accounts() from public, anon, authenticated;
grant execute on function public.purge_inactive_kid_accounts() to service_role;

select cron.schedule('purge-inactive-kid-accounts', '41 4 * * 0', 'select public.purge_inactive_kid_accounts()');
