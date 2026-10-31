import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = (import.meta.env.VITE_SUPABASE_URL ?? '').trim();
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();

export const supabaseConfigured = Boolean(url && anonKey);

const ORG_CODE_KEY = 'rtlink_org_code';

export function getOrgCode(): string {
  try {
    return (window.localStorage.getItem(ORG_CODE_KEY) ?? '').trim().toUpperCase();
  } catch {
    return '';
  }
}

export function setOrgCode(code: string): void {
  try {
    window.localStorage.setItem(ORG_CODE_KEY, code.trim().toUpperCase());
  } catch {
    /* storage disabled: the gate will ask again next time */
  }
}

export function clearOrgCode(): void {
  try {
    window.localStorage.removeItem(ORG_CODE_KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Every Supabase request carries the chosen organization code. The schema scopes
 * the signed-in email to the site that owns the code, so one project can serve
 * several organizations without mixing their data.
 */
const orgFetch: typeof fetch = (input, init) => {
  const code = getOrgCode();
  if (!code) return fetch(input, init);
  const request = new Request(input, init);
  request.headers.set('x-rtlink-org', code);
  return fetch(request);
};

export const supabase: SupabaseClient = createClient(
  url || 'http://127.0.0.1:54321',
  anonKey || 'missing-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    },
    global: { fetch: orgFetch }
  }
);
