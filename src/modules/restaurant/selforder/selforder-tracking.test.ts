import { describe, expect, it } from "vitest";
import {
  classifyGuestOverallStage,
  classifyGuestStreams,
  type TrackedItem,
  type TrackedTicket,
} from "./selforder-tracking";
import type { LifecycleState } from "../sales/ui/lifecycle";

function life(overrides: Partial<LifecycleState>): LifecycleState {
  return {
    stage: "order",
    stageIndex: 1,
    nextAction: "send-to-kitchen",
    nextActionLabel: "Send to kitchen",
    reason: "",
    staged: 0,
    unsent: 0,
    inProduction: 0,
    ready: 0,
    served: 0,
    balance: 0,
    settled: false,
    delayed: false,
    blocked: false,
    billRequestedAt: null,
    billPresentedAt: null,
    receiptDelivered: false,
    tableAttached: true,
    ...overrides,
  };
}

describe("classifyGuestStreams", () => {
  it("an order not yet fired shows both its stations as received", () => {
    const items: TrackedItem[] = [
      { status: "ordered", stationType: "kitchen" },
      { status: "ordered", stationType: "bar" },
    ];
    expect(classifyGuestStreams(items, [])).toEqual([
      { station: "kitchen", stage: "received" },
      { station: "bar", stage: "received" },
    ]);
  });

  it("kitchen preparing while bar is ready", () => {
    const items: TrackedItem[] = [
      { status: "fired", stationType: "kitchen" },
      { status: "fired", stationType: "bar" },
    ];
    const tickets: TrackedTicket[] = [
      { status: "preparing", stationType: "kitchen" },
      { status: "ready", stationType: "bar" },
    ];
    expect(classifyGuestStreams(items, tickets)).toEqual([
      { station: "kitchen", stage: "preparing" },
      { station: "bar", stage: "ready" },
    ]);
  });

  it("bar preparing while kitchen is ready", () => {
    const tickets: TrackedTicket[] = [
      { status: "ready", stationType: "kitchen" },
      { status: "queued", stationType: "cocktail" },
    ];
    expect(classifyGuestStreams([], tickets)).toEqual([
      { station: "kitchen", stage: "ready" },
      { station: "bar", stage: "preparing" },
    ]);
  });

  it("one station served while another remains preparing", () => {
    const tickets: TrackedTicket[] = [
      { status: "served", stationType: "kitchen" },
      { status: "preparing", stationType: "bar" },
    ];
    expect(classifyGuestStreams([], tickets)).toEqual([
      { station: "kitchen", stage: "served" },
      { station: "bar", stage: "preparing" },
    ]);
  });

  it("all production complete — both streams served", () => {
    const tickets: TrackedTicket[] = [
      { status: "served", stationType: "kitchen" },
      { status: "served", stationType: "beverage" },
    ];
    expect(classifyGuestStreams([], tickets)).toEqual([
      { station: "kitchen", stage: "served" },
      { station: "bar", stage: "served" },
    ]);
  });

  it("a kitchen-only order never fabricates a bar stream", () => {
    const tickets: TrackedTicket[] = [{ status: "preparing", stationType: "kitchen" }];
    expect(classifyGuestStreams([], tickets)).toEqual([{ station: "kitchen", stage: "preparing" }]);
  });

  it("a stream is only as advanced as its slowest ticket", () => {
    const tickets: TrackedTicket[] = [
      { status: "served", stationType: "kitchen" },
      { status: "preparing", stationType: "kitchen" },
    ];
    expect(classifyGuestStreams([], tickets)).toEqual([{ station: "kitchen", stage: "preparing" }]);
  });

  it("a voided item contributes nothing", () => {
    const items: TrackedItem[] = [{ status: "voided", stationType: "kitchen" }];
    expect(classifyGuestStreams(items, [])).toEqual([]);
  });

  it("a cancelled ticket contributes nothing", () => {
    const tickets: TrackedTicket[] = [{ status: "cancelled", stationType: "kitchen" }];
    expect(classifyGuestStreams([], tickets)).toEqual([]);
  });

  it("an unassigned station defaults to the kitchen lane, not a third stream", () => {
    const items: TrackedItem[] = [{ status: "ordered", stationType: null }];
    expect(classifyGuestStreams(items, [])).toEqual([{ station: "kitchen", stage: "received" }]);
  });
});

describe("classifyGuestOverallStage", () => {
  it("an unfired order reads as received", () => {
    expect(classifyGuestOverallStage("open", life({ stage: "order" }))).toBe("received");
  });

  it("open tickets read as preparing", () => {
    expect(classifyGuestOverallStage("sent", life({ stage: "production" }))).toBe("preparing");
  });

  it("ready tickets awaiting the pass read as ready", () => {
    expect(
      classifyGuestOverallStage("sent", life({ stage: "service", nextAction: "mark-served" })),
    ).toBe("ready");
  });

  it("everything through production, waiting on the bill, reads as served", () => {
    expect(
      classifyGuestOverallStage("served", life({ stage: "service", nextAction: "request-bill" })),
    ).toBe("served");
  });

  it("a bill already requested still reads as served — that's the Request Bill panel's job now", () => {
    expect(
      classifyGuestOverallStage(
        "served",
        life({ stage: "bill_requested", nextAction: "present-bill" }),
      ),
    ).toBe("served");
  });

  it("a closed, settled order reads as served, not a distinct 'closed' stage", () => {
    expect(classifyGuestOverallStage("closed", life({ stage: "closed", nextAction: "none" }))).toBe(
      "served",
    );
  });

  it("a cancelled order is called out on its own, not folded into served", () => {
    expect(
      classifyGuestOverallStage("cancelled", life({ stage: "closed", nextAction: "none" })),
    ).toBe("cancelled");
  });

  it("a voided order is called out the same way", () => {
    expect(classifyGuestOverallStage("voided", life({ stage: "closed", nextAction: "none" }))).toBe(
      "cancelled",
    );
  });
});
