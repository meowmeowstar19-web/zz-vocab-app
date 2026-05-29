-- Anti-scraping Phase 2: server-side read API (batched, no SELECT *, no totals).
--
-- The four content tables have RLS on with NO policies (Phase 1), so the only
-- read path is through these SECURITY DEFINER functions. Crucially their EXECUTE
-- grant is REVOKED from anon/authenticated: the browser CANNOT call them via
-- PostgREST. Only service_role can — i.e. the Phase 2 Edge Functions, which
-- validate auth.uid() first and (Phase 6) will attach rate-limiting. That makes
-- the Edge Function the single door; "batched + rate-limited" can't be bypassed
-- from the frontend.
--
-- Pagination is keyset on `slug` (unique, stable). The caller passes the last
-- slug it saw as p_cursor; we return slugs strictly greater. We NEVER return a
-- total count — per-category numbers come only from get_meta, and even there
-- only as counts, never content.
--
-- "Available for this language pair" = has a non-null `text` translation in BOTH
-- the native and target language (mirrors isWordAvailable() in langHelpers.js).
--
-- App behaviour is unchanged in Phase 2 (still reads bundled JS). Phase 3 wires
-- the frontend to these via wordsRepo.

-- ── get_word_batch ───────────────────────────────────────────────────────────
create or replace function public.get_word_batch(
  p_native text,
  p_target text,
  p_cursor text default null,
  p_limit  int  default 30
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with picked as (
    select w.id, w.slug, w.category, w.level, w.image_path
    from public.words w
    where exists (
            select 1 from public.word_translations t
            where t.word_id = w.id and t.lang_code = p_native and t.text is not null
          )
      and exists (
            select 1 from public.word_translations t
            where t.word_id = w.id and t.lang_code = p_target and t.text is not null
          )
      and (p_cursor is null or w.slug > p_cursor)
    order by w.slug
    limit greatest(least(coalesce(p_limit, 30), 50), 1)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'slug',       p.slug,
        'category',   p.category,
        'level',      p.level,
        'image_path', p.image_path,
        'native', (select to_jsonb(x) from (
          select t.text, t.sentence, t.reading, t.phonetic
          from public.word_translations t
          where t.word_id = p.id and t.lang_code = p_native
        ) x),
        'target', (select to_jsonb(x) from (
          select t.text, t.sentence, t.reading, t.phonetic
          from public.word_translations t
          where t.word_id = p.id and t.lang_code = p_target
        ) x)
      )
      order by p.slug
    ),
    '[]'::jsonb
  )
  from picked p;
$$;

-- ── get_phrase_batch ─────────────────────────────────────────────────────────
create or replace function public.get_phrase_batch(
  p_native text,
  p_target text,
  p_cursor text default null,
  p_limit  int  default 30
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with picked as (
    select ph.id, ph.slug, ph.category
    from public.phrases ph
    where exists (
            select 1 from public.phrase_translations t
            where t.phrase_id = ph.id and t.lang_code = p_native and t.text is not null
          )
      and exists (
            select 1 from public.phrase_translations t
            where t.phrase_id = ph.id and t.lang_code = p_target and t.text is not null
          )
      and (p_cursor is null or ph.slug > p_cursor)
    order by ph.slug
    limit greatest(least(coalesce(p_limit, 30), 50), 1)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'slug',     p.slug,
        'category', p.category,
        'native', (select to_jsonb(x) from (
          select t.text, t.sentence, t.reading, t.phonetic
          from public.phrase_translations t
          where t.phrase_id = p.id and t.lang_code = p_native
        ) x),
        'target', (select to_jsonb(x) from (
          select t.text, t.sentence, t.reading, t.phonetic
          from public.phrase_translations t
          where t.phrase_id = p.id and t.lang_code = p_target
        ) x)
      )
      order by p.slug
    ),
    '[]'::jsonb
  )
  from picked p;
$$;

-- ── get_meta ─────────────────────────────────────────────────────────────────
-- languages + per-category COUNTS only (numbers, never content). Counts are
-- filtered to the given language pair so the word-list page can show "30/200"
-- without ever pulling the full set. Category *labels* stay bundled in the app
-- (they're UI strings, not scrapeable content) so we don't ship them here.
create or replace function public.get_meta(
  p_native text,
  p_target text
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'languages', (
      select coalesce(
        jsonb_agg(jsonb_build_object('code', l.code, 'name', l.name, 'ipa_kind', l.ipa_kind) order by l.code),
        '[]'::jsonb
      )
      from public.languages l
    ),
    'wordCategories', (
      select coalesce(jsonb_object_agg(category, cnt), '{}'::jsonb)
      from (
        select w.category, count(*)::int as cnt
        from public.words w
        where exists (select 1 from public.word_translations t where t.word_id = w.id and t.lang_code = p_native and t.text is not null)
          and exists (select 1 from public.word_translations t where t.word_id = w.id and t.lang_code = p_target and t.text is not null)
        group by w.category
      ) s
    ),
    'phraseCategories', (
      select coalesce(jsonb_object_agg(category, cnt), '{}'::jsonb)
      from (
        select ph.category, count(*)::int as cnt
        from public.phrases ph
        where exists (select 1 from public.phrase_translations t where t.phrase_id = ph.id and t.lang_code = p_native and t.text is not null)
          and exists (select 1 from public.phrase_translations t where t.phrase_id = ph.id and t.lang_code = p_target and t.text is not null)
        group by ph.category
      ) s
    )
  );
$$;

-- ── Lock execution: only service_role (the Edge Functions) may call these. ────
-- create-or-replace grants EXECUTE to PUBLIC by default; revoke it so a
-- logged-in browser client can't hit the RPCs directly and bypass the Edge
-- Function's auth check + (Phase 6) rate limits.
revoke all on function public.get_word_batch(text, text, text, int) from public;
revoke all on function public.get_phrase_batch(text, text, text, int) from public;
revoke all on function public.get_meta(text, text) from public;
revoke all on function public.get_word_batch(text, text, text, int) from anon, authenticated;
revoke all on function public.get_phrase_batch(text, text, text, int) from anon, authenticated;
revoke all on function public.get_meta(text, text) from anon, authenticated;
grant execute on function public.get_word_batch(text, text, text, int) to service_role;
grant execute on function public.get_phrase_batch(text, text, text, int) to service_role;
grant execute on function public.get_meta(text, text) to service_role;
