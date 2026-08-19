import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { RESTAURANT_ROLE_LABELS } from "@/modules/restaurant/core/permissions";
import { TeamPanel } from "@/modules/restaurant/core/ui/TeamPanel";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";

export const Route = createFileRoute("/_authenticated/admin/restaurant/settings")({
  head: () => ({
    meta: [
      { title: "Tenant Settings — Restaurant & Bar OS" },
      { name: "description", content: "Tenant, properties, outlets, plan and your restaurant roles." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const ws = useRestaurantWorkspace();
  const d = ws.data;

  if (ws.isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (!d?.tenant) return <EmptyState title="No tenant" description="No restaurant tenant is available to you." />;

  return (
    <div className="space-y-4">
      <PageHeader title="Tenant Settings" description="Commercial configuration for this Restaurant & Bar OS tenant." />

      <SectionCard title="Tenant">
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Name</dt><dd>{d.tenant.name}</dd></div>
          <div><dt className="text-muted-foreground">Slug</dt><dd>{d.tenant.slug}</dd></div>
          <div><dt className="text-muted-foreground">Status</dt><dd>{d.tenant.status}</dd></div>
          <div>
            <dt className="text-muted-foreground">Plan</dt>
            <dd>
              {d.subscription ? `${d.subscription.plan} · ${d.subscription.status} · ${d.subscription.seats} seats` : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">VAT</dt>
            <dd>{d.tenant.settings.tax?.vat_percent != null ? `${d.tenant.settings.tax.vat_percent}%` : "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Service charge</dt>
            <dd>{d.tenant.settings.service_charge_percent != null ? `${d.tenant.settings.service_charge_percent}%` : "—"}</dd>
          </div>
        </dl>
      </SectionCard>

      <SectionCard title="Properties & outlets">
        <ul className="divide-y text-sm">
          {d.properties.map((p) => (
            <li key={p.id} className="py-2">
              <div className="flex items-center justify-between">
                <span>{p.name}</span>
                <span className="text-xs text-muted-foreground">{p.currency} · {p.timezone}</span>
              </div>
              <ul className="mt-1 pl-4 text-xs text-muted-foreground">
                {d.locations.filter((l) => l.property_id === p.id).map((l) => (
                  <li key={l.id}>{l.name} — {l.location_type}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </SectionCard>

      <TeamPanel
        tenantId={d.tenant.id}
        canManage={d.platformAdmin || d.roles.some((r) => r === "owner" || r === "general_manager")}
      />

      <SectionCard title="Your access">
        <p className="text-sm text-muted-foreground">
          {d.platformAdmin ? "Platform administrator (full oversight). " : ""}
          {d.roles.length > 0
            ? `Roles: ${d.roles.map((r) => RESTAURANT_ROLE_LABELS[r]).join(", ")}.`
            : "No tenant-specific restaurant role assigned."}
        </p>
      </SectionCard>
    </div>
  );
}