-- check_email_status: returns auth status for an email without exposing user_id.
-- Designed to be called ONLY from Edge Functions via service_role.
-- The Edge Function adds rate limiting before calling this; do NOT grant to anon.
--
-- Returns one of:
--   { "status": "not_registered" }
--   { "status": "has_password" }
--   { "status": "oauth_only", "provider": "google" | "discord" | ... }

create or replace function public.check_email_status(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_providers text[];
  v_preferred text;
begin
  select id into v_user_id
  from auth.users
  where lower(email) = lower(trim(p_email))
  limit 1;

  if v_user_id is null then
    return jsonb_build_object('status', 'not_registered');
  end if;

  select array_agg(provider) into v_providers
  from auth.identities
  where user_id = v_user_id;

  if v_providers is null or array_length(v_providers, 1) = 0 then
    return jsonb_build_object('status', 'not_registered');
  end if;

  if 'email' = any(v_providers) then
    return jsonb_build_object('status', 'has_password');
  end if;

  -- OAuth-only: prefer google > discord > first
  if 'google' = any(v_providers) then
    v_preferred := 'google';
  elsif 'discord' = any(v_providers) then
    v_preferred := 'discord';
  else
    v_preferred := v_providers[1];
  end if;

  return jsonb_build_object(
    'status', 'oauth_only',
    'provider', v_preferred
  );
end;
$$;

revoke all on function public.check_email_status(text) from public, anon, authenticated;
grant execute on function public.check_email_status(text) to service_role;
