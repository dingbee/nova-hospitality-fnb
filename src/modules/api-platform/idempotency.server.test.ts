import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "@/modules/commercial/test-helpers/fakeSupabase";
import { requestFingerprint, withIdempotency } from "./idempotency.server";

function freshSb() {
  return createFakeSupabase({ api_idempotency_records: [] });
}

describe("idempotency.server — deterministic replay", () => {
  it("runs the handler once and returns its result when no key is given", async () => {
    const sb = freshSb();
    let calls = 0;
    const result = await withIdempotency(
      sb,
      {
        tenantId: "t1",
        credentialId: "c1",
        idempotencyKey: null,
        endpoint: "/orders",
        fingerprint: "f",
      },
      async () => {
        calls += 1;
        return { status: 201, body: { id: "order-1" } };
      },
    );
    expect(calls).toBe(1);
    expect(result.replayed).toBe(false);
    expect(result.status).toBe(201);
  });

  it("runs the handler exactly once for a new key, persists the response", async () => {
    const sb = freshSb();
    let calls = 0;
    const outcome = await withIdempotency(
      sb,
      {
        tenantId: "t1",
        credentialId: "c1",
        idempotencyKey: "key-1",
        endpoint: "/orders",
        fingerprint: "fp-a",
      },
      async () => {
        calls += 1;
        return { status: 201, body: { id: "order-1" } };
      },
    );
    expect(calls).toBe(1);
    expect(outcome.replayed).toBe(false);
    expect((await sb.from("api_idempotency_records").select("*")).data).toHaveLength(1);
  });

  it("a retried request with the SAME key and SAME body replays the original response without re-running the handler — proves retries cannot duplicate a transactional record", async () => {
    const sb = freshSb();
    let calls = 0;
    const handler = async () => {
      calls += 1;
      return { status: 201, body: { id: "order-1", createdByCall: calls } };
    };
    const ctx = {
      tenantId: "t1",
      credentialId: "c1",
      idempotencyKey: "key-1",
      endpoint: "/orders",
      fingerprint: "fp-a",
    };

    const first = await withIdempotency(sb, ctx, handler);
    const second = await withIdempotency(sb, ctx, handler);

    expect(calls).toBe(1); // handler never ran twice
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.body).toEqual(first.body); // caller sees the SAME persisted record both times
  });

  it("a retried request with the SAME key and a DIFFERENT body is a 409 conflict, not silently accepted", async () => {
    const sb = freshSb();
    const handler = async () => ({ status: 201, body: { id: "order-1" } });

    await withIdempotency(
      sb,
      {
        tenantId: "t1",
        credentialId: "c1",
        idempotencyKey: "key-1",
        endpoint: "/orders",
        fingerprint: "fp-original",
      },
      handler,
    );

    await expect(
      withIdempotency(
        sb,
        {
          tenantId: "t1",
          credentialId: "c1",
          idempotencyKey: "key-1",
          endpoint: "/orders",
          fingerprint: "fp-DIFFERENT",
        },
        handler,
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  it("a different idempotency key is a fully independent request (no cross-key interference)", async () => {
    const sb = freshSb();
    let calls = 0;
    const handler = async () => {
      calls += 1;
      return { status: 201, body: { id: `order-${calls}` } };
    };
    const a = await withIdempotency(
      sb,
      {
        tenantId: "t1",
        credentialId: "c1",
        idempotencyKey: "key-a",
        endpoint: "/orders",
        fingerprint: "f",
      },
      handler,
    );
    const b = await withIdempotency(
      sb,
      {
        tenantId: "t1",
        credentialId: "c1",
        idempotencyKey: "key-b",
        endpoint: "/orders",
        fingerprint: "f",
      },
      handler,
    );
    expect(calls).toBe(2);
    expect(a.body).not.toEqual(b.body);
  });

  it("the same idempotency key is independent ACROSS tenants (no cross-tenant collision)", async () => {
    const sb = freshSb();
    let calls = 0;
    const handler = async () => {
      calls += 1;
      return { status: 201, body: { id: `order-${calls}` } };
    };
    const a = await withIdempotency(
      sb,
      {
        tenantId: "tenant-a",
        credentialId: "c1",
        idempotencyKey: "shared-key",
        endpoint: "/orders",
        fingerprint: "f",
      },
      handler,
    );
    const b = await withIdempotency(
      sb,
      {
        tenantId: "tenant-b",
        credentialId: "c2",
        idempotencyKey: "shared-key",
        endpoint: "/orders",
        fingerprint: "f",
      },
      handler,
    );
    expect(calls).toBe(2);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
  });

  it("clears the in-progress marker on handler failure so a genuine retry can proceed", async () => {
    const sb = freshSb();
    let calls = 0;
    const failingThenSucceeding = async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient DB error");
      return { status: 201, body: { id: "order-1" } };
    };
    const ctx = {
      tenantId: "t1",
      credentialId: "c1",
      idempotencyKey: "key-1",
      endpoint: "/orders",
      fingerprint: "f",
    };

    await expect(withIdempotency(sb, ctx, failingThenSucceeding)).rejects.toThrow(
      "transient DB error",
    );
    const retried = await withIdempotency(sb, ctx, failingThenSucceeding);
    expect(calls).toBe(2);
    expect(retried.replayed).toBe(false);
    expect(retried.status).toBe(201);
  });

  it("a concurrent duplicate racing on a never-seen key loses to whichever insert wins, and the loser gets a safe 409 rather than double-executing", async () => {
    const sb = freshSb();
    // Simulate the winner's insert having already landed before the loser checks.
    await sb.from("api_idempotency_records").insert({
      tenant_id: "t1",
      credential_id: "c1",
      idempotency_key: "race-key",
      request_fingerprint: "fp",
      endpoint: "/orders",
      status: "in_progress",
    });

    await expect(
      withIdempotency(
        sb,
        {
          tenantId: "t1",
          credentialId: "c1",
          idempotencyKey: "race-key",
          endpoint: "/orders",
          fingerprint: "fp",
        },
        async () => ({ status: 201, body: {} }),
      ),
    ).rejects.toMatchObject({ code: "conflict", status: 409 });
  });
});

describe("idempotency.server — request fingerprint", () => {
  it("is stable for the same method/path/body", () => {
    const a = requestFingerprint("POST", "/api/v1/orders", { a: 1 });
    const b = requestFingerprint("POST", "/api/v1/orders", { a: 1 });
    expect(a).toBe(b);
  });

  it("differs when the body differs", () => {
    const a = requestFingerprint("POST", "/api/v1/orders", { a: 1 });
    const b = requestFingerprint("POST", "/api/v1/orders", { a: 2 });
    expect(a).not.toBe(b);
  });

  it("differs when the path differs (same body)", () => {
    const a = requestFingerprint("POST", "/api/v1/orders", { a: 1 });
    const b = requestFingerprint("POST", "/api/v1/orders/x/status", { a: 1 });
    expect(a).not.toBe(b);
  });
});
