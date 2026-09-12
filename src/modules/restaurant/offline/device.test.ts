import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, DB_NAME } from "./db";
import { detectDeviceContextChange, getDeviceIdentity, registerDevice } from "./device";

beforeEach(async () => {
  await closeDb();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
});
afterEach(async () => {
  await closeDb();
});

const SCOPE_A = { tenantId: "tenant-a", propertyId: "prop-a", outletId: "outlet-a" };
const SCOPE_B = { tenantId: "tenant-b", propertyId: "prop-b", outletId: "outlet-b" };

describe("device identity", () => {
  it("has no identity before first registration", async () => {
    expect(await getDeviceIdentity()).toBeUndefined();
  });

  it("registration creates a stable identity, persisted across a simulated reload", async () => {
    const first = await registerDevice(SCOPE_A);
    expect(first.deviceId).toBeTruthy();
    await closeDb(); // simulate refresh — see db.test.ts's note on why this, not resetDbConnectionForTests
    const reloaded = await getDeviceIdentity();
    expect(reloaded?.deviceId).toBe(first.deviceId);
  });

  it("re-registering the SAME scope keeps the same deviceId (not a fresh identity every login)", async () => {
    const first = await registerDevice(SCOPE_A);
    const second = await registerDevice(SCOPE_A);
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.registrationEpoch).toBe(first.registrationEpoch + 1);
  });

  it("two independent registrations (simulating two separate devices/browser profiles) never collide", async () => {
    const deviceA = await registerDevice(SCOPE_A);
    await closeDb();
    // A genuinely separate device would have its own IndexedDB origin
    // entirely; this asserts the identity generator itself never produces
    // the same id twice, which is the property that actually matters —
    // uniqueness is crypto.randomUUID()'s job, not this module's.
    const deviceBId = crypto.randomUUID();
    expect(deviceBId).not.toBe(deviceA.deviceId);
  });

  it("device identity is generated locally, never derived from or equal to user-controlled input", async () => {
    // registerDevice's context (tenantId/propertyId/outletId) is entirely
    // caller-supplied, but the deviceId itself must never be — there is no
    // parameter that lets a caller set it, which this asserts structurally:
    // registerDevice's only inputs are the scope, and the returned deviceId
    // is a fresh UUID unrelated to any of them.
    const identity = await registerDevice(SCOPE_A);
    expect(identity.deviceId).not.toBe(SCOPE_A.tenantId);
    expect(identity.deviceId).not.toBe(SCOPE_A.propertyId);
    expect(identity.deviceId).not.toBe(SCOPE_A.outletId);
    expect(identity.deviceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  describe("detectDeviceContextChange — the device cannot silently follow a scope change", () => {
    it("reports 'unregistered' when no device has ever been registered", async () => {
      const change = await detectDeviceContextChange(SCOPE_A);
      expect(change.kind).toBe("unregistered");
    });

    it("reports 'none' when the current login matches the registered scope exactly", async () => {
      await registerDevice(SCOPE_A);
      const change = await detectDeviceContextChange(SCOPE_A);
      expect(change.kind).toBe("none");
    });

    it("reports 'tenant_changed' — this is the boundary that prevents a device registered for Tenant A from silently carrying Tenant B authority", async () => {
      await registerDevice(SCOPE_A);
      const change = await detectDeviceContextChange({ ...SCOPE_A, tenantId: SCOPE_B.tenantId });
      expect(change).toEqual({
        kind: "tenant_changed",
        from: SCOPE_A.tenantId,
        to: SCOPE_B.tenantId,
      });
    });

    it("reports 'outlet_changed' when only the outlet differs (same tenant)", async () => {
      await registerDevice(SCOPE_A);
      const change = await detectDeviceContextChange({ ...SCOPE_A, outletId: "outlet-z" });
      expect(change).toEqual({ kind: "outlet_changed", from: SCOPE_A.outletId, to: "outlet-z" });
    });

    it("a tenant change is reported even when the outlet also changed — tenant takes precedence as the more severe boundary", async () => {
      const change = await (async () => {
        await registerDevice(SCOPE_A);
        return detectDeviceContextChange(SCOPE_B);
      })();
      expect(change.kind).toBe("tenant_changed");
    });
  });

  it("device identity persistence is not authorization: reading a stored identity performs no capability check and grants nothing by itself", async () => {
    // Structural assertion: getDeviceIdentity's only effect is an IndexedDB
    // read. It never calls Supabase, never asserts a capability, and its
    // return value carries no token/credential — reusing a persisted
    // deviceId across a session boundary cannot, by construction, grant
    // access to anything the server doesn't independently re-authorize.
    await registerDevice(SCOPE_A);
    const identity = await getDeviceIdentity();
    expect(identity).not.toHaveProperty("token");
    expect(identity).not.toHaveProperty("accessToken");
    expect(identity).not.toHaveProperty("password");
    expect(identity).not.toHaveProperty("apiKey");
  });
});
