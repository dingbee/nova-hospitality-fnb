/**
 * P02.3/P02.4 — demo session activation.
 *
 * The authorization-critical guarantee — that the grant RPC takes no
 * arguments and always resolves to the hardcoded canonical tenant/property/
 * location with role 'viewer', never a client-supplied value — is proven
 * live against a real Postgres instance by
 * local/scripts/verify-demo-access.sql. This suite covers activateDemoSession's
 * own TS-layer behaviour: it never calls the grant RPC without a verified
 * registration, and it always calls it through the caller's own client
 * (never the admin/service-role client, which has no auth.uid()).
 */
import { describe, expect, it } from "vitest";
import { createDemoFakeSupabase, type FakeTables } from "./test-helpers/fakeSupabase";
import { activateDemoSession, DemoAccessError, getMyDemoSession } from "./session.server";

const GRANT_ROW = {
  out_session_id: "session-1",
  out_tenant_id: "cebda97b-33b1-43bf-932e-d7fee992a6c3",
  out_property_id: "d6674bdc-ebe2-4bb7-801a-54b1b8dfc218",
  out_location_id: "fb15e245-b2bf-4d07-abb6-213bbeafa584",
  out_role: "viewer",
  out_expires_at: "2030-01-01T00:00:00.000Z",
};

describe("activateDemoSession", () => {
  it("throws when the caller has no demo registration at all", async () => {
    const admin = createDemoFakeSupabase({ lexibite_demo_registrations: [] });
    const sb = createDemoFakeSupabase({}, { restaurant_grant_demo_session: () => GRANT_ROW });
    await expect(activateDemoSession(sb, admin, "no-such-user")).rejects.toBeInstanceOf(
      DemoAccessError,
    );
  });

  it("flips pending_verification to verified before calling the grant RPC (reaching here IS the verification proof)", async () => {
    const tables: FakeTables = {
      lexibite_demo_registrations: [
        { id: "reg-1", auth_user_id: "user-1", status: "pending_verification" },
      ],
    };
    const admin = createDemoFakeSupabase(tables);
    let rpcCalled = false;
    const sb = createDemoFakeSupabase(
      {},
      {
        restaurant_grant_demo_session: () => {
          rpcCalled = true;
          return GRANT_ROW;
        },
      },
    );
    const result = await activateDemoSession(sb, admin, "user-1");
    expect(rpcCalled).toBe(true);
    expect(tables.lexibite_demo_registrations![0].status).toBe("verified");
    expect(result.tenantId).toBe("cebda97b-33b1-43bf-932e-d7fee992a6c3");
    expect(result.role).toBe("viewer");
  });

  it("never forwards a client-supplied value into the grant RPC (it takes no arguments)", async () => {
    const tables: FakeTables = {
      lexibite_demo_registrations: [{ id: "reg-1", auth_user_id: "user-1", status: "verified" }],
    };
    const admin = createDemoFakeSupabase(tables);
    let receivedArgs: unknown;
    const sb = createDemoFakeSupabase(
      {},
      {
        restaurant_grant_demo_session: (args: unknown) => {
          receivedArgs = args;
          return GRANT_ROW;
        },
      },
    );
    await activateDemoSession(sb, admin, "user-1");
    expect(receivedArgs).toBeUndefined();
  });

  it("propagates a DemoAccessError when the RPC itself rejects the caller", async () => {
    const tables: FakeTables = {
      lexibite_demo_registrations: [{ id: "reg-1", auth_user_id: "user-1", status: "verified" }],
    };
    const admin = createDemoFakeSupabase(tables);
    const sb = createDemoFakeSupabase(
      {},
      {
        restaurant_grant_demo_session: () => {
          throw new Error("restaurant_grant_demo_session: no authenticated caller");
        },
      },
    );
    await expect(activateDemoSession(sb, admin, "user-1")).rejects.toBeInstanceOf(DemoAccessError);
  });
});

describe("getMyDemoSession — access before expiry, denial after expiry/revocation", () => {
  const baseSession = {
    id: "session-1",
    tenant_id: "cebda97b-33b1-43bf-932e-d7fee992a6c3",
    property_id: "d6674bdc-ebe2-4bb7-801a-54b1b8dfc218",
    location_id: "fb15e245-b2bf-4d07-abb6-213bbeafa584",
    role: "viewer",
  };

  it("reports an active session that has not yet expired", async () => {
    const inOneHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const admin = createDemoFakeSupabase({
      lexibite_demo_sessions: [
        { ...baseSession, user_id: "visitor-1", status: "active", expires_at: inOneHour },
      ],
    });
    const result = await getMyDemoSession(admin, "visitor-1");
    expect(result).not.toBeNull();
    expect(result?.tenantId).toBe("cebda97b-33b1-43bf-932e-d7fee992a6c3");
  });

  it("denies a session whose expires_at has passed, even though its stored status still says 'active'", async () => {
    // Nothing flips the status column automatically — only an admin-run
    // reset does that. Real-time expiry must not depend on that ever
    // having run (this is the exact gap restaurant_member_active/migration
    // 0083 closes at the RLS layer; this proves the TS-side read-back
    // agrees with it rather than lying about a stale row).
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const admin = createDemoFakeSupabase({
      lexibite_demo_sessions: [
        { ...baseSession, user_id: "visitor-1", status: "active", expires_at: anHourAgo },
      ],
    });
    const result = await getMyDemoSession(admin, "visitor-1");
    expect(result).toBeNull();
  });

  it("denies a session explicitly marked 'expired'", async () => {
    const inOneHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const admin = createDemoFakeSupabase({
      lexibite_demo_sessions: [
        { ...baseSession, user_id: "visitor-1", status: "expired", expires_at: inOneHour },
      ],
    });
    expect(await getMyDemoSession(admin, "visitor-1")).toBeNull();
  });

  it("denies a session explicitly marked 'revoked', even with time left on the clock", async () => {
    const inOneHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const admin = createDemoFakeSupabase({
      lexibite_demo_sessions: [
        { ...baseSession, user_id: "visitor-1", status: "revoked", expires_at: inOneHour },
      ],
    });
    expect(await getMyDemoSession(admin, "visitor-1")).toBeNull();
  });

  it("returns null for a visitor with no session row at all", async () => {
    const admin = createDemoFakeSupabase({ lexibite_demo_sessions: [] });
    expect(await getMyDemoSession(admin, "nobody")).toBeNull();
  });
});
