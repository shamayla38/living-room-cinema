import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_PUBLISHABLE_KEY || '';
const turnstile = process.env.TURNSTILE_SITE_KEY || '';
const missing = Object.entries({ SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: key, TURNSTILE_SITE_KEY: turnstile })
  .filter(([, value]) => !value.trim()).map(([name]) => name);
if (process.env.CI && missing.length) {
  throw new Error(`Missing build configuration: ${missing.join(', ')}. In the repository running this workflow, open Settings > Secrets and variables > Actions > Variables and add these as Repository variables (not Repository secrets). The Pages workflow reads vars.*, not secrets.*. After pushing workflow changes, start a new Run workflow on that branch.`);
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
