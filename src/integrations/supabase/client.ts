// NOVA Hospitality F&B — data-API client (product-owned).
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

// --- NOVA local appliance configuration (standalone builds only) -----------
// In local mode the Supabase-compatible API is the on-premise NOVA gateway,
// served same-origin over TLS. Auth, JWT validation, RLS and the password
// model are unchanged — only the base URL differs. Hosted builds never enter
// this path.
const LOCAL_DEFAULT_ORIGIN = 'https://localhost:8443';

function isLocalRuntime() {
  return (
    String(import.meta.env.VITE_NOVA_RUNTIME_MODE ?? process.env.NOVA_RUNTIME_MODE ?? '')
      .trim()
      .toLowerCase() === 'local'
  );
}

function resolveLocalApiUrl() {
  // Prefer the origin the terminal is actually served from (LAN or localhost),
  // then any explicitly configured URL, then the appliance default.
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  const configured = import.meta.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  if (configured && !/nova-appliance\.invalid/.test(configured)) return configured;
  return LOCAL_DEFAULT_ORIGIN;
}
// ---------------------------------------------------------------------------

function createSupabaseClient() {
  // Use import.meta.env for client-side (Vite build-time replacement)
  // Fall back to process.env for SSR (server-side rendering)
  const SUPABASE_URL = isLocalRuntime()
    ? resolveLocalApiUrl()
    : import.meta.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    const missing = [
      ...(!SUPABASE_URL ? ['SUPABASE_URL'] : []),
      ...(!SUPABASE_PUBLISHABLE_KEY ? ['SUPABASE_PUBLISHABLE_KEY'] : []),
    ];
    const message = `Missing Supabase environment variable(s): ${missing.join(', ')}. Configure the appliance environment (standalone/.env).`;
    console.error(`[Supabase] ${message}`);
    throw new Error(message);
  }

  return createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      storage: typeof window !== 'undefined' ? localStorage : undefined,
      persistSession: true,
      autoRefreshToken: true,
    }
  });
}

let _supabase: ReturnType<typeof createSupabaseClient> | undefined;

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";
export const supabase = new Proxy({} as ReturnType<typeof createSupabaseClient>, {
  get(_, prop, receiver) {
    if (!_supabase) _supabase = createSupabaseClient();
    return Reflect.get(_supabase, prop, receiver);
  },
});

