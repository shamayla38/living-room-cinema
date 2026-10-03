import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_PUBLISHABLE_KEY || '';
const turnstile = process.env.TURNSTILE_SITE_KEY || '';
if (process.env.CI && (!url || !key || !turnstile)) {
  throw new Error('Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and TURNSTILE_SITE_KEY repository variables before deployment.');
}
if (url && new URL(url).protocol !== 'https:') throw new Error('Supabase URL must use HTTPS.');
if (key.startsWith('sb_secret_')) throw new Error('Never publish a Supabase secret key.');
if (key.split('.').length === 3) {
  const claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString());
  if (claims.role !== 'anon') throw new Error('Only an anon or publishable key may be published.');
}
await writeFile('dist/config.js', `window.CINEMA_CONFIG = ${JSON.stringify({ url, key, turnstile })};\n`);
await build({ entryPoints: ['dist/app.js'], bundle: true, outfile: 'dist/app.bundle.js', format: 'esm', target: 'es2022', minify: true });
console.log(url ? 'Built configured site.' : 'Built unconfigured preview: submissions are disabled.');
