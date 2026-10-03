import { admin, authorizedCron, secret } from '../_shared/server.ts';

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let stage = 'authorization';
  try {
    if (!authorizedCron(request)) return new Response('Unauthorized', { status: 401 });
    stage = 'configuration';
    const db = admin();
    const token = secret('TMDB_TOKEN');
    stage = 'catalog_read';
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
  } catch (error) {
    // Never log raw errors: provider errors can contain request URLs or credentials.
    const setting = error instanceof Error
      ? /^Missing server setting: ([A-Z_]+)$/.exec(error.message)?.[1]
      : undefined;
    const rawCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const code = /^[A-Z0-9]{2,12}$/.test(rawCode) ? rawCode : undefined;
    const diagnostic = { error: 'Poster refresh unavailable', stage, ...(setting ? { setting } : {}), ...(code ? { code } : {}) };
    console.error('Poster refresh failed', diagnostic);
    return Response.json(diagnostic, { status: 503 });
  }
});
