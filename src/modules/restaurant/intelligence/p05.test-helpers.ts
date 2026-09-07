/* eslint-disable @typescript-eslint/no-explicit-any -- generic in-memory fake mirrors Supabase's untyped query builder. */
/**
 * Minimal in-memory Supabase fake shared by the P05 test suites — mirrors
 * commercial/test-helpers/fakeSupabase.ts's pattern (this codebase's own
 * precedent for a cross-file-shared fake, justified there for the P02
 * lifecycle suites) for the query shapes the P05 engines actually issue:
 * select with eq/neq/gte/lt/in filters, maybeSingle/single/list terminals,
 * and a pluggable rpc() map for `has_any_role` (isPlatformAdmin).
 */
export interface FakeTables {
  [table: string]: any[];
}

export function createP05FakeSupabase(
  tables: FakeTables,
  rpcHandlers: Record<string, (args: any) => any> = {},
) {
  function matches(
    row: any,
    filters: {
      eq: [string, any][];
      neq: [string, any][];
      gte: [string, any][];
      lt: [string, any][];
      in: [string, any[]][];
    },
  ): boolean {
    for (const [col, val] of filters.eq) if (row[col] !== val) return false;
    for (const [col, val] of filters.neq) if (row[col] === val) return false;
    for (const [col, val] of filters.gte) if (!(row[col] >= val)) return false;
    for (const [col, val] of filters.lt) if (!(row[col] < val)) return false;
    for (const [col, vals] of filters.in) if (!vals.includes(row[col])) return false;
    return true;
  }

  function builder(table: string) {
    const filters: {
      eq: [string, any][];
      neq: [string, any][];
      gte: [string, any][];
      lt: [string, any][];
      in: [string, any[]][];
    } = { eq: [], neq: [], gte: [], lt: [], in: [] };
    let limitN: number | null = null;
    let orderBy: { col: string; ascending: boolean } | null = null;
    let wantCount = false;

    const api: any = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.count) wantCount = true;
        return api;
      },
      eq(col: string, val: any) {
        filters.eq.push([col, val]);
        return api;
      },
      neq(col: string, val: any) {
        filters.neq.push([col, val]);
        return api;
      },
      gte(col: string, val: any) {
        filters.gte.push([col, val]);
        return api;
      },
      lt(col: string, val: any) {
        filters.lt.push([col, val]);
        return api;
      },
      lte() {
        return api;
      },
      in(col: string, vals: any[]) {
        filters.in.push([col, vals]);
        return api;
      },
      is(col: string, val: any) {
        filters.eq.push([col, val]);
        return api;
      },
      or() {
        return api;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderBy = { col, ascending: opts?.ascending !== false };
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      execute(): { data: any; error: any; count?: number } {
        const rows0 = tables[table] ?? [];
        let rows = rows0.filter((r) => matches(r, filters));
        if (orderBy) {
          const { col, ascending } = orderBy;
          rows = [...rows].sort((a, b) => {
            const av = a[col];
            const bv = b[col];
            if (av === bv) return 0;
            if (av == null) return ascending ? -1 : 1;
            if (bv == null) return ascending ? 1 : -1;
            return (av > bv ? 1 : -1) * (ascending ? 1 : -1);
          });
        }
        const count = rows.length;
        if (limitN != null) rows = rows.slice(0, limitN);
        return { data: rows, error: null, ...(wantCount ? { count } : {}) };
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
    rpc: (name: string, args: any) => {
      const handler = rpcHandlers[name];
      if (!handler) return Promise.resolve({ data: false, error: null });
      return Promise.resolve({ data: handler(args), error: null });
    },
  };
}

export const TENANT_A = "11111111-1111-1111-1111-111111111111";
export const TENANT_B = "99999999-9999-9999-9999-999999999999";
export const OWNER = "22222222-2222-2222-2222-222222222222";
export const OUTSIDER = "55555555-5555-5555-5555-555555555555";

export const OWNER_MEMBER = {
  tenant_id: TENANT_A,
  user_id: OWNER,
  role: "owner",
  property_id: null,
};
