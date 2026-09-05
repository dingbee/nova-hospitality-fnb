/** Single business profile record — no list, always one form. */
import * as React from "react";
import { ImageOff } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DEFAULT_TIMEZONE } from "@/modules/restaurant/core/product";
import { SectionCard } from "@/components/os/SectionCard";
import { Field, FieldRow } from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { upsertRestaurantBusinessProfileFn } from "../../masterdata.functions";
import { removeTenantLogoFn, uploadTenantLogoFn } from "../../tenant-logo.functions";
import { validateTenantLogoFile, TENANT_LOGO_MIME_TYPES } from "../../tenant-logo.contracts";
import type { MasterData } from "../types";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // "data:image/png;base64,AAAA..." — keep only the payload.
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the selected file."));
    reader.readAsDataURL(file);
  });
}

const ACCEPTED_LOGO_TYPES = TENANT_LOGO_MIME_TYPES.join(",");

/**
 * This is the ONE place a restaurant's logo is managed — POS (TopBar) and
 * the Guest Portal (welcome, header) only ever read settings.business.logoUrl,
 * never their own upload control. See tenant-logo.server.ts for the storage
 * side (public-read bucket, tenant-scoped write, no SVG).
 */
function LogoField({
  logoUrl,
  onUpload,
  onRemove,
  uploadPending,
  removePending,
}: {
  logoUrl: string | null | undefined;
  onUpload: (file: File) => void;
  onRemove: () => void;
  uploadPending?: boolean;
  removePending?: boolean;
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  return (
    <Field
      label="Business logo"
      hint="Square or horizontal logo with a transparent background where possible. JPEG, PNG or WebP, up to 1.5MB."
    >
      <div className="flex items-center gap-3">
        <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
          {logoUrl ? (
            <img src={logoUrl} alt="Current business logo" className="size-full object-contain" />
          ) : (
            <ImageOff className="size-6 text-muted-foreground" aria-hidden="true" />
          )}
        </div>
        <div className="flex flex-col gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_LOGO_TYPES}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) onUpload(file);
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={uploadPending || removePending}
            onClick={() => fileInputRef.current?.click()}
          >
            {logoUrl ? "Replace logo" : "Upload logo"}
          </Button>
          {logoUrl && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={uploadPending || removePending}
              onClick={onRemove}
            >
              Remove logo
            </Button>
          )}
        </div>
      </div>
    </Field>
  );
}

export function BusinessPanel({ tenantId, data }: { tenantId: string; data: MasterData }) {
  const business =
    (data.tenant?.settings as { business?: Record<string, unknown> } | null)?.business ?? {};
  const logoUrl = (business.logoUrl as string | null | undefined) ?? null;
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
    website: (business.website as string) ?? "",
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
      website: (business.website as string) ?? "",
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

  const uploadLogoFn = useServerFn(uploadTenantLogoFn);
  const removeLogoFn = useServerFn(removeTenantLogoFn);
  const uploadLogo = useAdminMutation({
    mutationFn: async (file: File) => {
      const validationError = validateTenantLogoFile(file);
      if (validationError) throw new Error(validationError);
      const fileBase64 = await fileToBase64(file);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mimeType is narrowed by validateTenantLogoFile above
      return uploadLogoFn({ data: { tenantId, mimeType: file.type as any, fileBase64 } });
    },
    successMessage: "Logo updated.",
    onSuccess: () => qc.invalidateQueries({ queryKey: ["restaurant.masterdata", tenantId] }),
  });
  const removeLogo = useAdminMutation({
    mutationFn: () => removeLogoFn({ data: { tenantId } }),
    successMessage: "Logo removed.",
    onSuccess: () => qc.invalidateQueries({ queryKey: ["restaurant.masterdata", tenantId] }),
  });

  return (
    <SectionCard
      title="Business profile"
      description="Legal identity used across invoices, receipts and reports."
    >
      <LogoField
        logoUrl={logoUrl}
        onUpload={(file) => uploadLogo.mutate(file)}
        onRemove={() => removeLogo.mutate(undefined)}
        uploadPending={uploadLogo.isPending}
        removePending={removeLogo.isPending}
      />
      <form
        className="space-y-4 border-t pt-4"
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
              website: form.website || undefined,
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
            <Input
              className="h-11"
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
            />
          </Field>
          <Field label="Tax ID">
            <Input
              className="h-11"
              value={form.taxId}
              onChange={(e) => setForm((f) => ({ ...f, taxId: e.target.value }))}
            />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Default currency" required>
            <Input
              className="h-11"
              value={form.defaultCurrency}
              maxLength={3}
              onChange={(e) =>
                setForm((f) => ({ ...f, defaultCurrency: e.target.value.toUpperCase() }))
              }
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
            <Input
              className="h-11"
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            />
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
        <FieldRow>
          <Field label="Address">
            <Input
              className="h-11"
              value={form.address}
              onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
            />
          </Field>
          <Field label="Website">
            <Input
              className="h-11"
              type="url"
              placeholder="https://…"
              value={form.website}
              onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))}
            />
          </Field>
        </FieldRow>
        <div className="flex justify-end border-t pt-4">
          <Button type="submit" className="h-11 min-w-32" disabled={mutation.isPending}>
            Save
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}
