import { admin, authorizedCron, rpc, secret } from '../_shared/server.ts';
import { composeMail } from '../_shared/mail.mjs';

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!authorizedCron(request)) return new Response('Unauthorized', { status: 401 });
  try {
    const db = admin();
    const apiKey = secret('RESEND_API_KEY');
    const from = secret('EMAIL_FROM');
    const site = secret('SITE_URL');
    const functions = `${secret('SUPABASE_URL')}/functions/v1`;
    await rpc(db, 'queue_mail');
    const jobs = await rpc(db, 'claim_mail');
    let sent = 0;
    for (const job of jobs) {
      if (!await rpc(db, 'mail_is_eligible', { p_id: job.id })) {
        const { error } = await db.from('mail_jobs').update({ status: 'skipped', lease_until: null }).eq('id', job.id);
        if (error) throw error;
        continue;
      }
      try {
        const message = composeMail(job, site, functions);
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `cinema/${job.id}` },
          body: JSON.stringify({ from, to: [job.payload.email], reply_to: Deno.env.get('EMAIL_REPLY_TO') || undefined, ...message }),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          // Permanent failures need operator attention. Avoid logging addresses or tokens.
          const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
          const { error } = await db.from('mail_jobs').update({
            status: permanent ? 'failed' : 'sending', last_error: `Resend HTTP ${response.status}`,
          }).eq('id', job.id);
          if (error) throw error;
        } else {
          const { error } = await db.from('mail_jobs').update({ status: 'sent', sent_at: new Date().toISOString(), lease_until: null, last_error: null }).eq('id', job.id);
          if (error) throw error;
          sent++;
        }
      } catch {
        // Leave the lease in place. A later run retries with the same idempotency key.
        console.error('Mail attempt did not complete', job.id);
      }
      // Resend's default account throughput is limited; keep a small sequential batch.
      await new Promise(resolve => setTimeout(resolve, 600));
    }
    return Response.json({ claimed: jobs.length, sent });
  } catch {
    console.error('Mailer failed; check configuration and database availability');
    return new Response('Mailer unavailable', { status: 503 });
  }
});
