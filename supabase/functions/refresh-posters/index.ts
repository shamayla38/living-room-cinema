import { admin, authorizedCron, secret } from '../_shared/server.ts';

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!authorizedCron(request)) return new Response('Unauthorized', { status: 401 });
  try {
    const db = admin();
    const token = secret('TMDB_TOKEN');
    const { data: movies, error } = await db.from('movies').select('id,imdb').eq('active', true);
    if (error) throw error;
    let updated = 0, failed = 0;
    for (const movie of movies || []) {
      const imdbId = movie.imdb?.url?.match(/\/title\/(tt\d+)\//)?.[1];
      if (!imdbId) continue;
      try {
        const result = await fetch(`https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id`, {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
        });
        if (!result.ok) throw new Error('TMDB unavailable');
        const data = await result.json();
        const path = data.movie_results?.[0]?.poster_path;
        if (!path || !/^\/[a-zA-Z0-9]+\.(jpg|png)$/.test(path)) continue;
        const { error: updateError } = await db.from('movies').update({ poster: `https://image.tmdb.org/t/p/w500${path}` }).eq('id', movie.id);
        if (updateError) throw updateError;
        updated++;
      } catch { failed++; }
    }
    return Response.json({ updated, failed }, { status: failed ? 502 : 200 });
  } catch { return new Response('Poster refresh unavailable', { status: 503 }); }
});
