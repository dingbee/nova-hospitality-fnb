/**
 * P02.4 §11 — demo reset is never a public/unrestricted action.
 *
 * The SQL-level scope of the reset (only guest-self-order-writable tables,
 * only rows created since the last reset, expired-viewer-membership
 * revocation) is proven live against a real Postgres instance by
 * local/scripts/verify-demo-access.sql. This suite covers the one thing a
 * fake can prove cheaply and that matters most: the TS entry point refuses
 * a non-commercial-admin caller before ever reaching the RPC.
 */
import { describe, expect, it } from "vitest";
import { createDemoFakeSupabase } from "./test-helpers/fakeSupabase";
import { resetDemoEnvironment, revokeDemoSession } from "./reset.server";
import { CommercialForbiddenError } from "@/modules/commercial/access.server";

describe("resetDemoEnvironment", () => {
  it("refuses a non-commercial-admin caller without ever calling the reset RPC", async () => {
    let rpcCalled = false;
    const sb = createDemoFakeSupabase(
      {},
      {
        restaurant_is_commercial_admin: () => false,
        restaurant_reset_demo_environment: () => {
          rpcCalled = true;
          return {};
        },
      },
    );
    await expect(resetDemoEnvironment(sb, "demo-viewer", true)).rejects.toBeInstanceOf(
      CommercialForbiddenError,
    );
    expect(rpcCalled).toBe(false);
  });

  it("calls the RPC and maps the report for a genuine commercial admin", async () => {
    const sb = createDemoFakeSupabase(
      {},
      {
        restaurant_is_commercial_admin: () => true,
        restaurant_reset_demo_environment: (args: { _dry_run: boolean }) => ({
          orders_deleted: 3,
          order_items_deleted: 7,
          payments_deleted: 2,
          kitchen_tickets_deleted: 1,
          memberships_revoked: 1,
          dry_run: args._dry_run,
        }),
      },
    );
    const report = await resetDemoEnvironment(sb, "admin-1", true);
    expect(report).toEqual({
      ordersDeleted: 3,
      orderItemsDeleted: 7,
      paymentsDeleted: 2,
      kitchenTicketsDeleted: 1,
      membershipsRevoked: 1,
      dryRun: true,
    });
  });
});

describe("revokeDemoSession", () => {
  it("refuses a non-commercial-admin caller without ever calling the revoke RPC", async () => {
    let rpcCalled = false;
    const sb = createDemoFakeSupabase(
      {},
      {
        restaurant_is_commercial_admin: () => false,
        restaurant_revoke_demo_session: () => {
          rpcCalled = true;
          return true;
        },
      },
    );
    await expect(revokeDemoSession(sb, "demo-viewer", "session-1")).rejects.toBeInstanceOf(
      CommercialForbiddenError,
    );
    expect(rpcCalled).toBe(false);
  });

  it("calls the revoke RPC with exactly the given session id for a genuine commercial admin", async () => {
    let receivedArgs: unknown;
    const sb = createDemoFakeSupabase(
      {},
      {
        restaurant_is_commercial_admin: () => true,
        restaurant_revoke_demo_session: (args: unknown) => {
          receivedArgs = args;
          return true;
        },
      },
    );
    const revoked = await revokeDemoSession(sb, "admin-1", "session-1");
    expect(revoked).toBe(true);
    expect(receivedArgs).toEqual({ _session_id: "session-1" });
  });

  it("returns false when the RPC reports nothing was revoked", async () => {
    const sb = createDemoFakeSupabase(
      {},
      {
        restaurant_is_commercial_admin: () => true,
        restaurant_revoke_demo_session: () => false,
      },
    );
    expect(await revokeDemoSession(sb, "admin-1", "already-revoked-session")).toBe(false);
  });
});
