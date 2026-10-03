import { admin, rpc, secret } from '../_shared/server.ts';

Deno.serve(async (request: Request) => {
  const url = new URL(request.url);
  const site = new URL(secret('SITE_URL'));
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Access-Control-Allow-Origin': site.origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (request.method === 'OPTIONS') return new Response(null, { headers });
  const token = url.searchParams.get('token') || '';
  if (!/^[a-f0-9-]{72}$/.test(token)) return new Response('Invalid unsubscribe link', { status: 400, headers });
  if (request.method === 'GET') {
    // GET never changes subscriptions: mail scanners may open every link.
    const target = new URL('unsubscribe.html', site);
    target.hash = token;
    return new Response(null, { status: 303, headers: { ...headers, Location: target.href } });
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try {
    const ok = await rpc(admin(), 'unsubscribe_email', { p_token: token });
    return new Response(ok ? 'You are unsubscribed. Existing seat bookings are unchanged.' : 'Invalid unsubscribe link', { status: ok ? 200 : 400, headers });
  } catch { return new Response('Please try again shortly.', { status: 503, headers }); }
});
