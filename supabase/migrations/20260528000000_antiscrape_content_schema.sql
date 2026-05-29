-- Anti-scraping Phase 1: language-agnostic content schema.
-- The app still reads bundled src/data/*.js — this is backend scaffolding only,
-- zero behaviour change. Adding a new language never requires a schema change
-- (translations are rows, not columns).
--
-- Access model: RLS is ON with NO policies on the four content tables, so anon
-- and authenticated clients get an empty result set (no leak). Only the service
-- role (the import script / Phase 2 Edge Functions) can read or write. There is
-- deliberately NO client-facing SELECT — Phase 2 Edge Functions become the only
-- read path, which is what makes "batched + rate-limited" impossible to bypass
-- from the frontend.

create table if not exists public.languages (
  code     text primary key,          -- 'en' | 'zh' | 'ja'
  name     text not null,
  ipa_kind text                       -- 'ipa' | 'kana' | 'pinyin' | null
);

create table if not exists public.words (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,    -- == the app's word id (stable across syncs)
  category   text,
  level      text,
  image_path text,                    -- 'apple.jpg' today; Phase 5 hashes this
  created_at timestamptz not null default now()
);

create table if not exists public.word_translations (
  word_id   uuid not null references public.words(id) on delete cascade,
  lang_code text not null references public.languages(code),
  text      text,                     -- the word in this language
  sentence  text,                     -- example sentence in this language
  reading   text,                     -- kana/romaji (ja) or pinyin (zh)
  phonetic  text,                     -- IPA (en)
  primary key (word_id, lang_code)
);

create table if not exists public.phrases (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,    -- == the app's phrase id (e.g. 'oral-hello')
  category   text,
  created_at timestamptz not null default now()
);

create table if not exists public.phrase_translations (
  phrase_id uuid not null references public.phrases(id) on delete cascade,
  lang_code text not null references public.languages(code),
  text      text,
  sentence  text,
  reading   text,
  phonetic  text,
  primary key (phrase_id, lang_code)
);

create index if not exists words_category_idx   on public.words (category);
create index if not exists phrases_category_idx on public.phrases (category);

-- ── RLS: lock everything. No policies = deny all to anon/authenticated. ──────
-- Service role bypasses RLS, so the import script and Edge Functions still work.
alter table public.languages           enable row level security;
alter table public.words               enable row level security;
alter table public.word_translations   enable row level security;
alter table public.phrases             enable row level security;
alter table public.phrase_translations enable row level security;
