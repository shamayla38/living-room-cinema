-- Non-destructive fix for Supabase safe-update enforcement.
-- Replaces only the existing function; preserves ballots, rounds, and permissions.
create or replace function public.open_round(p_closes_at timestamptz) returns void language plpgsql security definer set search_path = '' as $$
declare result uuid;
begin
  perform private.require_host();
  perform 1 from public.settings for update;
  if p_closes_at is null or p_closes_at<=now() then raise exception 'Choose a future voting cutoff'; end if;
  update public.rounds set closes_at=least(closes_at,now()) where id=(select round_id from public.settings);
  insert into public.rounds(closes_at) values(p_closes_at) returning id into result;
  update public.settings set round_id=result where id = true;
end $$;
