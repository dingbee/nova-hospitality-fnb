/* eslint-disable @typescript-eslint/no-explicit-any -- generic in-memory fake mirrors Supabase's untyped query builder. */
/**
 * Minimal in-memory Supabase fake shared by the P02 lifecycle test suites.
 * Supports exactly the query shapes billing.server.ts / agreements.server.ts /
 * subscription-lifecycle.server.ts / payments.server.ts actually issue:
 * select/insert/update/upsert with eq/in/lte/limit/order filters,
 * maybeSingle/single/list terminals, and a pluggable rpc() map.
 *
 * `.or(...)` clauses (used for effective_from/effective_until windows) are
 * accepted but not interpreted — test fixtures are written with
 * effective_until left null so the eq/lte filters alone already select the
 * intended row, exactly as documented in each test.
 */
let seq = 0;
function genId(): string {
  seq += 1;
  return `fake-${seq}`;
}

export interface FakeTables {
  [table: string]: any[];
}

export function createFakeSupabase(
  tables: FakeTables,
  rpcHandlers: Record<string, (args: any) => any> = {},
) {
  function matches(
    row: any,
    filters: {
      eq: [string, any][];
      in: [string, any[]][];
      notIn: [string, any[]][];
      notNull: string[];
      ilike: [string, RegExp][];
    },
  ): boolean {
    for (const [col, val] of filters.eq) if (row[col] !== val) return false;
    for (const [col, vals] of filters.in) if (!vals.includes(row[col])) return false;
    for (const [col, vals] of filters.notIn) if (vals.includes(row[col])) return false;
    for (const col of filters.notNull) if (row[col] == null) return false;
    for (const [col, re] of filters.ilike) if (!re.test(String(row[col] ?? ""))) return false;
    return true;
  }

  function builder(table: string) {
    const filters: {
      eq: [string, any][];
      in: [string, any[]][];
      notIn: [string, any[]][];
      notNull: string[];
      ilike: [string, RegExp][];
    } = { eq: [], in: [], notIn: [], notNull: [], ilike: [] };
    let mode: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let payload: any = null;
    let upsertConflictCol: string | null = null;
    let limitN: number | null = null;
    let orderBy: { col: string; ascending: boolean } | null = null;

    const api: any = {
      select() {
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
      upsert(row: any, opts?: { onConflict?: string }) {
        mode = "upsert";
        payload = row;
        upsertConflictCol = opts?.onConflict ?? null;
        return api;
      },
      delete() {
        mode = "delete";
        return api;
      },
      eq(col: string, val: any) {
        filters.eq.push([col, val]);
        return api;
      },
      in(col: string, vals: any[]) {
        filters.in.push([col, vals]);
        return api;
      },
      /** Mirrors the two real shapes this codebase's server modules use: `.not(col, "in", "(a,b)")` and `.not(col, "is", null)`. */
      not(col: string, op: string, value: any) {
        if (op === "in" && typeof value === "string") {
          const vals = value.replace(/^\(|\)$/g, "").split(",");
          filters.notIn.push([col, vals]);
        } else if (op === "is" && value === null) {
          filters.notNull.push(col);
        }
        return api;
      },
      ilike(col: string, pattern: string) {
        const re = new RegExp(pattern.replace(/%/g, ".*"), "i");
        filters.ilike.push([col, re]);
        return api;
      },
      lte() {
        return api;
      },
      gte() {
        return api;
      },
      gt() {
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
      execute(): { data: any; error: any } {
        tables[table] = tables[table] ?? [];
        if (mode === "select") {
          let rows = tables[table].filter((r) => matches(r, filters));
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
          if (limitN != null) rows = rows.slice(0, limitN);
          return { data: rows, error: null, count: rows.length } as any;
        }
        if (mode === "insert") {
          const rows = Array.isArray(payload) ? payload : [payload];
          const inserted = rows.map((r) => ({ id: genId(), ...r }));
          tables[table].push(...inserted);
          return { data: inserted.length === 1 ? inserted[0] : inserted, error: null };
        }
        if (mode === "update") {
          const matched = tables[table].filter((r) => matches(r, filters));
          matched.forEach((r) => Object.assign(r, payload));
          return { data: matched.length === 1 ? matched[0] : matched, error: null };
        }
        if (mode === "upsert") {
          const key = upsertConflictCol ?? "id";
          const existing = tables[table].find((r) => r[key] === payload[key]);
          if (existing) {
            Object.assign(existing, payload);
            return { data: existing, error: null };
          }
          const row = { id: genId(), ...payload };
          tables[table].push(row);
          return { data: row, error: null };
        }
        if (mode === "delete") {
          const before = tables[table].length;
          tables[table] = tables[table].filter((r) => !matches(r, filters));
          return { data: { count: before - tables[table].length }, error: null };
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
    rpc: (name: string, args: any) => {
      const handler = rpcHandlers[name];
      if (!handler)
        return Promise.resolve({ data: null, error: { message: `no rpc handler for ${name}` } });
      return Promise.resolve({ data: handler(args), error: null });
    },
  };
}
