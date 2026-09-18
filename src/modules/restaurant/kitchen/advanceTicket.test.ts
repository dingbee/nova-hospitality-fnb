/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
import { describe, expect, it, vi } from "vitest";

/**
 * Regression for a real operational-integrity gap: advanceTicket accepted
 * any TICKET_STATUSES enum value and wrote it unconditionally — there was no
 * check that the transition from the ticket's *current* status was legal,
 * and no compare-and-swap on the write, so:
 *   1. a client could move a ticket backward (e.g. "ready" -> "preparing")
 *      or resurrect a served/cancelled one — the Kitchen board's single
 *      "Mark <next>" button never sends this, but that is UI-only
 *      protection, not authorization;
 *   2. two concurrent calls reading the same starting status could both
 *      pass, and the second write silently discarded the first — a real
 *      lost-update race between two kitchen devices acting on one ticket.
 *
 * Fixed with an explicit legal-transition table and a status-conditioned
 * (compare-and-swap) UPDATE in kitchen.server.ts's advanceTicket.
 */

vi.mock("../core/access.server", () => ({
  assertCapability: vi.fn(async () => {}),
}));
vi.mock("../events/emit.server", () => ({
  emitRestaurantEvent: vi.fn(async () => ({ delivered: true })),
}));

import { advanceTicket } from "./kitchen.server";

const TENANT = "tenant-1";
const USER = "user-1";
const TICKET = "ticket-1";

function fakeDb(
  tickets: any[],
  ticketItems: any[] = [],
  opts: { onFirstSelect?: () => void } = {},
) {
  let selectCount = 0;
  function ticketsTable() {
    const isSelect = { select: false };
    const filters: Array<(r: any) => boolean> = [];
    let mode: "select" | "update" = "select";
    let patch: any = null;
    const api: any = {
      select: () => {
        isSelect.select = true;
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return api;
      },
      update(p: any) {
        mode = "update";
        patch = p;
        return api;
      },
      maybeSingle: async () => {
        const m = tickets.filter((r) => filters.every((f) => f(r)));
        if (mode === "update") for (const r of m) Object.assign(r, patch);
        return { data: m[0] ?? null, error: null };
      },
      single: async () => {
        const m = tickets.filter((r) => filters.every((f) => f(r)));
        if (mode === "update") for (const r of m) Object.assign(r, patch);
        // Snapshot before any onFirstSelect mutation below, so a select read
        // reflects state exactly as of this call, unaffected by a
        // concurrent write simulated to land immediately afterward.
        const snapshot = m[0] ? { ...m[0] } : null;
        if (mode === "select") {
          selectCount += 1;
          // Simulates another concurrent caller's write completing in the
          // gap between this call's read and its own later conditional
          // write — mutates the real underlying row, not the snapshot.
          if (selectCount === 1) opts.onFirstSelect?.();
        }
        return { data: snapshot, error: snapshot ? null : { message: "not found" } };
      },
    };
    return api;
  }
  function ticketItemsTable() {
    const filters: Array<(r: any) => boolean> = [];
    let patch: any = null;
    const api: any = {
      update(p: any) {
        patch = p;
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return api;
      },
      then: (resolve: any) => {
        const m = ticketItems.filter((r) => filters.every((f) => f(r)));
        for (const r of m) Object.assign(r, patch);
        return resolve({ data: null, error: null });
      },
    };
    return api;
  }
  return {
    from: (table: string) => {
      if (table === "restaurant_kitchen_tickets") return ticketsTable();
      if (table === "restaurant_kitchen_ticket_items") return ticketItemsTable();
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function ticketRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: TICKET,
    ticket_number: "KOT-1-1",
    order_id: "order-1",
    station_id: "station-1",
    location_id: null,
    status: "preparing",
    target_minutes: 15,
    queued_at: new Date(Date.now() - 60_000).toISOString(),
    started_at: new Date(Date.now() - 30_000).toISOString(),
    ready_at: null,
    tenant_id: TENANT,
    ...overrides,
  };
}

describe("advanceTicket — server-enforced state machine", () => {
  it("allows the legal next transition (preparing -> ready)", async () => {
    const tickets = [ticketRow({ status: "preparing" })];
    const sb = fakeDb(tickets);
    const result = await advanceTicket(sb, USER, {
      tenantId: TENANT,
      ticketId: TICKET,
      status: "ready",
    } as any);
    expect(result.status).toBe("ready");
    expect(tickets[0]!.status).toBe("ready");
  });

  it("rejects a backward transition even though the input passes schema validation", async () => {
    const tickets = [ticketRow({ status: "ready" })];
    const sb = fakeDb(tickets);
    await expect(
      advanceTicket(sb, USER, { tenantId: TENANT, ticketId: TICKET, status: "preparing" } as any),
    ).rejects.toThrow(/cannot move from "ready" to "preparing"/i);
    expect(tickets[0]!.status).toBe("ready"); // unchanged
  });

  it("rejects resurrecting an already-served ticket", async () => {
    const tickets = [ticketRow({ status: "served" })];
    const sb = fakeDb(tickets);
    await expect(
      advanceTicket(sb, USER, { tenantId: TENANT, ticketId: TICKET, status: "preparing" } as any),
    ).rejects.toThrow(/cannot move from "served"/i);
  });

  it("treats a same-status resend as an idempotent no-op, not an error", async () => {
    const tickets = [ticketRow({ status: "preparing" })];
    const sb = fakeDb(tickets);
    const result = await advanceTicket(sb, USER, {
      tenantId: TENANT,
      ticketId: TICKET,
      status: "preparing",
    } as any);
    expect(result.status).toBe("preparing");
  });

  it("a genuine concurrent write (CAS loss) is rejected instead of silently clobbering the ticket that already moved on", async () => {
    // This call reads status "preparing" and decides preparing -> ready is
    // legal. Before its own conditional UPDATE runs, a concurrent caller's
    // write lands, moving the real row to "cancelled" (also a legal move
    // from "preparing"). The compare-and-swap (`.eq("status", "preparing")`)
    // must then find zero matching rows and refuse rather than overwrite
    // the cancellation with "ready".
    const tickets = [ticketRow({ status: "preparing" })];
    const sb = fakeDb(tickets, [], {
      onFirstSelect: () => {
        tickets[0]!.status = "cancelled";
      },
    });
    await expect(
      advanceTicket(sb, USER, { tenantId: TENANT, ticketId: TICKET, status: "ready" } as any),
    ).rejects.toThrow(/changed to "cancelled".*before this update reached it/i);
    expect(tickets[0]!.status).toBe("cancelled"); // never clobbered back to "ready"
  });
});
