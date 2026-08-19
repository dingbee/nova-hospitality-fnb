/** Single business profile record — no list, always one form. */
import * as React from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DEFAULT_TIMEZONE } from "@/modules/restaurant/core/product";
import { SectionCard } from "@/components/os/SectionCard";
import { Field, FieldRow } from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { upsertRestaurantBusinessProfileFn } from "../../masterdata.functions";
import type { MasterData } from "../types";

export function BusinessPanel({ tenantId, data }: { tenantId: string; data: MasterData }) {
  const business = (data.tenant?.settings as { business?: Record<string, unknown> } | null)?.business ?? {};
  const [form, setForm] = React.useState({
    legalName: (business.legalName as string) ?? data.tenant?.name ?? "",
    tradingName: (business.tradingName as string) ?? "",
    code: (business.code as string) ?? "",
    taxId: (business.taxId as string) ?? "",
    defaultCurrency: (business.defaultCurrency as string) ?? "TZS",
    timezone: (business.timezone as string) ?? DEFAULT_TIMEZONE,
    phone: (business.phone as string) ?? "",
    email: (business.email as string) ?? "",
    address: (business.address as string) ?? "",
  });

  React.useEffect(() => {
    setForm({
      legalName: (business.legalName as string) ?? data.tenant?.name ?? "",
      tradingName: (business.tradingName as string) ?? "",
      code: (business.code as string) ?? "",
      taxId: (business.taxId as string) ?? "",
      defaultCurrency: (business.defaultCurrency as string) ?? "TZS",
      timezone: (business.timezone as string) ?? DEFAULT_TIMEZONE,
      phone: (business.phone as string) ?? "",
      email: (business.email as string) ?? "",
      address: (business.address as string) ?? "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.tenant?.id]);

  const qc = useQueryClient();
  const fn = useServerFn(upsertRestaurantBusinessProfileFn);
  const mutation = useAdminMutation({
    mutationFn: fn,
    successMessage: "Business profile saved.",
    onSuccess: () => qc.invalidateQueries({ queryKey: ["restaurant.masterdata", tenantId] }),
  });

  return (
    <SectionCard title="Business profile" description="Legal identity used across invoices, receipts and reports.">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate({
            data: {
              tenantId,
              legalName: form.legalName,
              tradingName: form.tradingName || undefined,
              code: form.code || undefined,
              taxId: form.taxId || undefined,
              defaultCurrency: form.defaultCurrency,
              timezone: form.timezone,
              phone: form.phone || undefined,
              email: form.email || undefined,
              address: form.address || undefined,
            },
          });
        }}
      >
        <FieldRow>
          <Field label="Legal name" required>
            <Input
              className="h-11"
              value={form.legalName}
              onChange={(e) => setForm((f) => ({ ...f, legalName: e.target.value }))}
              required
            />
          </Field>
          <Field label="Trading name">
            <Input
              className="h-11"
              value={form.tradingName}
              onChange={(e) => setForm((f) => ({ ...f, tradingName: e.target.value }))}
            />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Business code">
            <Input className="h-11" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} />
          </Field>
          <Field label="Tax ID">
            <Input className="h-11" value={form.taxId} onChange={(e) => setForm((f) => ({ ...f, taxId: e.target.value }))} />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Default currency" required>
            <Input
              className="h-11"
              value={form.defaultCurrency}
              maxLength={3}
              onChange={(e) => setForm((f) => ({ ...f, defaultCurrency: e.target.value.toUpperCase() }))}
              required
            />
          </Field>
          <Field label="Timezone" required>
            <Input
              className="h-11"
              value={form.timezone}
              onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
              required
            />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Phone">
            <Input className="h-11" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
          </Field>
          <Field label="Email">
            <Input
              className="h-11"
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
          </Field>
        </FieldRow>
        <Field label="Address">
          <Input className="h-11" value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} />
        </Field>
        <div className="flex justify-end border-t pt-4">
          <Button type="submit" className="h-11 min-w-32" disabled={mutation.isPending}>
            Save
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}
