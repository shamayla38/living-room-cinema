import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('PostgreSQL authorization, voting, booking, and delivery lifecycle', async t => {
  const db = new PGlite();
  const ids = {
    host: '00000000-0000-4000-8000-000000000001',
    guest: '00000000-0000-4000-8000-000000000002',
    alice: '00000000-0000-4000-8000-000000000003',
    bob: '00000000-0000-4000-8000-000000000004',
  };
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean not null default false);
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to anon,authenticated,service_role;
    insert into auth.users values
      ('${ids.host}','host@example.test',now(),false),('${ids.guest}',null,null,true),
      ('${ids.alice}','alice@example.test',now(),false),('${ids.bob}','bob@example.test',now(),false);
  `);
  for (const file of ['202610020001_cinema.sql','202610020002_mail.sql']) {
    await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'));
  }
  await db.exec(await readFile('supabase/seed.sql', 'utf8'));
  await db.query('insert into public.hosts values ($1)', [ids.host]);
  async function as(user, sql, params = [], role = 'authenticated') {
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [ids[user] || '']);
    await db.exec(`set role ${role}`);
    try { return (await db.query(sql,params)).rows; } finally { await db.exec('reset role'); }
  }
  const rpc = async (user, name, args = [], role) => {
    const rows = await as(user, `select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as value`, args, role);
    return rows[0]?.value;
  };
  let round, event;
  await t.test('public state exposes catalog and counts, never guest data', async () => {
    const state = await rpc(null,'cinema_state',[],'anon');
    assert.equal(state.movies.length,32);
    assert.deepEqual(state.mine,[]);
    assert.equal(state.event,null);
    round=state.round.id;
    for (const table of ['votes','hosts','rsvps','subscriptions','mail_jobs','suggestions']) {
      await assert.rejects(as('guest',`select * from public.${table}`), /permission denied/);
    }
    await assert.rejects(as('guest',"insert into public.hosts values (auth.uid())"),/permission denied/);
    await assert.rejects(rpc('guest','host_data'),/Host access required/);
    await assert.rejects(rpc('alice','open_round',[new Date(Date.now()+86400000).toISOString()]),/Host access required/);
  });
  await t.test('repeated submissions cannot increase the same ballot', async () => {
    await rpc('guest','set_vote',[round,'1',true]);
    await rpc('guest','set_vote',[round,'1',true]);
    await rpc('guest','set_vote',[round,'2',true]);
    let state=await rpc('guest','cinema_state');
    assert.equal(state.counts['1'],1);
    assert.equal(state.mine.length,2);
    await rpc('alice','set_vote',[round,'1',true]);
    state=await rpc('alice','cinema_state');
    assert.equal(state.counts['1'],2);
    assert.deepEqual(state.mine,['1']);
    await rpc('guest','set_vote',[round,'1',false]);
    await rpc('guest','set_vote',[round,'1',false]);
    assert.equal((await rpc('guest','cinema_state')).counts['1'],1);
    await assert.rejects(rpc('guest','set_vote',[round,'missing',true]),/Invalid vote/);
    await assert.rejects(rpc(null,'set_vote',[round,'1',true],'anon'),/permission denied/);
    await assert.rejects(as('guest',"insert into public.votes values ($1,'1',$2)",[round,ids.bob]),/permission denied/);
  });
  await t.test('suggestions are bounded and host review is protected', async () => {
    for(let i=0;i<5;i++) await rpc('guest','suggest_movie',[`Film ${i}`,'Guest']);
    await assert.rejects(rpc('guest','suggest_movie',['Too many','Guest']),/five per day/);
    const host=await rpc('host','host_data');
    assert.equal(host.suggestions.length,5);
    await assert.rejects(rpc('guest','review_suggestion',[host.suggestions[0].id,null]),/Host access required/);
    await rpc('host','review_suggestion',[host.suggestions[0].id,null]);
    await assert.rejects(rpc('host','review_suggestion',[host.suggestions[0].id,null]),/already reviewed/);
  });
  await t.test('publication converts event timezone, closes ballots, and rejects duplicate events', async () => {
    await assert.rejects(rpc('guest','publish_event',['1','2099-06-01T20:00:00','America/New_York','Sofa',1]),/Host access required/);
    event=await rpc('host','publish_event',['1','2099-06-01T20:00:00','America/New_York','Sofa',1]);
    const state=await rpc('guest','cinema_state');
    assert.equal(new Date(state.event.starts_at).toISOString(),'2099-06-02T00:00:00.000Z');
    await assert.rejects(rpc('guest','set_vote',[round,'1',true]),/Voting is closed/);
    await assert.rejects(rpc('host','publish_event',['2','2099-06-02T20:00:00','America/New_York','Sofa',1]),/Cancel the current/);
    await rpc('host','open_round',[new Date(Date.now()+86400000).toISOString()]);
    assert.deepEqual((await rpc('guest','cinema_state')).counts,{});
    await assert.rejects(rpc('guest','set_vote',[round,'1',true]),/round changed/);
  });
  await t.test('verified RSVP is idempotent, capacity bounded, and cancellable', async () => {
    await assert.rejects(rpc('guest','set_rsvp',[event,'Guest',true,true]),/Verify your email/);
    await assert.rejects(rpc('guest','set_subscription',[true]),/Verify your email/);
    await rpc('alice','set_rsvp',[event,'Alice',true,true]);
    await rpc('alice','set_rsvp',[event,'Alice Updated',true,true]);
    assert.equal((await rpc('guest','cinema_state')).event.seats_taken,1);
    await assert.rejects(rpc('bob','set_rsvp',[event,'Bob',true,true]),/screening is full/);
    await rpc('alice','set_rsvp',[event,'',false]);
    await rpc('bob','set_rsvp',[event,'Bob',true,true]);
    assert.deepEqual((await rpc('bob','member_state')).rsvps,[event]);
    const host=await rpc('host','host_data');
    assert.equal(host.rsvps[0].email,'bob@example.test');
    assert.equal(host.rsvps.length,1);
  });
  await t.test('scheduler is private, deduplicated, and lease protected', async () => {
    await db.query("update public.events set starts_at=now()+interval '20 hours' where id=$1",[event]);
    await rpc('alice','set_subscription',[true]);
    await rpc('bob','set_subscription',[true]);
    await assert.rejects(rpc('guest','queue_mail'),/permission denied/);
    await rpc(null,'queue_mail',[],'service_role');
    await rpc(null,'queue_mail',[],'service_role');
    let jobs=(await db.query('select * from public.mail_jobs')).rows;
    assert.equal(jobs.filter(j=>j.kind==='invitation').length,2);
    assert.equal(jobs.filter(j=>j.kind==='attendee-reminder').length,1);
    assert.equal(jobs.filter(j=>j.kind==='rsvp-reminder').length,0);
    let claimed=await as(null,'select * from public.claim_mail()',[],'service_role');
    assert.equal(claimed.length,3);
    assert.equal((await as(null,'select * from public.claim_mail()',[],'service_role')).length,0);
    await db.exec("update public.mail_jobs set status='sent',sent_at=now()-interval '13 hours' where kind='invitation'");
    await rpc(null,'queue_mail',[],'service_role');
    jobs=(await db.query('select * from public.mail_jobs')).rows;
    assert.equal(jobs.filter(j=>j.kind==='rsvp-reminder').length,1);
    assert.equal(jobs.find(j=>j.kind==='rsvp-reminder').user_id,ids.alice);
    const reminder=jobs.find(j=>j.kind==='rsvp-reminder');
    await rpc('alice','set_subscription',[false]);
    assert.equal(await rpc(null,'mail_is_eligible',[reminder.id],'service_role'),false);
    await db.exec("update public.mail_jobs set status='sending',first_attempt_at=now()-interval '21 hours',lease_until=now()-interval '1 minute' where kind='attendee-reminder'");
    await rpc(null,'claim_mail',[],'service_role');
    assert.equal((await db.query("select status from public.mail_jobs where kind='attendee-reminder'")).rows[0].status,'failed');
  });
  await t.test('unsubscribe stops reminders, while cancellation still notifies booked guests', async () => {
    const { unsubscribe_token: token }=(await db.query('select unsubscribe_token from public.subscriptions where user_id=$1',[ids.bob])).rows[0];
    await assert.rejects(rpc('guest','unsubscribe_email',[token]),/permission denied/);
    assert.equal(await rpc(null,'unsubscribe_email',[token],'service_role'),true);
    assert.equal((await rpc('bob','member_state')).subscribed,false);
    assert.equal((await db.query('select reminders from public.rsvps where user_id=$1',[ids.bob])).rows[0].reminders,false);
    await rpc('host','cancel_event',[event]);
    assert.equal((await rpc('guest','cinema_state')).event,null);
    await assert.rejects(rpc('bob','set_rsvp',[event,'Bob',true,true]),/no longer open/);
    await rpc(null,'queue_mail',[],'service_role');
    const cancellations=(await db.query("select * from public.mail_jobs where kind='cancellation'")).rows;
    assert.equal(cancellations.length,1);
    assert.equal(cancellations[0].user_id,ids.bob);
    assert.equal(await rpc(null,'mail_is_eligible',[cancellations[0].id],'service_role'),true);
  });
  await db.close();
});
