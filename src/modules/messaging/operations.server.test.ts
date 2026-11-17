import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertCapability,
  assertTenantRead,
  getTenantScope,
} from "@/modules/restaurant/core/access.server";
import { assertCommercialAdmin } from "@/modules/commercial/access.server";
import {
  getFounderWhatsAppOverview,
  listWhatsAppInbox,
  listWhatsAppGuestCRM,
} from "./operations.server";

vi.mock("@/modules/restaurant/core/access.server", () => ({
  accessiblePropertyIds: vi.fn(() => ["property-1"]),
  assertCapability: vi.fn(),
  assertTenantRead: vi.fn(),
  getTenantScope: vi.fn(async () => ({
    tenantId: "tenant-1",
    platformAdmin: false,
    grants: [{ role: "owner", propertyId: "property-1" }],
  })),
}));

vi.mock("@/modules/commercial/access.server", () => ({
  assertCommercialAdmin: vi.fn(),
}));

describe("WhatsApp operations authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTenantScope).mockResolvedValue({
      tenantId: "tenant-1",
      platformAdmin: false,
      grants: [{ role: "owner", propertyId: "property-1" }],
    });
  });

  it("requires founder commercial-admin authorization before platform-wide reads", async () => {
    vi.mocked(assertCommercialAdmin).mockRejectedValueOnce(new Error("commercial admin required"));
    await expect(getFounderWhatsAppOverview({}, "tenant-owner")).rejects.toThrow(
      "commercial admin required",
    );
    expect(assertCommercialAdmin).toHaveBeenCalledWith({}, "tenant-owner");
  });

  it("rejects tenant inbox reads before querying when tenant membership is absent", async () => {
    vi.mocked(assertTenantRead).mockRejectedValueOnce(new Error("tenant membership required"));
    const db = { from: vi.fn() };
    await expect(listWhatsAppInbox(db, "outside-user", { tenantId: "tenant-1" })).rejects.toThrow(
      "tenant membership required",
    );
    expect(db.from).not.toHaveBeenCalled();
  });

  it("checks guest-read capability before exposing CRM data", async () => {
    vi.mocked(assertCapability).mockRejectedValueOnce(new Error("guest read required"));
    const db = { from: vi.fn() };
    await expect(
      listWhatsAppGuestCRM(db, "read-only-user", { tenantId: "tenant-1" }),
    ).rejects.toThrow("guest read required");
    expect(db.from).not.toHaveBeenCalled();
  });
  it("does not let platform-admin status substitute for tenant membership on tenant APIs", async () => {
    vi.mocked(getTenantScope).mockResolvedValue({
      tenantId: "tenant-1",
      platformAdmin: true,
      grants: [],
    });
    const db = { from: vi.fn() };
    await expect(
      listWhatsAppInbox(db, "platform-admin", { tenantId: "tenant-1" }),
    ).rejects.toThrow("tenant_membership_required");
    expect(db.from).not.toHaveBeenCalled();
  });

});
