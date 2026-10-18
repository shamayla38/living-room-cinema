-- Adds a watched shelf without removing films, votes, screenings, or RSVPs.
alter table public.movies add column watched boolean not null default false;
alter table public.movies add constraint watched_movies_are_inactive check (not watched or not active);

create or replace function public.cinema_state() returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'movies', coalesce((select jsonb_agg(to_jsonb(m) order by m.title) from public.movies m where active), '[]'::jsonb),
    'watched', coalesce((select jsonb_agg(to_jsonb(m) order by m.title) from public.movies m where watched), '[]'::jsonb),
    'round', (select to_jsonb(r) from public.rounds r join public.settings s on s.round_id=r.id),
    'counts', coalesce((select jsonb_object_agg(movie_id,n) from (select movie_id,count(*) n from public.votes v join public.settings s on s.round_id=v.round_id group by movie_id) c), '{}'::jsonb),
    'mine', coalesce((select jsonb_agg(movie_id) from public.votes v join public.settings s on s.round_id=v.round_id where user_id=auth.uid()), '[]'::jsonb),
    'event', (select to_jsonb(e) || jsonb_build_object('seats_taken',(select count(*) from public.rsvps where event_id=e.id)) from public.events e where starts_at>now() and not cancelled order by starts_at limit 1)
  );
$$;

create function public.set_movie_watched(p_movie text, p_watched boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_host();
  if p_watched is null then raise exception 'Choose a watched status'; end if;
  perform 1 from public.settings for update;
  if p_watched and exists(select 1 from public.events where movie_id=p_movie and not cancelled and starts_at>now()) then
    raise exception 'This film has an upcoming screening. Mark it watched after the screening.';
  end if;
  update public.movies set watched=p_watched, active=not p_watched where id=p_movie;
  if not found then raise exception 'Film not found'; end if;
end $$;
revoke all on function public.set_movie_watched(text,boolean) from public, anon, authenticated;
grant execute on function public.set_movie_watched(text,boolean) to authenticated;
