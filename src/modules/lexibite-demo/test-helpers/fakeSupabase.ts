/* eslint-disable @typescript-eslint/no-explicit-any -- generic in-memory fake mirrors Supabase's untyped query builder. */
/**
 * Minimal in-memory Supabase fake for the LexiBite Demo Access suites.
 * Mirrors the existing per-domain fakes (src/modules/commercial/test-helpers/
 * fakeSupabase.ts, src/modules/restaurant/intelligence/p05.test-helpers.ts)
 * but with a working `.gte()` filter (needed for the IP rate-limit window
 * check in registration.server.ts, which those two fakes leave as a no-op).
 */
let seq = 0;
function genId(): string {
  seq += 1;
  return `fake-demo-${seq}`;
}

export interface FakeTables {
  [table: string]: any[];
}

export function createDemoFakeSupabase(
  tables: FakeTables,
  rpcHandlers: Record<string, (args: any) => any> = {},
) {
  function matches(row: any, filters: { eq: [string, any][]; gte: [string, any][] }): boolean {
    for (const [col, val] of filters.eq) if (row[col] !== val) return false;
    for (const [col, val] of filters.gte) if (!(row[col] >= val)) return false;
    return true;
  }

  function builder(table: string) {
    const filters: { eq: [string, any][]; gte: [string, any][] } = { eq: [], gte: [] };
    let mode: "select" | "insert" | "update" = "select";
    let payload: any = null;
    let limitN: number | null = null;
    let wantCount = false;

    const api: any = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.count) wantCount = true;
        return api;
      },
      insert(row: any) {
        mode = "insert";
        payload = row;
        return api;
      },
      update(patch: any) {
        mode = "update";
        payload = patch;
        return api;
      },
      eq(col: string, val: any) {
        filters.eq.push([col, val]);
        return api;
      },
      gte(col: string, val: any) {
        filters.gte.push([col, val]);
        return api;
      },
      order() {
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      execute(): { data: any; error: any; count?: number } {
        tables[table] = tables[table] ?? [];
        if (mode === "select") {
          let rows = tables[table].filter((r) => matches(r, filters));
          const count = rows.length;
          if (limitN != null) rows = rows.slice(0, limitN);
          return { data: rows, error: null, ...(wantCount ? { count } : {}) };
        }
        if (mode === "insert") {
          const row = { id: genId(), created_at: new Date().toISOString(), ...payload };
          tables[table].push(row);
          return { data: row, error: null };
        }
        if (mode === "update") {
          const matched = tables[table].filter((r) => matches(r, filters));
          matched.forEach((r) => Object.assign(r, payload));
          return { data: matched.length === 1 ? matched[0] : matched, error: null };
        }
        return { data: null, error: { message: "unsupported" } };
      },
      maybeSingle() {
        const { data, error } = api.execute();
        const row = Array.isArray(data) ? (data[0] ?? null) : data;
        return Promise.resolve({ data: row, error });
      },
      single() {
        const { data, error } = api.execute();
        const row = Array.isArray(data) ? data[0] : data;
        if (!row && !error) return Promise.resolve({ data: null, error: { message: "not found" } });
        return Promise.resolve({ data: row, error });
      },
      then(resolve: (v: { data: any; error: any }) => unknown, reject?: (e: any) => unknown) {
        try {
          return Promise.resolve(api.execute()).then(resolve, reject);
        } catch (e) {
          return Promise.reject(e).catch(reject);
        }
      },
    };
    return api;
  }

  return {
    from: (table: string) => builder(table),
    auth: {
      admin: {
        generateLink: async (_args: any) => {
          const handler = rpcHandlers["__generateLink"];
          if (handler) return { data: handler(_args), error: null };
          return {
            data: {
              properties: { action_link: "https://example.test/verify" },
              user: { id: genId() },
            },
            error: null,
          };
        },
      },
    },
    rpc: (name: string, args: any) => {
      const handler = rpcHandlers[name];
      if (!handler)
        return Promise.resolve({ data: null, error: { message: `no rpc handler for ${name}` } });
      try {
        return Promise.resolve({ data: handler(args), error: null });
      } catch (e) {
        return Promise.resolve({ data: null, error: { message: (e as Error).message } });
      }
    },
  };
}
