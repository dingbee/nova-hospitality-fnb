/* eslint-disable @typescript-eslint/no-explicit-any -- server function payloads are untyped at this boundary. */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { CheckCircle2, Play, Scale, XCircle } from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip } from "@/components/os/StatusChip";
import { Button } from "@/components/ui/button";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import {
  getRestaurantDecisionBoardFn,
  runRestaurantDecisionPassFn,
} from "@/modules/restaurant/decisions/decisions.functions";
import { decideDecisionFn, updatePlanStepFn } from "@/modules/intelligence/decisions/decision.functions";

export const Route = createFileRoute("/_authenticated/admin/restaurant/decisions")({
  head: () => ({
    meta: [
      { title: "Restaurant Decisions — Restaurant & Bar OS" },
      {
        name: "description",
        content:
          "Findings become predictions, options, plans and approvals inside the NOVA decision engine.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: RestaurantDecisionsPage,
});

const RISK_TONE: Record<string, "neutral" | "info" | "warning" | "danger"> = {
  info: "neutral",
  low: "info",
  medium: "warning",
  high: "danger",
  critical: "danger",
};

const STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "danger" | "info"> = {
  proposed: "info",
  approved: "success",
  modified: "warning",
  rejected: "danger",
  executing: "warning",
  completed: "success",
  failed: "danger",
  expired: "neutral",
};

function OptionRows({ options, selectedKey }: { options: any[]; selectedKey: string | null }) {
  return (
    <ul className="space-y-2">
      {options.map((o) => {
        const isPick = o.option.key === selectedKey;
        return (
          <li
            key={o.option.key}
            className={`rounded-lg border p-3 text-sm ${isPick ? "border-[color:var(--os-success)]/50 bg-[color:var(--os-success-soft)]/30" : "bg-card/30"} ${o.excluded ? "opacity-60" : ""}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">
                {o.rank}. {o.option.title}
              </span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                score {Math.round(o.finalScore * 100)}
                {o.penalty > 0 ? ` (−${Math.round(o.penalty * 100)} penalty)` : ""}
                {isPick ? <StatusChip tone="success">Recommended</StatusChip> : null}
                {o.excluded ? <StatusChip tone="danger">Excluded</StatusChip> : null}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{o.option.summary}</p>
            {(o.strengths?.length || o.tradeOffs?.length) > 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {[...(o.strengths ?? []), ...(o.tradeOffs ?? [])].join(" · ")}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function Reasoning({ d }: { d: any }) {
  return (
    <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
      <p>
        <span className="text-foreground">What is happening: </span>
        {d.reasoning?.whatIsHappening}
      </p>
      <p>
        <span className="text-foreground">What is likely: </span>
        {d.reasoning?.whatIsLikely}
      </p>
      <p className="sm:col-span-2">
        <span className="text-foreground">Why this option: </span>
        {d.reasoning?.whySelected}
      </p>
      {d.risks?.length ? (
        <p className="sm:col-span-2">
          <span className="text-foreground">What could go wrong: </span>
          {d.risks.join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

function RestaurantDecisionsPage() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id as string | undefined;
  const [windowDays, setWindowDays] = useState(30);
  const qc = useQueryClient();

  const boardFn = useServerFn(getRestaurantDecisionBoardFn);
  const passFn = useServerFn(runRestaurantDecisionPassFn);
  const decideFn = useServerFn(decideDecisionFn);
  const stepFn = useServerFn(updatePlanStepFn);

  const queryKey = ["restaurant", "decisions", tenantId, windowDays];
  const board = useQuery({
    queryKey,
    queryFn: () => boardFn({ data: { tenantId: tenantId as string, windowDays, includeStored: true } }),
    enabled: Boolean(tenantId),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey });

  const runPass = useAdminMutation({
    mutationFn: () => passFn({ data: { tenantId: tenantId as string, windowDays, persist: true } }),
    successMessage: "Decision pass complete",
    onSuccess: invalidate,
  });
  const decide = useAdminMutation({
    mutationFn: (vars: { id: string; decision: "approved" | "rejected" | "completed" }) =>
      decideFn({ data: vars }),
    successMessage: "Decision recorded",
    onSuccess: invalidate,
  });
  const advanceStep = useAdminMutation({
    mutationFn: (vars: { stepId: string; status: "in_progress" | "done" }) => stepFn({ data: vars }),
    successMessage: "Plan step updated",
    onSuccess: invalidate,
  });

  const data = board.data as any;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Restaurant Decisions"
        description="Finding → prediction → options → plan → approval → action → outcome. Scoring is deterministic and every option considered is shown, including the ones ruled out."
        actions={
          <div className="flex flex-wrap items-center gap-1">
            {[14, 30, 60].map((w) => (
              <Button
                key={w}
                size="sm"
                variant={w === windowDays ? "default" : "outline"}
                onClick={() => setWindowDays(w)}
              >
                {w}d
              </Button>
            ))}
            <Button size="sm" onClick={() => runPass.mutate(undefined)} disabled={!tenantId || runPass.isPending}>
              <Play className="mr-1.5 size-4" /> Run decision pass
            </Button>
          </div>
        }
      />

      {data?.headline ? (
        <p className="rounded-lg border bg-card/40 p-3 text-sm text-muted-foreground">{data.headline}</p>
      ) : null}

      <SectionCard
        title="Proposed decisions"
        description="Freshly evaluated from current findings. Running a pass records them for approval."
      >
        {(data?.candidates ?? []).length === 0 ? (
          <EmptyState
            title="Nothing needs a decision"
            description="No finding in this window crossed a decision threshold."
            icon={Scale}
          />
        ) : (
          <div className="space-y-4">
            {(data.candidates as any[]).map(({ finding, decision }) => (
              <div key={decision.key} className="rounded-xl border p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">{decision.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{finding.headline}</p>
                  </div>
                  <span className="flex items-center gap-2">
                    <StatusChip tone={RISK_TONE[decision.riskLevel] ?? "neutral"}>
                      {decision.riskLevel} risk
                    </StatusChip>
                    <StatusChip>{Math.round(decision.confidence * 100)}% confidence</StatusChip>
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{finding.prediction.statement}</p>
                <div className="mt-3">
                  <OptionRows options={decision.options} selectedKey={decision.recommendedOptionKey} />
                </div>
                <div className="mt-3">
                  <Reasoning d={decision} />
                </div>
                <ol className="mt-3 space-y-1 text-xs text-muted-foreground">
                  {(decision.plan?.steps ?? []).map((s: any) => (
                    <li key={s.sequence}>
                      {s.sequence}. {s.title} — {s.responsibleRole}
                      {s.requiresApproval ? " (approval required)" : ""}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Recorded decisions"
        description="Persisted in the Intelligence Core ledger. Approving creates an action for the owning module; completing records the outcome and feeds learning."
      >
        {(data?.stored ?? []).length === 0 ? (
          <EmptyState title="No recorded decisions" description="Run a decision pass to record the proposals above." />
        ) : (
          <div className="space-y-4">
            {(data.stored as any[]).map((d) => (
              <div key={d.id} className="rounded-xl border p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">{d.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{d.trigger}</p>
                  </div>
                  <span className="flex items-center gap-2">
                    <StatusChip tone={STATUS_TONE[d.status] ?? "neutral"}>{d.status}</StatusChip>
                    <StatusChip tone={RISK_TONE[d.riskLevel] ?? "neutral"}>{d.riskLevel} risk</StatusChip>
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{d.reasoning?.whySelected}</p>

                {d.planSteps?.length ? (
                  <ul className="mt-3 space-y-1 text-xs">
                    {d.planSteps.map((s: any) => (
                      <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-muted-foreground">
                          {s.sequence}. {s.title}
                        </span>
                        <span className="flex items-center gap-1">
                          <StatusChip tone={s.status === "done" ? "success" : "neutral"}>{s.status}</StatusChip>
                          {s.status !== "done" ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={advanceStep.isPending}
                              onClick={() =>
                                advanceStep.mutate({
                                  stepId: s.id,
                                  status: s.status === "in_progress" ? "done" : "in_progress",
                                })
                              }
                            >
                              {s.status === "in_progress" ? "Mark done" : "Start"}
                            </Button>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <div className="mt-3 flex flex-wrap gap-2">
                  {d.status === "proposed" ? (
                    <>
                      <Button
                        size="sm"
                        disabled={decide.isPending}
                        onClick={() => decide.mutate({ id: d.id, decision: "approved" })}
                      >
                        <CheckCircle2 className="mr-1.5 size-4" /> Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={decide.isPending}
                        onClick={() => decide.mutate({ id: d.id, decision: "rejected" })}
                      >
                        <XCircle className="mr-1.5 size-4" /> Reject
                      </Button>
                    </>
                  ) : null}
                  {d.status === "approved" || d.status === "executing" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate({ id: d.id, decision: "completed" })}
                    >
                      Record outcome as completed
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}