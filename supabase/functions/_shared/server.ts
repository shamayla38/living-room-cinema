import { createClient } from 'npm:@supabase/supabase-js@2.117.2';

export function secret(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing server setting: ${name}`);
  return value;
}
export function admin() {
  return createClient(secret('SUPABASE_URL'), secret('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
export function authorizedCron(request: Request) {
  return request.headers.get('Authorization') === `Bearer ${secret('CRON_SECRET')}`;
}
export async function rpc(db: ReturnType<typeof admin>, name: string, args = {}) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw error;
  return data;
}
