# The Living Room Cinema

A movie-night website with a shared watchlist, anonymous voting, private host controls,
verified-email RSVPs, movie suggestions, and scheduled invitations and reminders.
The interface runs on GitHub Pages; Supabase provides the database, authentication,
and scheduled functions; Resend delivers email. TMDB supplies remote posters.

**Status:** implemented locally, not deployed or connected to production services.
Provider accounts, DNS records, secrets, and a live acceptance test are required below.
Without configuration, the site displays a read-only preview and disables submissions.
The old browser-only prototype data is not imported.

## Local development

Requires Node.js 22 or newer.

```sh
npm ci
npm test
npm run build
npm run preview
```

Open http://127.0.0.1:4173. To connect a development Supabase project, copy
`.env.example` to `.env`, fill in the three public values, and build with:

```sh
node --env-file=.env scripts/build.mjs
```

For browser tests, build an **unconfigured** preview with `npm run build`, then run
`npm run test:browser`. Windows uses installed Microsoft Edge. On Linux/macOS first
run `npx playwright install chromium`. Tests mock external network services; they do
not send email or use production data.

## How it works

- **Voting:** guests receive a persistent anonymous Supabase session after a Turnstile
  check. A database primary key enforces one vote per film, per anonymous identity,
  per round. Setting a vote is idempotent; guests may support multiple films and undo
  their votes. There is no application IP tracking. People sharing Wi-Fi can each vote.
  Clearing browser data, switching devices, or incognito browsing can bypass the limit.
  This is deliberate lightweight duplicate prevention, not one-person-one-vote identity
  verification. Supabase rate-limits anonymous account creation by IP; retain that limit.
- **Rounds:** votes close at the deadline or when a host publishes a screening. Hosts
  select the winner and break ties. Opening a new round starts fresh counts while
  preserving earlier ballots. Nothing automatically chooses a film or invents a date.
- **RSVPs:** a one-time email code verifies the address. Each address books one seat.
  Database row locking serializes seat allocation; updates don't consume another seat.
  Guests can release their seat. Capacity defaults to 12 in the host form; there is no waitlist.
- **Hosts:** email verification plus a host role granted directly in the database.
  Public visitors cannot read contact lists, edit events, or grant themselves host status.
- **Events:** the host enters a date/time and IANA timezone (default America/New_York).
  PostgreSQL stores the resulting UTC instant. Published events are immutable; cancel
  and replace to change one, so old invitations and RSVPs never silently move.
  The location is public. Share a street address privately if you prefer.
- **Email:** subscribers explicitly opt in after verifying their address. Every ten
  minutes, the scheduler checks for a published future screening. It queues one
  invitation within seven days, one RSVP reminder within 24 hours for subscribers
  without a seat (at least 12 hours after their invitation), and one optional attendee
  reminder within 24 hours for booked guests who requested it. It sends no invitation
  if no screening is selected. Cancellation notices go to booked guests and subscribed
  recipients of the original invitation. Unsubscribing stops invitations and reminders,
  but does not release seats or suppress essential cancellation notices for bookings.
- **Delivery:** unique job keys, five-minute leases, and Resend idempotency keys prevent
  duplicate deliveries during retries. The queue stops uncertain retries after 20 hours,
  before Resend's 24-hour idempotency window ends. Review failed jobs against Resend
  before any manual resend. A `sent` job means provider acceptance, not inbox delivery.
- **Posters:** weekly TMDB lookups use each film's IMDb ID. The database stores remote
  CDN URLs; browsers fetch images directly, with existing local posters as fallbacks.
  An approved suggestion with an IMDb ID picks up its poster on the next refresh.
  Ratings remain explicitly dated snapshots, not live IMDb/Rotten Tomatoes scores.

## Production setup

### 1. Supabase database and authentication

Create a Supabase project, then apply these files in order using its SQL editor:

1. `supabase/migrations/202610020001_cinema.sql`
2. `supabase/migrations/202610020002_mail.sql`
3. `supabase/seed.sql`

Alternatively, link the Supabase CLI to the project and use its migration/seed workflow.
Migrations create new tables and should be applied only once. The seed only inserts
missing movies; rerunning it does not overwrite refreshed posters or host changes.

In Authentication settings:

- Enable email sign-in, email confirmation, new signups, and anonymous sign-ins.
- Configure custom SMTP through Resend (see step 2); the built-in test sender is not
  suitable for inviting friends.
- In **both Confirm signup and Magic link** email templates, display `{{ .Token }}`
  as a one-time code. The website uses code entry, not callback links. For example:

  ```html
  <h2>Your Living Room Cinema code</h2>
  <p>Enter this code on the website: <strong>{{ .Token }}</strong></p>
  <p>If you did not request it, ignore this email.</p>
  ```

- Set Site URL to `https://movies.wiederhold.dev/` (or the GitHub project URL while
  staging). Keep email-code expiry short and retain authentication rate limits.
- In Cloudflare Turnstile, create a managed widget for `movies.wiederhold.dev` and,
  while staging, `shamayla38.github.io`. Add localhost only to a development widget.
  In Supabase Auth's CAPTCHA settings, choose Turnstile and enter its **secret** key.
  The site's build uses the corresponding public **site key**.

After each host has signed in through **My email**, grant their role in the SQL editor:

```sql
insert into public.hosts(user_id)
select id from auth.users
where lower(email) = lower('REPLACE_WITH_HOST_EMAIL')
  and email_confirmed_at is not null and not is_anonymous
on conflict do nothing;
```

Run this for both hosts. A sender address is unrelated to a host's login address.
Granting host status via user-editable metadata is intentionally unsupported.

### 2. Sender address and Resend

Recommended sender: **The Living Room Cinema <cinema@wiederhold.dev>**. A new inbox
is not needed just to send through Resend. For replies, configure Cloudflare Email
Routing for `cinema@wiederhold.dev` to either host's existing inbox, or use a separate
`EMAIL_REPLY_TO`. Forwarding alone does not let you send manual replies *from* that
alias; use a mailbox provider if you want a shared inbox with send-and-reply support.

Create a Resend account and verify a domain you control. Add exactly the DNS records
Resend supplies in Cloudflare, including DKIM and its sending/return-path SPF records.
Do not replace unrelated MX records for an existing mailbox. If you choose a sending
subdomain instead, update `EMAIL_FROM` to use that verified subdomain.

Use Resend's SMTP settings in Supabase Auth: host `smtp.resend.com`, port `465`,
username `resend`, password your Resend API key, and the verified sender address.
Adjust the Supabase SMTP sending rate to suit the small guest list and your provider limits.

### 3. Edge Functions and secrets

Using the Supabase CLI from this directory:

```sh
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase functions deploy mailer
npx supabase functions deploy unsubscribe
npx supabase functions deploy refresh-posters
```

`supabase/config.toml` disables gateway JWT verification for these functions:
`mailer` and `refresh-posters` check a separate cron bearer secret themselves;
`unsubscribe` accepts only an unguessable per-subscriber token. Browser database
requests use Supabase authentication and explicitly restricted RPCs.

Set these **server secrets** in the Supabase Functions dashboard:

| Secret | Value |
| --- | --- |
| `RESEND_API_KEY` | Sending key from Resend |
| `EMAIL_FROM` | `The Living Room Cinema <cinema@wiederhold.dev>` or your chosen verified sender |
| `EMAIL_REPLY_TO` | Optional receiving address/forwarding alias |
| `SITE_URL` | `https://movies.wiederhold.dev/` including trailing slash; use the complete project path if staging |
| `CRON_SECRET` | Random high-entropy secret, e.g. 32 random bytes encoded as hex |
| `TMDB_TOKEN` | TMDB API Read Access Token from your TMDB account |

Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to deployed functions.
Never put server secrets, the service-role key, or a Supabase `sb_secret_` key in
GitHub Pages, source control, or browser configuration.

In **Supabase Vault**, create `cinema_function_url` with
`https://YOUR_PROJECT.supabase.co/functions/v1`, and `cinema_cron_secret` with the
same value as `CRON_SECRET`. Then run `supabase/schedule.sql` in the SQL editor.
It installs the ten-minute email schedule and Sunday 08:00 UTC poster refresh.
Run `refresh-posters` once using the Functions dashboard with the cron Authorization
header to populate remote images immediately. Do not invoke `mailer` with real
subscribers until you are ready to send invitations.

#### Testing and troubleshooting poster refresh

In PowerShell, use `curl.exe` with a plain URL (not Markdown link syntax).
This single-line command assumes the actual cron secret is already in your shell's
`CRON_SECRET` environment variable; the braces used for placeholders are not part
of the secret:

```powershell
curl.exe -i -X POST "https://YOUR_PROJECT.supabase.co/functions/v1/refresh-posters" -H "Authorization: Bearer $env:CRON_SECRET" -H "Content-Type: application/json"
```

A local `.env` file is not automatically loaded by PowerShell or uploaded to
Supabase. Set `TMDB_TOKEN` and `CRON_SECRET` in **Edge Functions > Secrets** for the
same project where you deployed. TMDB_TOKEN must be the **API Read Access Token**,
not the shorter API key. Vault's `cinema_cron_secret` is a separate copy used by the
scheduler; creating it does not set the function's `CRON_SECRET` environment variable.

- **401 Unauthorized:** the bearer value does not match the function's cron secret.
- **503 with `BOOT_ERROR`:** inspect the function's Logs for `worker boot error`;
  the runtime failed before the request handler ran.
- **503 with `stage: configuration` and `setting`:** add the named missing function
  secret. Supabase normally supplies its URL and service-role key automatically.
- **503 with `stage: catalog_read`:** check migrations and table permissions in this
  project. `PGRST205`/`42P01` indicate a missing table/schema cache entry; `42501`
  indicates insufficient database permissions.
- **502 with `failed` greater than zero:** the catalog loaded, but a TMDB request or
  poster update failed. Check the TMDB token and function/provider availability.
- **200 with zero updates:** check that `supabase/seed.sql` was applied and active
  movies have IMDb IDs and matching TMDB posters.

Older deployments return only `Poster refresh unavailable` for application 503s.
Redeploy `refresh-posters` from this repository to get structured diagnostics.

### 4. GitHub Pages and Cloudflare

In the repository's Actions variables, add these **public** settings:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY` (publishable key or legacy `anon` key)
- `TURNSTILE_SITE_KEY`

The build fails on missing deployment settings or a recognizable privileged key.
Only `dist` is uploaded. In **Settings > Pages**, select **GitHub Actions**. Push this
implementation and run **Deploy website to GitHub Pages** manually from Actions.
The default URL is `https://shamayla38.github.io/living-room-cinema/`.

Verify `wiederhold.dev` ownership in the GitHub owner's Pages settings using the TXT
record GitHub supplies. Set `movies.wiederhold.dev` as the repository's custom domain.
In Cloudflare DNS create:

| Type | Name | Target | Proxy |
| --- | --- | --- | --- |
| CNAME | movies | shamayla38.github.io | DNS only (gray cloud) |

Remove only conflicting records for the `movies` subdomain. Wait for GitHub's DNS
check/certificate, then enable **Enforce HTTPS**. A `CNAME` file is unnecessary for
this Actions deployment. Set the final `SITE_URL`, Supabase Site URL, and Turnstile
allowed hostname consistently. No Cloudflare proxy is needed for this setup.

### 5. Before sharing with friends

Use a staging project or only host-owned test email addresses for the first live run:

1. Vote repeatedly in one browser, reload, and confirm one vote. Use a second browser
   to confirm shared counts and an independent ballot. Check the voting deadline.
2. Verify an email code, grant a host role, and confirm a different verified guest
   cannot open host controls or query contact tables directly.
3. Publish a screening with the correct timezone and capacity. Book/update/cancel
   seats, including two browsers racing for the last seat.
4. Subscribe a test address. Invoke the mailer, verify delivery and the RSVP link,
   then invoke again and confirm no duplicate. Test reminders with a screening
   within 24 hours. Inspect Resend delivery/bounce status as well as Supabase jobs.
5. Open an unsubscribe link: GET must only show the confirmation. Confirm it, verify
   reminders stop, and verify an existing seat remains booked. Test event cancellation.
6. Confirm TMDB posters load, local fallback works, and mobile layout is usable.

Review `mail_jobs` failures and Supabase function/cron logs periodically. Back up the
database and monitor the current provider quotas. Free-tier project availability is
not a guaranteed always-on service; pick a plan appropriate for unattended reminders.
The host UI reports mail status counts but does not automatically reconcile bounces.
For deletion requests, remove the user through Supabase Auth administration; application
rows cascade. Anonymous browser IDs and verified-email IDs are separate, so ask for
the anonymous ID too if a guest wants their ballots removed. No automatic retention job
is configured. Don't prune anonymous users with active ballots or their votes disappear.

## Files and validation

- `dist/`: static UI, catalog fallback, styles, images, credits, privacy/unsubscribe pages
- `scripts/build.mjs`: browser bundle and public configuration generation
- `supabase/migrations/`: database constraints, authorization, RPCs, durable mail queue
- `supabase/functions/`: Resend sender, unsubscribe endpoint, TMDB refresh
- `supabase/schedule.sql`: cron setup using Vault secrets
- `tests/`: actual PostgreSQL migration/RPC tests via PGlite, helpers, mocked browser flows
- `.github/workflows/`: checks and manual deployment

Automated tests exercise SQL permissions, duplicate ballots, round cutoff, suggestions,
capacity/update/cancellation, email eligibility, leases, unsubscribe, and browser flows.
PGlite tests stub Supabase's `auth.users`/`auth.uid`; browser tests mock Supabase and
Turnstile. They do not replace the live SMTP, DNS, concurrent-client, and Edge Function
acceptance checks above. No production resources or real email delivery have been tested.

The bundled catalog retains The Drama (2026), The Fall (2006), The Stepford Wives
(1975), Something Wild (1986), Charade (1963), and The Player (1992). See poster credits
for source attribution. Artwork remains the property of its respective owners.

## Provider references

- [GitHub Pages custom domains](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
- [Supabase anonymous sessions](https://supabase.com/docs/guides/auth/auth-anonymous), [email codes](https://supabase.com/docs/guides/auth/auth-email-passwordless), [CAPTCHA](https://supabase.com/docs/guides/auth/auth-captcha), [scheduling](https://supabase.com/docs/guides/functions/schedule-functions)
- [Resend domain setup](https://resend.com/docs/dashboard/domains/introduction), [SMTP](https://resend.com/docs/send-with-smtp), [idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys)
- [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/)
- [TMDB image URLs](https://developer.themoviedb.org/docs/image-basics), [IMDb-ID matching](https://developer.themoviedb.org/docs/finding-data), [attribution](https://developer.themoviedb.org/docs/faq)
