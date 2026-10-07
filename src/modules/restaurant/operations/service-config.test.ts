import { describe, expect, it } from "vitest";
import {
  resolveServiceConfiguration,
} from "./service-config";

describe("operational service configuration", () => {
  it("defaults from the existing operating model", () => {
    expect(resolveServiceConfiguration({ onboarding: { operatingMode: "quick_service" } })).toEqual({
      serviceMode: "takeaway",
      collectionMethod: "pickup_counter",
      readyAlert: true,
    });
    expect(resolveServiceConfiguration({ onboarding: { operatingMode: "table_service" } })).toEqual({
      serviceMode: "table_service",
      collectionMethod: "staff_serves",
      readyAlert: false,
    });
  });

  it("allows service and collection to be configured independently", () => {
    expect(resolveServiceConfiguration({
      onboarding: { operatingMode: "table_service" },
      operations: {
        serviceMode: "self_service",
        collectionMethod: "guest_collects",
        readyAlert: true,
      },
    })).toEqual({
      serviceMode: "self_service",
      collectionMethod: "guest_collects",
      readyAlert: true,
    });
  });

  it("does not let payment timing become the service-mode authority", () => {
    expect(resolveServiceConfiguration({
      payment: { guestTiming: "pay_first" },
      onboarding: { operatingMode: "table_service" },
    })).toEqual({
      serviceMode: "table_service",
      collectionMethod: "staff_serves",
      readyAlert: false,
    });
  });
});
