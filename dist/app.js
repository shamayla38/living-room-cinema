import { createClient } from '@supabase/supabase-js';
import { escapeHTML as esc, safeImage, eventLabel, ratingText } from './ui.mjs';

const $ = selector => document.querySelector(selector);
const config = window.CINEMA_CONFIG || {};
const configured = !!(config.url && config.key && config.turnstile);
const client = key => createClient(config.url, config.key, {
  auth: { storageKey: key, detectSessionInUrl: false, persistSession: true, autoRefreshToken: true },
});
// Email sign-in must not replace the browser's anonymous ballot identity.
const voter = configured ? client('cinema-voter-v1') : null;
const member = configured ? client('cinema-member-v1') : null;
let state = { movies: window.MOVIES, counts: {}, mine: [], event: null, round: null };
let ready = false;
let toastTimer, captchaWidget, captchaLoader;
const dialog = $('#dialog');
const count = id => Number(state.counts[id] || 0);
const votingOpen = () => ready && state.round && new Date(state.round.closes_at) > new Date();
const field = (name, label, type = 'text', value = '', extra = '') =>
  `<label for="f-${name}">${esc(label)}</label><input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" required maxlength="200" ${extra}>`;

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').style.display = dialog.open ? 'none' : 'block';
  const feedback = $('#dialog-status');
  feedback.textContent = message;
  feedback.hidden = !dialog.open;
  if (dialog.open) feedback.scrollIntoView({ block: 'nearest' });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').style.display = 'none', 7000);
}
function action(fn) { return async (...args) => { try { await fn(...args); } catch (error) { toast(error.message || 'Something went wrong. Please try again.'); } }; }
async function rpc(db, name, args = {}) {
  if (!db) throw new Error('The cinema is not connected yet. Please come back soon.');
  const { data, error } = await db.rpc(name, args);
  if (error) throw error;
  return data;
}
function clearCaptcha() {
  if (captchaWidget !== undefined) window.turnstile?.remove(captchaWidget);
  captchaWidget = undefined;
}
function openDialog(html) {
  clearCaptcha();
  $('#dialog-status').hidden = true;
  $('#dialog-status').textContent = '';
  $('#dialog-content').innerHTML = html;
  if (!dialog.open) dialog.showModal();
}
$('.close').onclick = () => dialog.close();
dialog.addEventListener('close', clearCaptcha);
function form(selector, handler) {
  $(selector).onsubmit = action(async event => {
    event.preventDefault();
    const element = event.currentTarget;
    const button = element.querySelector('button[type="submit"],button:not([type])');
    if (button.disabled) return;
    button.disabled = true;
    try { await handler(new FormData(element)); } finally { button.disabled = false; }
  });
}
async function refresh() {
  if (!configured) return;
  state = await rpc(voter, 'cinema_state');
  ready = true;
  $('#connection-status').hidden = true;
  render();
}
function render() {
  $('#count').textContent = state.movies.length;
  $('#movies').innerHTML = state.movies.map(m => {
    const mine = state.mine.includes(m.id), votes = count(m.id);
    const imdb = /^https:\/\/www\.imdb\.com\/title\/tt\d+\/$/.test(m.imdb?.url || '') ? m.imdb.url : 'https://www.imdb.com/';
    const rt = m.rt?.url?.startsWith('https://www.rottentomatoes.com/') ? m.rt.url : 'https://www.rottentomatoes.com/';
    return `<article class="movie"><div class="poster"><img src="${esc(safeImage(m.poster))}" data-movie="${esc(m.id)}" alt="${esc(m.title)} movie poster" loading="lazy" width="300" height="450"><span class="year">${m.year}</span></div>
      <h3>${esc(m.title)}</h3><p class="genres">${m.genres.map(esc).join(' · ')}</p>
      <div class="ratings"><a href="${imdb}" target="_blank" rel="noopener noreferrer"><span class="imdb-label">IMDb</span> ${ratingText(m.imdb?.value, 'imdb')}</a><a href="${esc(rt)}" target="_blank" rel="noopener noreferrer">🍅 ${ratingText(m.rt?.value, 'rt')}</a></div>
      <p class="description">${esc(m.description)}</p><div class="vote-row"><button class="vote-button ${mine ? 'voted' : ''}" data-vote="${esc(m.id)}" aria-pressed="${mine}" aria-label="${mine ? 'Remove vote for' : 'Vote for'} ${esc(m.title)}" ${votingOpen() ? '' : 'disabled'}>${mine ? '✓ Voted' : '+ Vote'}</button><span class="vote-count">${votes} ${votes === 1 ? 'vote' : 'votes'}</span></div></article>`;
  }).join('');
  $('#movies').querySelectorAll('img').forEach(img => img.onerror = () => {
    const local = window.MOVIES.find(m => m.id === img.dataset.movie)?.poster;
    img.onerror = () => { img.onerror = null; img.src = 'assets/poster-placeholder.svg'; };
    img.src = local || 'assets/poster-placeholder.svg';
  });
  document.querySelectorAll('[data-vote]').forEach(button => button.onclick = action(async () => {
    button.disabled = true;
    try {
      const round = state.round.id, movie = button.dataset.vote;
      await ensureVoter();
      await rpc(voter, 'set_vote', { p_round: round, p_movie: movie, p_voted: !state.mine.includes(movie) });
      await refresh();
      document.querySelector(`[data-vote="${CSS.escape(movie)}"]`)?.focus();
      toast('Your vote is saved.');
    } finally { button.disabled = !votingOpen(); }
  }));
  const e = state.event;
  $('#screening-title').textContent = e ? state.movies.find(m => m.id === e.movie_id)?.title || 'Movie night' : 'The next pick is coming soon.';
  $('#screening-info').textContent = e ? `${eventLabel(e)} · ${Math.max(0, e.capacity-e.seats_taken)} of ${e.capacity} seats left` : '';
  $('#rsvp-open').disabled = !ready || !e;
  $('#rsvp-open').textContent = e ? 'RSVP / manage seat' : 'RSVP opens soon';
  $('#vote-status').textContent = !ready ? 'Voting will open when the cinema connects.' : votingOpen() ? `One vote per film, per browser. Voting closes ${new Date(state.round.closes_at).toLocaleString()}. Hosts choose the winner and break ties.` : 'Voting is closed. The hosts will open the next round.';
  $('#suggest-open').disabled = !ready;
  $('#subscribe-form button').disabled = !ready;
}
async function loadCaptcha() {
  if (window.turnstile) return;
  if (!captchaLoader) captchaLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.onload = resolve;
    script.onerror = () => { captchaLoader = undefined; script.remove(); reject(new Error('Could not load the security check. Please try again.')); };
    document.head.append(script);
  });
  await captchaLoader;
}
async function mountCaptcha(onToken) {
  await loadCaptcha();
  if (!$('#captcha')) return;
  captchaWidget = window.turnstile.render('#captcha', {
    sitekey: config.turnstile, theme: 'dark', callback: onToken,
    'expired-callback': () => onToken(''), 'error-callback': () => { onToken(''); toast('Security check failed. Please retry.'); },
  });
}
async function ensureVoter() {
  if (!configured) throw new Error('The cinema is not connected yet.');
  const { data: { session } } = await voter.auth.getSession();
  if (session) return;
  openDialog('<h2>A quick check</h2><p>No account or email needed to vote.</p><div id="captcha"></div>');
  await new Promise((resolve, reject) => {
    let submitted = false;
    const cancelled = () => reject(new Error('Voting check cancelled.'));
    dialog.addEventListener('close', cancelled, { once: true });
    mountCaptcha(async captchaToken => {
      if (!captchaToken || submitted) return;
      submitted = true;
      try {
        const { error } = await voter.auth.signInAnonymously({ options: { captchaToken } });
        if (error) throw error;
        dialog.removeEventListener('close', cancelled);
        dialog.close(); resolve();
      } catch (error) { dialog.removeEventListener('close', cancelled); dialog.close(); reject(error); }
    }).catch(error => { dialog.removeEventListener('close', cancelled); reject(error); });
  });
  await refresh();
}
async function requireMember(continuation, initialEmail = '') {
  if (!configured) throw new Error('The cinema is not connected yet.');
  const { data: { session } } = await member.auth.getSession();
  if (session) return continuation();
  openDialog(`<h2>Check your email</h2><p>We will send a one-time code to verify your address. No password needed. Voting stays anonymous.</p><form id="login-form">${field('email','Email address','email',initialEmail)}<div id="captcha"></div><button>Send code</button></form>`);
  let captchaToken = '';
  await mountCaptcha(token => captchaToken = token);
  form('#login-form', async f => {
    if (!captchaToken) throw new Error('Complete the security check first.');
    const email = String(f.get('email')).trim();
    const { error } = await member.auth.signInWithOtp({ email, options: { captchaToken, shouldCreateUser: true } });
    if (error) { window.turnstile.reset(captchaWidget); captchaToken = ''; throw error; }
    openDialog(`<h2>Enter your email code</h2><p>Code sent to ${esc(email)}. Check your spam folder too.</p><form id="verify-form">${field('token','Email code','text','','inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}"')}<button>Verify email</button></form><button class="text-button" id="retry-login">Use another address / request a new code</button>`);
    $('#retry-login').onclick = action(() => requireMember(continuation, email));
    form('#verify-form', async data => {
      const { error } = await member.auth.verifyOtp({ email, token: String(data.get('token')).trim(), type: 'email' });
      if (error) throw error;
      dialog.close(); await continuation();
    });
  });
}
$('#suggest-open').onclick = action(async () => {
  await ensureVoter();
  openDialog(`<h2>What should we watch?</h2><form id="suggest-form">${field('title','Movie title')}${field('name','Your name (optional)').replace(' required','')}<button>Send suggestion</button></form>`);
  form('#suggest-form', async f => {
    await rpc(voter, 'suggest_movie', { p_title: f.get('title'), p_name: f.get('name') });
    dialog.close(); toast('Suggestion sent to the hosts.');
  });
});
async function rsvp() {
  await refresh();
  const e = state.event;
  if (!e) throw new Error('There is no upcoming screening.');
  const profile = await rpc(member, 'member_state');
  const attending = profile.rsvps.includes(e.id);
  const booking = profile.bookings?.find(b => b.event_id === e.id);
  const { data: { session } } = await member.auth.getSession();
  openDialog(`<h2>${attending ? 'Your seat is booked' : 'Save your seat'}</h2><p>${esc(eventLabel(e))}</p><p>Booking as ${esc(session.user.email)}</p><button class="text-button" id="rsvp-switch-email">Use another email</button><form id="rsvp-form">${field('name','Your name','text',booking?.name || '')}<label class="consent"><input name="reminders" type="checkbox" ${booking?.reminders ? 'checked' : ''}> Send me a reminder before this screening.</label><button>${attending ? 'Update booking' : 'Book one seat'}</button></form>${attending ? '<button class="text-button" id="cancel-rsvp">Cancel my seat</button>' : ''}<p class="muted">One seat per verified email. Cancellation notices may still be sent if the event changes.</p>`);
  $('#rsvp-switch-email').onclick = action(async () => { await member.auth.signOut(); await requireMember(rsvp); });
  form('#rsvp-form', async f => {
    await rpc(member, 'set_rsvp', { p_event: e.id, p_name: f.get('name'), p_attending: true, p_reminders: f.has('reminders') });
    dialog.close(); await refresh(); toast('Your seat is booked.');
  });
  if (attending) $('#cancel-rsvp').onclick = action(async () => {
    await rpc(member, 'set_rsvp', { p_event: e.id, p_name: '', p_attending: false });
    dialog.close(); await refresh(); toast('Your seat has been released.');
  });
}
$('#rsvp-open').onclick = action(() => requireMember(rsvp));
form('#subscribe-form', async f => {
  if (!f.has('consent')) throw new Error('Please confirm you want movie-night emails.');
  await requireMember(async () => {
    const { data: { session } } = await member.auth.getSession();
    openDialog(`<h2>A little movie mail</h2><p>Subscribe ${esc(session.user.email)} to invitations and RSVP reminders?</p><button class="button" id="confirm-subscribe">Yes, subscribe me</button><button class="text-button" id="change-email">Use another email</button>`);
    $('#confirm-subscribe').onclick = action(async () => {
      await rpc(member, 'set_subscription', { p_active: true });
      dialog.close(); $('#subscribe-form').reset(); toast('You are on the movie-mail list.');
    });
    $('#change-email').onclick = action(async () => { await member.auth.signOut(); dialog.close(); toast('Enter the other email address in the signup form.'); });
  }, String(f.get('email')));
});
$('#account-open').onclick = action(() => requireMember(async () => {
  const profile = await rpc(member, 'member_state');
  const { data: { session } } = await member.auth.getSession();
  openDialog(`<h2>Your movie mail</h2><p>${esc(session.user.email)}</p><p>${profile.subscribed ? 'You receive invitations and RSVP reminders.' : 'You are not subscribed to invitations.'}</p>${profile.subscribed ? '<button class="button" id="stop-mail">Stop invitations</button>' : ''}<button class="text-button" id="sign-out">Sign out</button><p>Manage your seat and screening reminder using the RSVP button.</p>`);
  if (profile.subscribed) $('#stop-mail').onclick = action(async () => { await rpc(member, 'set_subscription', { p_active: false }); dialog.close(); toast('Invitations stopped.'); });
  $('#sign-out').onclick = action(async () => { await member.auth.signOut(); dialog.close(); toast('Signed out. Your anonymous votes are unchanged.'); });
}));
async function host() {
  const data = await rpc(member, 'host_data');
  await refresh();
  const e = state.event;
  openDialog(`<p class="eyebrow">HOST VIEW</p><h2>Set the scene</h2>
    ${e ? `<p>${esc(eventLabel(e))}</p><p>Published screenings are fixed so invitations remain accurate. Cancel this screening to replace it; guests must RSVP again.</p><button class="button" id="cancel-event">Cancel this screening</button>` : `<form id="event-form"><p>Hosts choose the winner and break ties. Publishing closes voting.</p><label for="film-pick">Film</label><select id="film-pick" name="movie">${[...state.movies].sort((a,b)=>count(b.id)-count(a.id)||a.title.localeCompare(b.title)).map(m=>`<option value="${esc(m.id)}">${esc(m.title)} (${m.year}) · ${count(m.id)} votes</option>`).join('')}</select>${field('date','Date and time in the event timezone','datetime-local')}${field('timezone','Event timezone','text','America/New_York')}${field('location','Location (visible on the website)','text','Our living room')}${field('capacity','Seats','number','12','min="1" max="100"')}<button>Publish screening</button></form>`}
    <hr><h2>Next voting round</h2><form id="round-form"><p>This starts fresh counts. Previous ballots remain in the database.</p>${field('cutoff','Voting closes (your browser timezone)','datetime-local')}<button>Open a new round</button></form>
    <hr><h2>Suggestions</h2>${data.suggestions.length ? data.suggestions.map(s=>`<div class="request"><strong>${esc(s.title)}</strong><p>${esc(s.name || 'A movie lover')}</p><button data-review="${s.id}">Review</button></div>`).join('') : '<p>No pending suggestions.</p>'}
    <hr><h2>Guest list</h2>${data.rsvps.map(r=>`<p>${esc(r.name)} · ${esc(r.email)}</p>`).join('') || '<p>No RSVPs yet.</p>'}<p>${data.subscribers} email subscribers</p>
    <h3>Email delivery</h3>${data.mail.map(m=>`<p>${esc(m.kind)}: ${m.count} ${esc(m.status)}</p>`).join('') || '<p>No messages queued yet. The scheduler checks every ten minutes.</p>'}`);
  if (e) $('#cancel-event').onclick = action(async () => {
    if (!window.confirm('Cancel this screening? Guests will be notified and seat bookings will no longer apply.')) return;
    await rpc(member, 'cancel_event', { p_event: e.id }); await host();
  });
  else form('#event-form', async f => {
    await rpc(member, 'publish_event', { p_movie: f.get('movie'), p_local_time: f.get('date'), p_timezone: f.get('timezone'), p_location: f.get('location'), p_capacity: Number(f.get('capacity')) });
    await host(); toast('Screening published. Invitations are scheduled automatically.');
  });
  form('#round-form', async f => {
    const cutoff = new Date(String(f.get('cutoff')));
    if (!Number.isFinite(cutoff.getTime()) || cutoff <= new Date()) {
      throw new Error('Choose a future date and time for voting to close.');
    }
    if (!window.confirm('Start a new round with fresh vote counts?')) return;
    await rpc(member, 'open_round', { p_closes_at: cutoff.toISOString() });
    await refresh();
    if (!votingOpen()) throw new Error('The request completed, but voting still appears closed. Please check the cutoff and refresh before trying again.');
    dialog.close();
    toast(`Voting is open until ${new Date(state.round.closes_at).toLocaleString()}.`);
  });
  document.querySelectorAll('[data-review]').forEach(b=>b.onclick=()=>review(data.suggestions.find(s=>s.id===b.dataset.review)));
}
$('#host-open').onclick = action(() => requireMember(host));
function review(s) {
  openDialog(`<h2>Add to the watchlist</h2><form id="review-form">${field('title','Title','text',s.title)}${field('year','Release year','number','','min="1888" max="2100"')}${field('genres','Genres, separated by commas')}${field('imdb_id','IMDb ID (optional)','text','','placeholder="tt0166924" pattern="tt[0-9]+"').replace(' required','')}${field('poster','HTTPS poster URL (optional)','url').replace(' required','')}<label for="description">Description</label><textarea id="description" name="description" required maxlength="500"></textarea><button>Approve film</button></form><button id="reject-suggestion" class="text-button">Dismiss suggestion</button>`);
  form('#review-form', async f => {
    const movie = Object.fromEntries(f);
    movie.year = Number(movie.year);
    movie.genres = movie.genres.split(',').map(s=>s.trim()).filter(Boolean);
    movie.poster = movie.poster || 'assets/poster-placeholder.svg';
    if (safeImage(movie.poster) !== movie.poster) throw new Error('Use an HTTPS poster URL.');
    await rpc(member, 'review_suggestion', { p_id: s.id, p_movie: movie });
    await host(); toast('Film added. Its TMDB poster will update on the next refresh.');
  });
  $('#reject-suggestion').onclick = action(async () => { await rpc(member, 'review_suggestion', { p_id: s.id }); await host(); });
}
render();
if (configured) {
  refresh().then(() => {
    const requested = new URL(location.href).searchParams.get('event');
    if (requested && requested !== state.event?.id) toast('The screening from your email is no longer available. The current screening is shown here.');
  }).catch(() => { $('#connection-status').textContent = 'Could not connect to the cinema. Reload to try again; no changes have been saved.'; });
  setInterval(() => { if (!document.hidden && !dialog.open) refresh().catch(() => { ready = false; render(); $('#connection-status').hidden = false; $('#connection-status').textContent = 'Connection lost. Retrying shortly.'; }); }, 60000);
} else $('#connection-status').textContent = 'Preview only — the cinema is not connected yet. Voting, RSVPs, and email signup are unavailable.';
