create function public.queue_mail() returns void language plpgsql security definer set search_path = '' as $$
begin
  -- Payloads are immutable so provider retries always use the same message.
  insert into public.mail_jobs(event_id,user_id,kind,payload)
  select e.id,s.user_id,k.kind,jsonb_build_object('email',s.email,'title',m.title,
    'starts_at',e.starts_at,'timezone',e.timezone,'location',e.location,'token',s.unsubscribe_token)
  from public.events e join public.movies m on m.id=e.movie_id
  cross join public.subscriptions s
  cross join (values ('invitation'),('rsvp-reminder'),('attendee-reminder'),('cancellation')) k(kind)
  where e.starts_at>now() and (
    (k.kind='invitation' and not e.cancelled and s.active and e.starts_at<=now()+interval '7 days')
    or (k.kind='rsvp-reminder' and not e.cancelled and s.active and e.starts_at<=now()+interval '24 hours'
      and not exists(select 1 from public.rsvps where event_id=e.id and user_id=s.user_id)
      and exists(select 1 from public.mail_jobs j where j.event_id=e.id and j.user_id=s.user_id and j.kind='invitation' and j.sent_at<now()-interval '12 hours'))
    or (k.kind='attendee-reminder' and not e.cancelled and e.starts_at<=now()+interval '24 hours'
      and exists(select 1 from public.rsvps where event_id=e.id and user_id=s.user_id and reminders))
    or (k.kind='cancellation' and e.cancelled
      and (exists(select 1 from public.rsvps where event_id=e.id and user_id=s.user_id)
        or exists(select 1 from public.mail_jobs j where j.event_id=e.id and j.user_id=s.user_id and j.kind='invitation' and j.status='sent' and s.active)))
  ) on conflict(event_id,user_id,kind) do nothing;
end $$;

create function public.mail_is_eligible(p_id uuid) returns boolean language sql security definer set search_path = '' as $$
  select coalesce((select e.starts_at>now() and case
    when j.kind='cancellation' then e.cancelled and (s.active or exists(select 1 from public.rsvps where event_id=e.id and user_id=s.user_id))
    when e.cancelled then false
    when j.kind='attendee-reminder' then exists(select 1 from public.rsvps where event_id=e.id and user_id=s.user_id and reminders)
    when j.kind='rsvp-reminder' then s.active and not exists(select 1 from public.rsvps where event_id=e.id and user_id=s.user_id)
    else s.active end
  from public.mail_jobs j join public.events e on e.id=j.event_id join public.subscriptions s on s.user_id=j.user_id where j.id=p_id),false);
$$;

create function public.claim_mail() returns setof public.mail_jobs language plpgsql security definer set search_path = '' as $$
begin
  -- Resend remembers idempotency keys for 24h. Stop uncertain retries before that
  -- window ends; require a human to reconcile failed deliveries, never blind resend.
  update public.mail_jobs set status='failed',last_error='Retry window expired; reconcile with Resend before retrying'
    where status in ('pending','sending') and first_attempt_at<now()-interval '20 hours';
  return query
    with picked as (select id from public.mail_jobs
      where status='pending' or (status='sending' and lease_until<now())
      order by created_at for update skip locked limit 10)
    update public.mail_jobs j set status='sending',lease_until=now()+interval '5 minutes',
      attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,now())
    from picked where j.id=picked.id returning j.*;
end $$;

create function public.unsubscribe_email(p_token text) returns boolean language plpgsql security definer set search_path = '' as $$
declare who uuid;
begin
  select user_id into who from public.subscriptions where unsubscribe_token=p_token;
  if who is null then return false; end if;
  update public.subscriptions set active=false where user_id=who;
  update public.rsvps set reminders=false where user_id=who;
  return true;
end $$;

revoke all on function public.queue_mail(),public.mail_is_eligible(uuid),public.claim_mail(),public.unsubscribe_email(text) from public,anon,authenticated;
grant execute on function public.queue_mail(),public.mail_is_eligible(uuid),public.claim_mail(),public.unsubscribe_email(text) to service_role;
grant select,update on public.movies to service_role;
grant select,update on public.mail_jobs to service_role;
