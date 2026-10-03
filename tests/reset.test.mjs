import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('manual reset replaces an incompatible schema and preserves Auth users',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean default false);
      create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
      insert into auth.users values(gen_random_uuid(),'host@example.test',now(),false);
      create table public.movies(id uuid primary key,title text,synopsis text,poster_url text,release_date date,duration_minutes integer,created_at timestamptz,updated_at timestamptz);
      insert into public.movies(id,title) values(gen_random_uuid(),'Old movie');
      create table public.old_votes(movie_id uuid references public.movies(id));
      create function public.cinema_state() returns text language sql as $$select 'wrong version'::text$$;
      create schema vault;
      create table vault.test_secret(value text);
      insert into vault.test_secret values('preserved');
    `);
    const reset=await readFile('supabase/reset-and-install.sql','utf8');
    for(let run=0;run<2;run++) {
      await db.exec(reset);
      assert.equal((await db.query('select count(*)::int n from public.movies')).rows[0].n,32);
      assert.equal((await db.query('select count(*)::int n from auth.users')).rows[0].n,1);
      assert.equal((await db.query('select value from vault.test_secret')).rows[0].value,'preserved');
      assert.equal((await db.query("select data_type from information_schema.columns where table_schema='public' and table_name='movies' and column_name='id'")).rows[0].data_type,'text');
      assert.equal((await db.query("select to_regclass('public.old_votes') as name")).rows[0].name,null);
      assert.equal((await db.query('select public.cinema_state() as state')).rows[0].state.movies.length,32);
    }
  } finally {await db.close();}
});
