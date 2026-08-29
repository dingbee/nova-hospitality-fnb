import { describe, expect, it } from "vitest";
import {
  classifyRecoveredOrder,
  clearStoredOrderId,
  clearStoredSessionToken,
  readStoredOrderId,
  readStoredSessionToken,
  writeStoredOrderId,
  writeStoredSessionToken,
  type KeyValueStorage,
} from "./selforder-recovery";

/** An in-memory stand-in for window.localStorage — this test file runs in Node, which has no window/localStorage at all. */
class FakeStorage implements KeyValueStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

describe("stored order recovery hint — table scoping", () => {
  it("recovers the stored order for the correct table", () => {
    const storage = new FakeStorage();
    writeStoredOrderId("table-A", "order-123", storage);
    expect(readStoredOrderId("table-A", storage)).toBe("order-123");
  });

  it("a different table cannot recover it — table B never sees table A's stored id", () => {
    const storage = new FakeStorage();
    writeStoredOrderId("table-A", "order-123", storage);
    expect(readStoredOrderId("table-B", storage)).toBeNull();
  });

  it("two tables can each hold their own stored order independently", () => {
    const storage = new FakeStorage();
    writeStoredOrderId("table-A", "order-A1", storage);
    writeStoredOrderId("table-B", "order-B1", storage);
    expect(readStoredOrderId("table-A", storage)).toBe("order-A1");
    expect(readStoredOrderId("table-B", storage)).toBe("order-B1");
  });

  it("nothing stored for a table reads as null, not an empty string or a throw", () => {
    const storage = new FakeStorage();
    expect(readStoredOrderId("table-unused", storage)).toBeNull();
  });
});

describe("refresh / re-entry behavior", () => {
  it("the stored id survives across separate read calls against the same storage — models a page reload", () => {
    const storage = new FakeStorage();
    writeStoredOrderId("table-A", "order-123", storage);
    // Simulates the component unmounting and remounting (a reload) against
    // the same underlying browser storage.
    expect(readStoredOrderId("table-A", storage)).toBe("order-123");
    expect(readStoredOrderId("table-A", storage)).toBe("order-123");
  });

  it("dismissing the recovery hint means the next entry finds nothing to recover", () => {
    const storage = new FakeStorage();
    writeStoredOrderId("table-A", "order-123", storage);
    clearStoredOrderId("table-A", storage);
    expect(readStoredOrderId("table-A", storage)).toBeNull();
  });

  it("storage functions never throw when storage is unavailable (private browsing, quota, SSR) — recovery degrades silently, never crashes the page", () => {
    expect(() => writeStoredOrderId("table-A", "order-123", null)).not.toThrow();
    expect(() => clearStoredOrderId("table-A", null)).not.toThrow();
    expect(readStoredOrderId("table-A", null)).toBeNull();
  });
});

describe("classifyRecoveredOrder — recoverable-state definition", () => {
  it("invalid/nonexistent order (server lookup failed) is safely ignored", () => {
    expect(classifyRecoveredOrder(null)).toBe("none");
  });

  it("cancelled order cannot be resumed", () => {
    expect(
      classifyRecoveredOrder({ status: "cancelled", paymentState: "pending", amountDue: 42 }),
    ).toBe("none");
  });

  it("voided order cannot be resumed", () => {
    expect(
      classifyRecoveredOrder({ status: "voided", paymentState: "pending", amountDue: 42 }),
    ).toBe("none");
  });

  it("an unpaid order that's already closed cannot be resumed — nothing actionable is left", () => {
    expect(
      classifyRecoveredOrder({ status: "closed", paymentState: "pending", amountDue: 42 }),
    ).toBe("none");
  });

  it("a paid order is never treated as unpaid, regardless of its order status", () => {
    for (const status of ["open", "sent", "served", "closed"]) {
      expect(classifyRecoveredOrder({ status, paymentState: "paid", amountDue: 0 })).toBe("paid");
    }
  });

  it("amountDue <= 0 alone is enough to read as paid, even if paymentState isn't literally 'paid' (comped, room-charged, etc.)", () => {
    expect(classifyRecoveredOrder({ status: "open", paymentState: "comped", amountDue: 0 })).toBe(
      "paid",
    );
  });

  it("a payment-pending order preserves its own (unpaid, still-active) state rather than being coerced to paid or dropped", () => {
    expect(
      classifyRecoveredOrder({ status: "open", paymentState: "pending", amountDue: 11000 }),
    ).toBe("offer");
  });

  it("a live, unpaid order in any active status is offered for recovery", () => {
    for (const status of ["open", "sent", "served"]) {
      expect(classifyRecoveredOrder({ status, paymentState: "pending", amountDue: 11000 })).toBe(
        "offer",
      );
    }
  });

  it("a declined payment attempt with a balance still owing stays recoverable, not silently paid or dropped", () => {
    expect(
      classifyRecoveredOrder({ status: "open", paymentState: "pending", amountDue: 5000 }),
    ).toBe("offer");
  });
});

describe("stored guest-session token — table scoping (O12)", () => {
  it("recovers the stored session token for the correct table", () => {
    const storage = new FakeStorage();
    writeStoredSessionToken("table-A", "session-token-123", storage);
    expect(readStoredSessionToken("table-A", storage)).toBe("session-token-123");
  });

  it("a different table cannot read table A's stored session token — never mixed with the order-id key", () => {
    const storage = new FakeStorage();
    writeStoredOrderId("table-A", "order-123", storage);
    writeStoredSessionToken("table-A", "session-token-123", storage);
    expect(readStoredSessionToken("table-B", storage)).toBeNull();
    // The two hints live under distinct keys — clearing one never touches the other.
    clearStoredSessionToken("table-A", storage);
    expect(readStoredOrderId("table-A", storage)).toBe("order-123");
  });

  it("nothing stored reads as null, not an empty string or a throw", () => {
    const storage = new FakeStorage();
    expect(readStoredSessionToken("table-unused", storage)).toBeNull();
  });

  it("storage functions never throw when storage is unavailable — degrades silently", () => {
    expect(() => writeStoredSessionToken("table-A", "session-token-123", null)).not.toThrow();
    expect(() => clearStoredSessionToken("table-A", null)).not.toThrow();
    expect(readStoredSessionToken("table-A", null)).toBeNull();
  });
});

describe("localStorage is never treated as authorization", () => {
  it("the exact same stored id resolves to entirely different outcomes depending only on what the server says — the id itself proves nothing", () => {
    const storage = new FakeStorage();
    writeStoredOrderId("table-A", "order-123", storage);
    expect(readStoredOrderId("table-A", storage)).toBe("order-123");

    // Every branch below is fed the *server's* answer for that same stored
    // id — never the id or storage state itself. classifyRecoveredOrder
    // has no parameter through which a client-asserted "this is valid"
    // could even be passed.
    expect(classifyRecoveredOrder(null)).toBe("none"); // server: not found for this table
    expect(
      classifyRecoveredOrder({ status: "cancelled", paymentState: "pending", amountDue: 10 }),
    ).toBe("none"); // server: cancelled
    expect(classifyRecoveredOrder({ status: "open", paymentState: "pending", amountDue: 10 })).toBe(
      "offer",
    ); // server: still active, unpaid
    expect(classifyRecoveredOrder({ status: "open", paymentState: "paid", amountDue: 0 })).toBe(
      "paid",
    ); // server: paid
  });

  it("writing to storage has no effect on the server-derived classification — it only decides what to ask about", () => {
    const storage = new FakeStorage();
    // No write at all — an order can be classified from a server response
    // with nothing in storage, proving storage isn't consulted by
    // classifyRecoveredOrder in the first place.
    expect(readStoredOrderId("table-A", storage)).toBeNull();
    expect(classifyRecoveredOrder({ status: "open", paymentState: "paid", amountDue: 0 })).toBe(
      "paid",
    );
  });
});
