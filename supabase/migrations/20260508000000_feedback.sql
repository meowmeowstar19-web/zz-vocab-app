-- Feedback table — submissions from the in-app Feedback modal.
-- Only authenticated users can insert; rows are owned by their user_id.
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  message text not null,
  native_lang text,
  target_lang text,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table public.feedback enable row level security;

drop policy if exists "feedback_insert_own" on public.feedback;
create policy "feedback_insert_own"
  on public.feedback
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "feedback_select_own" on public.feedback;
create policy "feedback_select_own"
  on public.feedback
  for select
  to authenticated
  using (auth.uid() = user_id);
