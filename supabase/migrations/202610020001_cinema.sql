-- All writes go through narrowly scoped RPCs. No guest can read contact lists.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.hosts (
  user_id uuid primary key references auth.users(id) on delete cascade
);
create table public.movies (
  id text primary key,
  title text not null check (length(trim(title)) between 1 and 200),
  year integer not null check (year between 1888 and 2100),
  genres text[] not null,
  description text not null check (length(description) between 1 and 500),
  poster text not null check (poster ~ '^(https://|assets/)'),
  imdb jsonb,
  rt jsonb,
  active boolean not null default true
);
create table public.rounds (
  id uuid primary key default gen_random_uuid(),
  opens_at timestamptz not null default now(),
  closes_at timestamptz not null default now() + interval '7 days',
  check (closes_at >= opens_at)
);
create table public.settings (
  id boolean primary key default true check (id),
  round_id uuid not null references public.rounds(id)
);
with r as (insert into public.rounds default values returning id)
insert into public.settings(round_id) select id from r;
create table public.votes (
  round_id uuid not null references public.rounds(id),
  movie_id text not null references public.movies(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (round_id, movie_id, user_id)
);
create table public.suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 200),
  name text not null check (length(name) <= 100),
  created_at timestamptz not null default now(),
  reviewed boolean not null default false
);
create table public.events (
  id uuid primary key default gen_random_uuid(),
  movie_id text not null references public.movies(id),
  starts_at timestamptz not null,
  timezone text not null default 'America/New_York',
  location text not null check (length(trim(location)) between 1 and 200),
  capacity integer not null check (capacity between 1 and 100),
  cancelled boolean not null default false
);
create table public.rsvps (
  event_id uuid not null references public.events(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  name text not null check (length(trim(name)) between 1 and 100),
  reminders boolean not null default false,
  created_at timestamptz not null default now(),
  primary key(event_id, user_id),
  unique(event_id, email)
);
create table public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  active boolean not null default false,
  consent_at timestamptz,
  unsubscribe_token text not null unique default (gen_random_uuid()::text || gen_random_uuid()::text)
);
create table public.mail_jobs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('invitation','rsvp-reminder','attendee-reminder','cancellation')),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','skipped')),
  created_at timestamptz not null default now(),
  first_attempt_at timestamptz,
  lease_until timestamptz,
  attempts integer not null default 0,
  sent_at timestamptz,
  last_error text,
  unique(event_id, user_id, kind)
);
create index on public.suggestions(user_id, created_at);
create index on public.mail_jobs(status, lease_until);

-- Defense in depth: no direct table access even if API grants change later.
do $$ declare t text; begin
  foreach t in array array['hosts','movies','rounds','settings','votes','suggestions','events','rsvps','subscriptions','mail_jobs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

create function private.require_host() returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.hosts h join auth.users u on u.id=h.user_id
    where h.user_id=auth.uid() and u.email_confirmed_at is not null and not u.is_anonymous) then
    raise exception 'Host access required';
  end if;
end $$;
create function private.verified_email() returns text language plpgsql security definer set search_path = '' as $$
declare result text;
begin
  select lower(email) into result from auth.users where id=auth.uid() and email_confirmed_at is not null and not is_anonymous;
  if result is null then raise exception 'Verify your email first'; end if;
  return result;
end $$;

create function public.cinema_state() returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'movies', coalesce((select jsonb_agg(to_jsonb(m) order by m.title) from public.movies m where active), '[]'::jsonb),
    'round', (select to_jsonb(r) from public.rounds r join public.settings s on s.round_id=r.id),
    'counts', coalesce((select jsonb_object_agg(movie_id,n) from (select movie_id,count(*) n from public.votes v join public.settings s on s.round_id=v.round_id group by movie_id) c), '{}'::jsonb),
    'mine', coalesce((select jsonb_agg(movie_id) from public.votes v join public.settings s on s.round_id=v.round_id where user_id=auth.uid()), '[]'::jsonb),
    'event', (select to_jsonb(e) || jsonb_build_object('seats_taken',(select count(*) from public.rsvps where event_id=e.id)) from public.events e where starts_at>now() and not cancelled order by starts_at limit 1)
  );
$$;

create function public.set_vote(p_round uuid, p_movie text, p_voted boolean) returns void language plpgsql security definer set search_path = '' as $$
declare r public.rounds;
begin
  if auth.uid() is null then raise exception 'Anonymous session required'; end if;
  -- Settings and round locks serialize voting with host rollover/cutoff.
  perform 1 from public.settings where round_id=p_round for share;
  if not found then raise exception 'Voting round changed. Refresh and try again.'; end if;
  select * into r from public.rounds where id=p_round for share;
  if now() < r.opens_at or now() >= r.closes_at then raise exception 'Voting is closed'; end if;
  if p_voted is null or not exists(select 1 from public.movies where id=p_movie and active) then raise exception 'Invalid vote'; end if;
  if p_voted then
    insert into public.votes values (p_round,p_movie,auth.uid()) on conflict do nothing;
  else
    delete from public.votes where round_id=p_round and movie_id=p_movie and user_id=auth.uid();
  end if;
end $$;

create function public.suggest_movie(p_title text, p_name text) returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Anonymous session required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
  if (select count(*) from public.suggestions where user_id=auth.uid() and created_at>now()-interval '1 day') >= 5 then
    raise exception 'Please limit suggestions to five per day';
  end if;
  insert into public.suggestions(user_id,title,name) values(auth.uid(),trim(p_title),trim(coalesce(p_name,'')));
end $$;

create function public.member_state() returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.verified_email();
  return jsonb_build_object('host',exists(select 1 from public.hosts where user_id=auth.uid()),
    'subscribed',coalesce((select active from public.subscriptions where user_id=auth.uid()),false),
    'rsvps',coalesce((select jsonb_agg(event_id) from public.rsvps where user_id=auth.uid()),'[]'::jsonb),
    'bookings',coalesce((select jsonb_agg(jsonb_build_object('event_id',event_id,'name',name,'reminders',reminders)) from public.rsvps where user_id=auth.uid()),'[]'::jsonb));
end $$;

create function public.set_subscription(p_active boolean) returns void language plpgsql security definer set search_path = '' as $$
declare address text := private.verified_email();
begin
  insert into public.subscriptions(user_id,email,active,consent_at) values(auth.uid(),address,p_active,case when p_active then now() end)
  on conflict(user_id) do update set email=excluded.email,active=excluded.active,consent_at=case when p_active then now() else public.subscriptions.consent_at end;
end $$;

create function public.set_rsvp(p_event uuid, p_name text, p_attending boolean, p_reminders boolean default false) returns void language plpgsql security definer set search_path = '' as $$
declare address text := private.verified_email(); e public.events;
begin
  select * into e from public.events where id=p_event for update;
  if not found or e.cancelled or e.starts_at<=now() then raise exception 'This screening is no longer open'; end if;
  if p_attending is null then raise exception 'Choose an RSVP status'; end if;
  if not p_attending then delete from public.rsvps where event_id=p_event and user_id=auth.uid(); return; end if;
  if not exists(select 1 from public.rsvps where event_id=p_event and user_id=auth.uid())
     and (select count(*) from public.rsvps where event_id=p_event)>=e.capacity then raise exception 'Sorry, this screening is full'; end if;
  insert into public.subscriptions(user_id,email) values(auth.uid(),address) on conflict(user_id) do nothing;
  insert into public.rsvps(event_id,user_id,email,name,reminders) values(p_event,auth.uid(),address,trim(p_name),p_reminders)
  on conflict(event_id,user_id) do update set email=excluded.email,name=excluded.name,reminders=excluded.reminders;
end $$;

create function public.host_data() returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_host();
  return jsonb_build_object(
    'suggestions',coalesce((select jsonb_agg(to_jsonb(s) - 'user_id' order by created_at) from public.suggestions s where not reviewed),'[]'::jsonb),
    'rsvps',coalesce((select jsonb_agg(to_jsonb(r)-'user_id') from public.rsvps r join public.events e on e.id=r.event_id where e.starts_at>now() and not e.cancelled),'[]'::jsonb),
    'subscribers',(select count(*) from public.subscriptions where active),
    'mail',coalesce((select jsonb_agg(to_jsonb(j)) from (select kind,status,count(*) from public.mail_jobs group by kind,status) j),'[]'::jsonb));
end $$;

create function public.publish_event(p_movie text, p_local_time timestamp, p_timezone text, p_location text, p_capacity integer) returns uuid language plpgsql security definer set search_path = '' as $$
declare start_time timestamptz; result uuid;
begin
  perform private.require_host();
  perform 1 from public.settings for update;
  if not exists(select 1 from pg_timezone_names where name=p_timezone) then raise exception 'Unknown timezone'; end if;
  start_time := p_local_time at time zone p_timezone;
  if start_time is null or start_time<=now() then raise exception 'Choose a future time'; end if;
  if exists(select 1 from public.events where starts_at>now() and not cancelled) then raise exception 'Cancel the current screening before replacing it'; end if;
  if not exists(select 1 from public.movies where id=p_movie and active) then raise exception 'Choose an active film'; end if;
  insert into public.events(movie_id,starts_at,timezone,location,capacity) values(p_movie,start_time,p_timezone,trim(p_location),p_capacity) returning id into result;
  update public.rounds set closes_at=least(closes_at,now()) where id=(select round_id from public.settings);
  return result;
end $$;

create function public.cancel_event(p_event uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_host();
  update public.events set cancelled=true where id=p_event and starts_at>now();
end $$;

create function public.open_round(p_closes_at timestamptz) returns void language plpgsql security definer set search_path = '' as $$
declare result uuid;
begin
  perform private.require_host();
  perform 1 from public.settings for update;
  if p_closes_at is null or p_closes_at<=now() then raise exception 'Choose a future voting cutoff'; end if;
  update public.rounds set closes_at=least(closes_at,now()) where id=(select round_id from public.settings);
  insert into public.rounds(closes_at) values(p_closes_at) returning id into result;
  update public.settings set round_id=result;
end $$;

create function public.review_suggestion(p_id uuid, p_movie jsonb default null) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_host();
  perform 1 from public.suggestions where id=p_id and not reviewed for update;
  if not found then raise exception 'Suggestion already reviewed'; end if;
  if p_movie is not null then
    insert into public.movies(id,title,year,genres,description,poster,imdb)
    values(gen_random_uuid()::text,p_movie->>'title',(p_movie->>'year')::integer,
      array(select jsonb_array_elements_text(p_movie->'genres')),p_movie->>'description',p_movie->>'poster',
      case when p_movie->>'imdb_id' ~ '^tt[0-9]+$' then jsonb_build_object('url','https://www.imdb.com/title/'||(p_movie->>'imdb_id')||'/') end);
  end if;
  update public.suggestions set reviewed=true where id=p_id;
end $$;

-- Explicit allowlist of callable browser functions; private helpers stay private.
revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.cinema_state() from public;
grant execute on function public.cinema_state() to anon, authenticated;
do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on p.pronamespace=n.oid
    where n.nspname='public' and p.proname in ('set_vote','suggest_movie','member_state','set_subscription','set_rsvp','host_data','publish_event','cancel_event','open_round','review_suggestion') loop
    execute format('revoke all on function %s from public, anon',f.signature);
    execute format('grant execute on function %s to authenticated',f.signature);
  end loop;
end $$;
