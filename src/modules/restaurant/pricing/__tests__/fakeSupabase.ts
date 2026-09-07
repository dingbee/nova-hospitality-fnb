/* eslint-disable @typescript-eslint/no-explicit-any -- generic in-memory fake matching the real query shapes used by the modules under test. */
/**
 * A small, generic in-memory Supabase fake shared by the Pricing Centre
 * server tests (catalogue.server.test.ts, pricing.server.bulk.test.ts).
 * Supports exactly the query surface those modules use — select/insert/
 * update, eq/in/is/not/ilike filters, order/limit — applied uniformly
 * across every seeded table rather than hand-coded per table.
 */
type Row = Record<string, any>;

export function makeFakeSupabase(seed: Record<string, Row[]> = {}) {
  const store = new Map<string, Row[]>();
  for (const [table, rows] of Object.entries(seed))
    store.set(
      table,
      rows.map((r) => ({ ...r })),
    );
  let seq = 0;

  function from(table: string) {
    const filters: Array<[string, "eq" | "in" | "is" | "not" | "ilike", any]> = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: any;
    let orderCol: string | null = null;
    let ascending = true;
    let limitN: number | null = null;

    const api: any = {
      select: () => api,
      eq: (col: string, val: any) => {
        filters.push([col, "eq", val]);
        return api;
      },
      in: (col: string, vals: any[]) => {
        filters.push([col, "in", vals]);
        return api;
      },
      is: (col: string, val: any) => {
        filters.push([col, "is", val]);
        return api;
      },
      not: (col: string, _op: string, val: any) => {
        filters.push([col, "not", val]);
        return api;
      },
      ilike: (col: string, pattern: string) => {
        filters.push([col, "ilike", pattern]);
        return api;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderCol = col;
        ascending = opts?.ascending ?? true;
        return api;
      },
      limit: (n: number) => {
        limitN = n;
        return api;
      },
      insert: (p: any) => {
        mode = "insert";
        payload = p;
        return api;
      },
      update: (p: any) => {
        mode = "update";
        payload = p;
        return api;
      },
      maybeSingle: () => run(true),
      single: () => run(true),
      then: (onFulfilled: any, onRejected: any) => run(false).then(onFulfilled, onRejected),
    };

    function applyFilters(rows: Row[]) {
      return rows.filter((r) =>
        filters.every(([col, op, val]) => {
          if (op === "eq") return r[col] === val;
          if (op === "in") return (val as any[]).includes(r[col]);
          if (op === "is") return r[col] === val;
          if (op === "not") return r[col] !== val;
          if (op === "ilike") {
            const needle = String(val).replace(/%/g, "").toLowerCase();
            return String(r[col] ?? "")
              .toLowerCase()
              .includes(needle);
          }
          return true;
        }),
      );
    }

    async function run(single: boolean) {
      const rows = store.get(table) ?? [];
      if (mode === "insert") {
        const arr = Array.isArray(payload) ? payload : [payload];
        const inserted = arr.map((p: any) => ({ id: p.id ?? `${table}-${++seq}`, ...p }));
        store.set(table, [...rows, ...inserted]);
        return single ? { data: inserted[0], error: null } : { data: inserted, error: null };
      }
      if (mode === "update") {
        const matched = applyFilters(rows);
        for (const r of matched) Object.assign(r, payload);
        return { data: single ? (matched[0] ?? null) : matched, error: null };
      }
      let result = applyFilters(rows);
      if (orderCol) {
        const col = orderCol;
        result = [...result].sort((a, b) => {
          const av = a[col];
          const bv = b[col];
          if (av === bv) return 0;
          return (av > bv ? 1 : -1) * (ascending ? 1 : -1);
        });
      }
      if (limitN != null) result = result.slice(0, limitN);
      return single ? { data: result[0] ?? null, error: null } : { data: result, error: null };
    }

    return api;
  }

  return { sb: { from, rpc: async () => ({ data: null, error: null }) } as any, store };
}
