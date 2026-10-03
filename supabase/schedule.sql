-- Run AFTER deploying functions and creating these secrets in Supabase Vault:
-- cinema_function_url = https://PROJECT.supabase.co/functions/v1
-- cinema_cron_secret = the same random value as the CRON_SECRET function secret
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$ declare j record; begin
  for j in select jobid from cron.job where jobname in ('cinema-mail','cinema-posters') loop
    perform cron.unschedule(j.jobid);
  end loop;
end $$;
select cron.schedule('cinema-mail','*/10 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='cinema_function_url') || '/mailer',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='cinema_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 180000
  );
$job$);
select cron.schedule('cinema-posters','0 8 * * 0', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='cinema_function_url') || '/refresh-posters',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='cinema_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 180000
  );
$job$);
