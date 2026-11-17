/**
 * P13 — Configuration & Readiness Centre.
 *
 * "What must I configure or fix before LexiBite is ready to operate?" —
 * answered from live rows, exactly like the Setup Workbench and P12
 * onboarding it sits alongside: never a stored progress flag, always
 * recomputed. Fixing something and coming back here re-derives the true
 * state — no page reload needed, since the underlying query is just
 * invalidated and refetched.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Check, Loader2, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip } from "@/components/os/StatusChip";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "../../ui/useRestaurantWorkspace";
import { recordOnboardingEventFn } from "../../onboarding/onboarding.functions";
import { confirmGoLiveFn, getReadinessReportFn } from "../readiness.functions";
import type { GoLiveState, ReadinessItem, ReadinessStatus } from "../contracts";

const GO_LIVE_LABEL: Record<GoLiveState, string> = {
  NOT_READY: "Not ready",
  READY_FOR_TEST: "Ready for test",
  READY_FOR_GO_LIVE: "Ready to go live",
  LIVE: "Live",
};

const GO_LIVE_TONE: Record<GoLiveState, "danger" | "warning" | "success" | "info"> = {
  NOT_READY: "danger",
  READY_FOR_TEST: "warning",
  READY_FOR_GO_LIVE: "info",
  LIVE: "success",
};

const STATUS_TONE: Record<ReadinessStatus, "success" | "danger" | "warning" | "neutral"> = {
  COMPLETE: "success",
  BLOCKED: "danger",
  WARNING: "warning",
  OPTIONAL: "neutral",
  NOT_APPLICABLE: "neutral",
};

const STATUS_LABEL: Record<ReadinessStatus, string> = {
  COMPLETE: "Complete",
  BLOCKED: "Blocked",
  WARNING: "Needs attention",
  OPTIONAL: "Optional",
  NOT_APPLICABLE: "Not needed",
};

export function ReadinessCentre() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const qc = useQueryClient();

  const fn = useServerFn(getReadinessReportFn);
  const report = useQuery({
    queryKey: ["restaurant.readiness", tenantId],
    queryFn: () => fn({ data: { tenantId: tenantId! } }),
    enabled: Boolean(tenantId),
  });

  const confirmFn = useServerFn(confirmGoLiveFn);
  const confirmGoLive = useAdminMutation({
    mutationFn: () => confirmFn({ data: { tenantId: tenantId! } }),
    successMessage: "You're live.",
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["restaurant.readiness", tenantId] }),
  });

  // §14/§20 — P12 handoff telemetry. Onboarding's "Continue setup" appends
  // `?ref=onboarding`; landing here with it present is the actual proof the
  // handoff completed (the route rendered, for this tenant), not just that
  // the button was clicked. Fires once per real arrival, never on an
  // in-app remount.
  const handoffEmittedRef = React.useRef(false);
  const recordEventFn = useServerFn(recordOnboardingEventFn);
  React.useEffect(() => {
    if (!tenantId || handoffEmittedRef.current) return;
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("ref") !== "onboarding") return;
    handoffEmittedRef.current = true;
    void recordEventFn({
      data: { tenantId, type: "restaurant.onboarding.p13_handoff.completed", payload: {} },
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const [announcement, setAnnouncement] = React.useState("");
  const prevProgress = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (
      report.data &&
      prevProgress.current !== null &&
      prevProgress.current !== report.data.progressPercent
    ) {
      setAnnouncement(`Readiness updated: ${report.data.progressPercent}% complete.`);
    }
    if (report.data) prevProgress.current = report.data.progressPercent;
  }, [report.data]);

  if (!ws.isLoading && !ws.data?.tenant) {
    return (
      <EmptyState
        title="No restaurant yet"
        description="You're not a member of a LexiBite business yet."
      />
    );
  }

  if (!tenantId || !report.data) {
    return (
      <div className="space-y-4">
        <PageHeader title="Readiness centre" description="Checking what's configured…" />
        {report.isLoading && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading readiness…
          </div>
        )}
      </div>
    );
  }

  const data = report.data;
  const revalidate = () =>
    void qc.invalidateQueries({ queryKey: ["restaurant.readiness", tenantId] });

  return (
    <div className="space-y-4">
      {/* Status changes are announced for screen-reader users without moving focus. */}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <PageHeader
        title="Readiness centre"
        description="What must be configured or fixed before LexiBite is ready to operate."
      />

      <SectionCard
        title="Overall readiness"
        description="Derived from real data — never a stored checklist."
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <StatusChip tone={GO_LIVE_TONE[data.goLiveState]}>
              {GO_LIVE_LABEL[data.goLiveState]}
            </StatusChip>
            <span className="text-sm text-muted-foreground">
              {data.criticalBlockers > 0
                ? `${data.criticalBlockers} critical blocker${data.criticalBlockers === 1 ? "" : "s"}`
                : data.highBlockers > 0
                  ? `${data.highBlockers} important item${data.highBlockers === 1 ? "" : "s"} remaining`
                  : "All critical requirements met"}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={revalidate}
            disabled={report.isFetching}
            className="min-h-11 gap-2"
          >
            <RefreshCw
              className={cn("size-4", report.isFetching && "animate-spin")}
              aria-hidden="true"
            />
            Recheck
          </Button>
        </div>
        <div className="mt-4">
          <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
            <span id="readiness-progress-label">Configuration readiness</span>
            <span>{data.progressPercent}%</span>
          </div>
          <Progress
            value={data.progressPercent}
            className="h-2"
            aria-labelledby="readiness-progress-label"
          />
        </div>
        {data.goLiveState === "READY_FOR_GO_LIVE" && (
          <div className="mt-4 rounded-md border border-primary/30 bg-primary/5 p-3">
            <p className="text-sm">
              Everything required is configured and you&apos;ve recorded a real sale. When
              you&apos;re ready, confirm go-live — this is a deliberate action, not automatic.
            </p>
            <Button
              className="mt-2 min-h-11"
              onClick={() => confirmGoLive.mutate()}
              disabled={confirmGoLive.isPending}
            >
              {confirmGoLive.isPending && (
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
              )}
              Confirm go-live
            </Button>
          </div>
        )}
        {!data.hasRecordedTestSale &&
          data.criticalBlockers === 0 &&
          data.goLiveState !== "LIVE" && (
            <p className="mt-3 text-xs text-muted-foreground">
              Record a real test sale through the POS before you can go live — configuration alone
              isn&apos;t proof it works end to end.
            </p>
          )}
      </SectionCard>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {data.items
          .filter((i) => i.domain !== "final_check")
          .map((i) => (
            <ReadinessCard key={i.domain} item={i} />
          ))}
      </div>

      <SectionCard
        title="Final readiness check"
        description="Every critical domain above, rolled into one answer."
      >
        {(() => {
          const final = data.items.find((i) => i.domain === "final_check")!;
          return (
            <div className="flex items-center gap-3">
              <StatusChip tone={STATUS_TONE[final.status]}>{STATUS_LABEL[final.status]}</StatusChip>
              <span className="text-sm text-muted-foreground">{final.currentState}</span>
            </div>
          );
        })()}
      </SectionCard>
    </div>
  );
}

function ReadinessCard({ item }: { item: ReadinessItem }) {
  const [open, setOpen] = React.useState(item.status === "BLOCKED");
  const headingId = `readiness-${item.domain}-heading`;
  return (
    <section
      aria-labelledby={headingId}
      className={cn("rounded-lg border p-4", item.status === "BLOCKED" && "border-destructive/40")}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold">
          {item.title}
        </h3>
        {item.status === "COMPLETE" ? (
          <Check className="size-4 shrink-0 text-[color:var(--os-success)]" aria-hidden="true" />
        ) : item.status === "BLOCKED" ? (
          <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
        ) : null}
      </div>
      <StatusChip tone={STATUS_TONE[item.status]} className="mt-2">
        {STATUS_LABEL[item.status]}
      </StatusChip>
      <p className="mt-2 text-xs text-muted-foreground">{item.currentState}</p>
      {item.blocker && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={`${headingId}-detail`}
          className="mt-2 min-h-11 text-left text-xs font-medium text-destructive underline underline-offset-2"
        >
          {open ? "Hide why" : "Why is this blocked?"}
        </button>
      )}
      {open && item.blocker && (
        <div
          id={`${headingId}-detail`}
          className="mt-2 space-y-1 rounded-md bg-muted/50 p-2 text-xs"
        >
          <p>{item.blocker}</p>
          {item.blockedByDependency && (
            <p className="text-muted-foreground">
              This depends on an earlier step — fix that first and this will resolve on its own.
            </p>
          )}
        </div>
      )}
      {item.fixAction && item.status !== "COMPLETE" && (
        <Button asChild size="sm" variant="outline" className="mt-3 min-h-11 w-full">
          <Link to={item.fixAction.to}>{item.fixAction.label}</Link>
        </Button>
      )}
    </section>
  );
}
