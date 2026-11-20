import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAV_GROUPS } from "./navigation";

describe("Integrations navigation (StayNas × LexiBite reachability)", () => {
  it("exposes a single Integrations entry gated by SETTINGS:READ", () => {
    const entries = NAV_GROUPS.flatMap((group) => group.items ?? []).filter(
      (item: { to?: string }) => item.to === "/admin/restaurant/integrations",
    ) as Array<{ label: string; permission?: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ label: "Integrations", permission: "SETTINGS:READ" });
  });

  it("the Integrations centre links to the StayNas connection route that exists", () => {
    const centre = readFileSync(
      "src/modules/api-platform/ui/ChannelIntegrationsCentre.tsx",
      "utf8",
    );
    expect(centre).toContain('href="/admin/staynas-integration"');
    const route = readFileSync("src/routes/_authenticated.admin.staynas-integration.tsx", "utf8");
    expect(route).toContain('createFileRoute("/_authenticated/admin/staynas-integration")');
  });
});
