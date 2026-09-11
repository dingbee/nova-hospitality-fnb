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
  recordOnboardingEventFn,
  setOperatingModelFn,
} from "@/modules/restaurant/onboarding/onboarding.functions";
import {
  BUSINESS_TYPES,
  BUSINESS_TYPE_LABELS,
  COUNTRIES,
  OPERATING_MODES,
  OPERATING_MODE_LABELS,
  SERVICE_FEATURES,
  SERVICE_FEATURE_LABELS,
  type BusinessType,
  type Country,
  type OnboardingEventType,
  type OperatingMode,
  type ServiceFeature,
} from "@/modules/restaurant/onboarding/contracts";

/**
 * §20 — one hook, reused by every step, wrapping the telemetry server fn.
 * Best-effort by design: a telemetry failure is swallowed here (in
 * addition to being swallowed server-side by `emitRestaurantEvent`) so it
 * can never surface as a user-facing error or block a step transition.
 */
function useEmitOnboarding() {
  const fn = useServerFn(recordOnboardingEventFn);
  return (
    tenantId: string,
    type: OnboardingEventType,
    payload: Record<string, string | number | boolean | null> = {},
    occurredAt?: string,
  ) => {
    void fn({ data: { tenantId, type, payload, occurredAt } }).catch(() => {});
  };
}

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
      {/* §19 — announces each step transition to screen-reader users without moving focus. */}
      <div role="status" aria-live="polite" className="sr-only">
        {stepLabel} — {percent}% complete
      </div>
      <div
        aria-hidden="true"
        className="flex items-center justify-between text-xs text-muted-foreground"
      >
        <span>{stepLabel}</span>
        <span>{percent}% complete</span>
      </div>
      <Progress value={percent} aria-hidden="true" className="mt-2 h-1.5" />
    </div>
  );
}

function OnboardingPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const ws = useRestaurantWorkspace();
  const tenant = ws.data?.tenant ?? null;
  const emit = useEmitOnboarding();

  const statusFn = useServerFn(getOnboardingStatusFn);
  const status = useQuery({
    queryKey: ["onboarding.status", tenant?.id],
    queryFn: () => statusFn({ data: { tenantId: tenant!.id } }),
    enabled: Boolean(tenant?.id),
  });

  // §10/§20 — did this browser tab already have a tenant the very first
  // time the workspace resolved? Only that shape of arrival is a genuine
  // *resume* — landing here moments after creating the business in this
  // same session is forward progress, not a return visit.
  const hadTenantOnMountRef = useRef<boolean | null>(null);
  const resumedEmittedRef = useRef(false);
  const completedEmittedRef = useRef(false);
  useEffect(() => {
    if (!ws.isLoading && hadTenantOnMountRef.current === null) {
      hadTenantOnMountRef.current = Boolean(tenant);
    }
  }, [ws.isLoading, tenant]);

  // Resumable navigation: once we know the tenant's true stage, land there
  // — never restart the wizard, never re-show a step whose data already
  // exists.
  const [step, setStep] = useState<Step | null>(null);
  useEffect(() => {
    if (!tenant) {
      setStep(null); // no tenant yet -> the "create your business" screen below.
      return;
    }
    if (status.data) {
      setStep(status.data.stage as Step);
      if (
        hadTenantOnMountRef.current === true &&
        !resumedEmittedRef.current &&
        status.data.stage !== "ready"
      ) {
        resumedEmittedRef.current = true;
        emit(tenant.id, "restaurant.onboarding.resumed", { stage: status.data.stage });
      }
      if (status.data.stage === "ready" && !completedEmittedRef.current) {
        completedEmittedRef.current = true;
        emit(tenant.id, "restaurant.onboarding.completed", {});
      }
    }
    // `emit` is stable across renders (useServerFn/useCallback identity); omitting it
    // avoids re-running this effect on every render while still calling the latest closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant, status.data]);

  // §7 — new account, no tenant yet: welcome + business creation.
  if (!ws.isLoading && !tenant) {
    return (
      <WelcomeAndBusinessStep
        onCreated={(tenantId) => {
          void qc.invalidateQueries({ queryKey: ["restaurant.workspace"] });
          hadTenantOnMountRef.current = false; // this tenant was just created — never a "resume".
          void tenantId;
        }}
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
        onContinue={() => {
          emit(tenant!.id, "restaurant.onboarding.p13_handoff.initiated", {});
          navigate({ to: "/admin/restaurant/setup", search: { ref: "onboarding" } });
        }}
      />
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10 text-foreground">
      {children}
    </main>
  );
}

/* ---------------- Step 1: Welcome + business creation ---------------- */

function WelcomeAndBusinessStep({ onCreated }: { onCreated: (tenantId: string) => void }) {
  const navigate = useNavigate();
  const bootstrapFn = useServerFn(bootstrapTenantFn);
  const emit = useEmitOnboarding();
  const [name, setName] = useState("");
  const [businessType, setBusinessType] = useState<BusinessType>("restaurant");
  const [country, setCountry] = useState<Country>("Tanzania");

  // §20 — this screen IS "entered" and "welcome_viewed"; both are captured
  // once, at the true moment they happened, and flushed after the tenant
  // that will scope them exists (see the module doc comment on
  // `recordOnboardingEventSchema`). "business.started" captures real
  // intent — the first field interaction — not just the page rendering.
  const [enteredAt] = useState(() => new Date().toISOString());
  const startedAtRef = useRef<string | null>(null);
  const markStarted = () => {
    if (!startedAtRef.current) startedAtRef.current = new Date().toISOString();
  };

  const create = useAdminMutation({
    mutationFn: () =>
      bootstrapFn({
        data: {
          name: name.trim(),
          businessType,
          country,
          currency: "TZS",
          timezone: "Africa/Dar_es_Salaam",
        },
      }),
    successMessage: "Your restaurant is created.",
    onSuccess: (data) => {
      const tenantId = data.tenantId;
      emit(tenantId, "restaurant.onboarding.entered", {}, enteredAt);
      emit(tenantId, "restaurant.onboarding.welcome_viewed", {}, enteredAt);
      emit(
        tenantId,
        "restaurant.onboarding.business.started",
        { businessType },
        startedAtRef.current ?? enteredAt,
      );
      emit(tenantId, "restaurant.onboarding.business.completed", { businessType, country });
      onCreated(tenantId);
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
              onChange={(e) => {
                markStarted();
                setName(e.target.value);
              }}
              placeholder="e.g. Kilimanjaro Grill"
              className="mt-2 w-full rounded-md border bg-background px-4 py-3 text-sm outline-none focus:border-primary"
            />
          </label>
          <div role="radiogroup" aria-label="What kind of business is it?">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              What kind of business is it?
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {BUSINESS_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={businessType === t}
                  onClick={() => {
                    markStarted();
                    setBusinessType(t);
                  }}
                  className={`min-h-11 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
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
          <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Which country do you operate in?
            <select
              value={country}
              onChange={(e) => {
                markStarted();
                setCountry(e.target.value as Country);
              }}
              className="mt-2 min-h-11 w-full rounded-md border bg-background px-4 py-3 text-sm outline-none focus:border-primary"
            >
              {COUNTRIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] font-normal normal-case text-muted-foreground">
              This decides which local requirements — like Tanzania's TRA receipt rules — apply to
              your setup.
            </span>
          </label>
          <Button
            type="submit"
            disabled={create.isPending || name.trim().length < 2}
            className="min-h-11 w-full"
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
  const emit = useEmitOnboarding();
  const [propertyName, setPropertyName] = useState(businessName);
  const [outletName, setOutletName] = useState(businessName);

  // §20 — fires once per real mount of this step (a re-render from typing
  // doesn't remount it), so "started" reflects genuinely arriving here.
  const startedEmittedRef = useRef(false);
  useEffect(() => {
    if (startedEmittedRef.current) return;
    startedEmittedRef.current = true;
    emit(tenantId, "restaurant.onboarding.property.started", {});
    emit(tenantId, "restaurant.onboarding.outlet.started", {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const create = useAdminMutation({
    mutationFn: () =>
      createFn({
        data: { tenantId, propertyName: propertyName.trim(), outletName: outletName.trim() },
      }),
    successMessage: "Your outlet is ready.",
    onSuccess: () => {
      emit(tenantId, "restaurant.onboarding.property.completed", {});
      emit(tenantId, "restaurant.onboarding.outlet.completed", {});
      onCreated();
    },
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
          className="min-h-11 w-full"
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
  const emit = useEmitOnboarding();
  const [mode, setMode] = useState<OperatingMode>("table_service");
  const [features, setFeatures] = useState<ServiceFeature[]>(["kitchen"]);

  const viewedEmittedRef = useRef(false);
  useEffect(() => {
    if (viewedEmittedRef.current) return;
    viewedEmittedRef.current = true;
    emit(tenantId, "restaurant.onboarding.operating_model.viewed", {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const save = useAdminMutation({
    mutationFn: () => setFn({ data: { tenantId, operatingMode: mode, serviceFeatures: features } }),
    successMessage: "Operating model saved.",
    onSuccess: () => {
      emit(tenantId, "restaurant.onboarding.operating_model.selected", {
        operatingMode: mode,
        featureCount: features.length,
      });
      onSaved();
    },
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
        <div role="radiogroup" aria-label="Service style">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Service style
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {OPERATING_MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                className={`min-h-11 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
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
        <fieldset>
          <legend className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Also using
          </legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {SERVICE_FEATURES.map((f) => (
              <label
                key={f}
                className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors ${
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
        </fieldset>
        <Button
          onClick={() => {
            if (save.isPending) return;
            submitOnce();
          }}
          disabled={save.isPending}
          className="min-h-11 w-full"
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
      <Button onClick={onContinue} className="min-h-11 w-full">
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
