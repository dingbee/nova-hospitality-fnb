/**
 * P12 First-Run Experience.
 *
 * Stage 1-7 of the activation model (account -> business -> property ->
 * outlet -> operating model -> setup started -> ready for configuration),
 * collapsed into one route with local step state. Resumability is free:
 * every render re-derives the current stage from getOnboardingStatusFn,
 * which itself reads live rows (never a stored "step" — see
 * onboarding.server.ts's doc comment), so leaving and coming back, or
 * refreshing mid-flow, always lands on the true next step.
 *
 * Hands off to the existing Setup Workbench (/admin/restaurant/setup) once
 * property + outlet + operating model all exist — P13's territory starts
 * there, not here.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Check, Loader2, UtensilsCrossed } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { PRODUCT } from "@/config/product";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import {
  bootstrapTenantFn,
  createFirstOutletFn,
  getOnboardingStatusFn,
  setOperatingModelFn,
} from "@/modules/restaurant/onboarding/onboarding.functions";
import {
  BUSINESS_TYPES,
  BUSINESS_TYPE_LABELS,
  OPERATING_MODES,
  OPERATING_MODE_LABELS,
  SERVICE_FEATURES,
  SERVICE_FEATURE_LABELS,
  type BusinessType,
  type OperatingMode,
  type ServiceFeature,
} from "@/modules/restaurant/onboarding/contracts";

export const Route = createFileRoute("/_authenticated/onboarding")({
  head: () => ({
    meta: [
      { title: `Set up your restaurant — ${PRODUCT.shortName}` },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: OnboardingPage,
});

const STEP_ORDER = ["property", "outlet", "operating_model", "ready"] as const;
type Step = (typeof STEP_ORDER)[number];

function StepShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="w-full max-w-lg rounded-xl border bg-card p-8 shadow-sm">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      <div className="mt-6">{children}</div>
    </div>
  );
}

function ProgressHeader({ percent, stepLabel }: { percent: number; stepLabel: string }) {
  return (
    <div className="mb-4 w-full max-w-lg">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{stepLabel}</span>
        <span>{percent}% complete</span>
      </div>
      <Progress value={percent} className="mt-2 h-1.5" />
    </div>
  );
}

function OnboardingPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const ws = useRestaurantWorkspace();
  const tenant = ws.data?.tenant ?? null;

  const statusFn = useServerFn(getOnboardingStatusFn);
  const status = useQuery({
    queryKey: ["onboarding.status", tenant?.id],
    queryFn: () => statusFn({ data: { tenantId: tenant!.id } }),
    enabled: Boolean(tenant?.id),
  });

  // Resumable navigation: once we know the tenant's true stage, land there
  // — never restart the wizard, never re-show a step whose data already
  // exists.
  const [step, setStep] = useState<Step | null>(null);
  useEffect(() => {
    if (!tenant) {
      setStep(null); // no tenant yet -> the "create your business" screen below.
      return;
    }
    if (status.data) setStep(status.data.stage as Step);
  }, [tenant, status.data]);

  // §7 — new account, no tenant yet: welcome + business creation.
  if (!ws.isLoading && !tenant) {
    return (
      <WelcomeAndBusinessStep
        onCreated={() => void qc.invalidateQueries({ queryKey: ["restaurant.workspace"] })}
      />
    );
  }

  if (ws.isLoading || (tenant && status.isLoading) || !step) {
    return (
      <Centered>
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </Centered>
    );
  }

  const percent = status.data?.percentComplete ?? 0;
  const invalidateStatus = () =>
    void qc.invalidateQueries({ queryKey: ["onboarding.status", tenant!.id] });

  if (step === "property" || step === "outlet") {
    return (
      <Centered>
        <ProgressHeader percent={percent} stepLabel="Property & outlet" />
        <PropertyOutletStep
          tenantId={tenant!.id}
          businessName={status.data?.businessName ?? tenant!.name}
          onCreated={invalidateStatus}
        />
      </Centered>
    );
  }

  if (step === "operating_model") {
    return (
      <Centered>
        <ProgressHeader percent={percent} stepLabel="Operating model" />
        <OperatingModelStep tenantId={tenant!.id} onSaved={invalidateStatus} />
      </Centered>
    );
  }

  return (
    <Centered>
      <ProgressHeader percent={100} stepLabel="Ready" />
      <ReadyStep
        businessName={status.data?.businessName ?? tenant!.name}
        onContinue={() => navigate({ to: "/admin/restaurant/setup" })}
      />
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10 text-foreground">
      {children}
    </div>
  );
}

/* ---------------- Step 1: Welcome + business creation ---------------- */

function WelcomeAndBusinessStep({ onCreated }: { onCreated: () => void }) {
  const navigate = useNavigate();
  const bootstrapFn = useServerFn(bootstrapTenantFn);
  const [name, setName] = useState("");
  const [businessType, setBusinessType] = useState<BusinessType>("restaurant");

  const create = useAdminMutation({
    mutationFn: () =>
      bootstrapFn({
        data: {
          name: name.trim(),
          businessType,
          currency: "TZS",
          timezone: "Africa/Dar_es_Salaam",
        },
      }),
    successMessage: "Your restaurant is created.",
    onSuccess: () => {
      onCreated();
      navigate({ to: "/onboarding" });
    },
  });
  // §34 — mutation.isPending only updates on the next render, so two clicks
  // landing in the same tick (a fast double-tap) can both pass the disabled
  // check. This ref is checked-and-set synchronously, closing that race.
  const submitting = useRef(false);
  const submitOnce = () => {
    if (submitting.current) return;
    submitting.current = true;
    create.mutate(undefined, {
      onSettled: () => {
        submitting.current = false;
      },
    });
  };

  return (
    <Centered>
      <StepShell
        title={`Welcome to ${PRODUCT.shortName}`}
        description="Let's get your restaurant ready to operate. We'll walk through your business, your first outlet and how you serve guests — then hand you into full setup."
      >
        <ul className="mb-6 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          {[
            "Menus & pricing",
            "Kitchen & bar",
            "Orders & payments",
            "Guest QR ordering",
            "Inventory",
            "Business intelligence",
          ].map((f) => (
            <li key={f} className="flex items-center gap-1.5">
              <Check className="size-3.5 text-primary" /> {f}
            </li>
          ))}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (create.isPending || name.trim().length < 2) return;
            submitOnce();
          }}
          className="space-y-4"
        >
          <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            What's your restaurant called?
            <input
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Kilimanjaro Grill"
              className="mt-2 w-full rounded-md border bg-background px-4 py-3 text-sm outline-none focus:border-primary"
            />
          </label>
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              What kind of business is it?
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {BUSINESS_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setBusinessType(t)}
                  className={`rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                    businessType === t
                      ? "border-primary bg-primary/10 font-medium text-primary"
                      : "border-border text-muted-foreground hover:border-primary/40"
                  }`}
                >
                  {BUSINESS_TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </div>
          <Button
            type="submit"
            disabled={create.isPending || name.trim().length < 2}
            className="w-full"
          >
            {create.isPending && <Loader2 className="mr-2 size-4 animate-spin" />} Create your
            restaurant
          </Button>
        </form>
      </StepShell>
    </Centered>
  );
}

/* ---------------- Step 2/3: Property + outlet (single-outlet optimized, §12) ---------------- */

function PropertyOutletStep({
  tenantId,
  businessName,
  onCreated,
}: {
  tenantId: string;
  businessName: string;
  onCreated: () => void;
}) {
  const createFn = useServerFn(createFirstOutletFn);
  const [propertyName, setPropertyName] = useState(businessName);
  const [outletName, setOutletName] = useState(businessName);

  const create = useAdminMutation({
    mutationFn: () =>
      createFn({
        data: { tenantId, propertyName: propertyName.trim(), outletName: outletName.trim() },
      }),
    successMessage: "Your outlet is ready.",
    onSuccess: onCreated,
  });
  const submitting = useRef(false);
  const submitOnce = () => {
    if (submitting.current) return;
    submitting.current = true;
    create.mutate(undefined, {
      onSettled: () => {
        submitting.current = false;
      },
    });
  };

  return (
    <StepShell
      title="Where do you operate?"
      description="Property is the site your restaurant runs from. Outlet is where orders, tables and staff are actually managed — for one restaurant, these are usually the same place, so we'll set both up together."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (create.isPending || propertyName.trim().length < 2 || outletName.trim().length < 2)
            return;
          submitOnce();
        }}
        className="space-y-4"
      >
        <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Property name
          <input
            required
            value={propertyName}
            onChange={(e) => setPropertyName(e.target.value)}
            className="mt-2 w-full rounded-md border bg-background px-4 py-3 text-sm outline-none focus:border-primary"
          />
        </label>
        <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Outlet name
          <input
            required
            value={outletName}
            onChange={(e) => setOutletName(e.target.value)}
            className="mt-2 w-full rounded-md border bg-background px-4 py-3 text-sm outline-none focus:border-primary"
          />
          <span className="mt-1 block text-[11px] font-normal normal-case text-muted-foreground">
            This is what your staff will see on the POS and floor plan.
          </span>
        </label>
        <Button
          type="submit"
          disabled={
            create.isPending || propertyName.trim().length < 2 || outletName.trim().length < 2
          }
          className="w-full"
        >
          {create.isPending && <Loader2 className="mr-2 size-4 animate-spin" />} Add your first
          outlet
        </Button>
      </form>
    </StepShell>
  );
}

/* ---------------- Step 4: Operating model ---------------- */

function OperatingModelStep({ tenantId, onSaved }: { tenantId: string; onSaved: () => void }) {
  const setFn = useServerFn(setOperatingModelFn);
  const [mode, setMode] = useState<OperatingMode>("table_service");
  const [features, setFeatures] = useState<ServiceFeature[]>(["kitchen"]);

  const save = useAdminMutation({
    mutationFn: () => setFn({ data: { tenantId, operatingMode: mode, serviceFeatures: features } }),
    successMessage: "Operating model saved.",
    onSuccess: onSaved,
  });
  const submitting = useRef(false);
  const submitOnce = () => {
    if (submitting.current) return;
    submitting.current = true;
    save.mutate(undefined, {
      onSettled: () => {
        submitting.current = false;
      },
    });
  };

  const toggleFeature = (f: ServiceFeature) =>
    setFeatures((prev) => (prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]));

  return (
    <StepShell
      title="How do you serve guests?"
      description="This determines which setup steps are relevant next — you can change it later without losing anything you've already configured."
    >
      <div className="space-y-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Service style
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {OPERATING_MODES.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                  mode === m
                    ? "border-primary bg-primary/10 font-medium text-primary"
                    : "border-border text-muted-foreground hover:border-primary/40"
                }`}
              >
                {OPERATING_MODE_LABELS[m]}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Also using
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {SERVICE_FEATURES.map((f) => (
              <label
                key={f}
                className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors ${
                  features.includes(f)
                    ? "border-primary bg-primary/10"
                    : "border-border text-muted-foreground"
                }`}
              >
                <input
                  type="checkbox"
                  checked={features.includes(f)}
                  onChange={() => toggleFeature(f)}
                  className="size-3.5"
                />
                {SERVICE_FEATURE_LABELS[f]}
              </label>
            ))}
          </div>
        </div>
        <Button
          onClick={() => {
            if (save.isPending) return;
            submitOnce();
          }}
          disabled={save.isPending}
          className="w-full"
        >
          {save.isPending && <Loader2 className="mr-2 size-4 animate-spin" />} Continue
        </Button>
      </div>
    </StepShell>
  );
}

/* ---------------- Step 5: Handoff to P13 ---------------- */

function ReadyStep({ businessName, onContinue }: { businessName: string; onContinue: () => void }) {
  return (
    <StepShell
      title="Your restaurant foundation is ready"
      description={`${businessName} is created, with its first outlet and operating model in place. Now let's configure the systems you need to operate — menu, pricing, tables and payments.`}
    >
      <div className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
        <UtensilsCrossed className="size-4 text-primary" />
        You're on the Core plan — you can see what's included, and what needs an upgrade, once
        you're inside.
      </div>
      <Button onClick={onContinue} className="w-full">
        Continue setup
      </Button>
      <p className="mt-3 text-center text-xs text-muted-foreground">
        Or{" "}
        <Link to="/admin/restaurant" className="text-primary hover:underline">
          go to your restaurant overview
        </Link>{" "}
        and finish setup later.
      </p>
    </StepShell>
  );
}
