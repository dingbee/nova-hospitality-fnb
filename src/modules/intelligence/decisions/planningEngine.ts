/**
 * Sprint 5 — Planning engine.
 *
 * Turns the selected option into an ordered, approvable plan. The Intelligence
 * Core never executes these steps: the owning module or an authorised user does.
 */
import type { DecisionDomain, DecisionPlan, EvaluatedOption, PlanStep } from "./decision.types";

const ROLE_FOR: Record<DecisionDomain, string> = {
  revenue: "Revenue manager",
  demand: "Revenue manager",
  operations: "Operations manager",
  guest_experience: "Front office manager",
  marketing: "Marketing manager",
};

const VERIFY_MODULE: Record<DecisionDomain, string> = {
  revenue: "revenue",
  demand: "booking",
  operations: "operations",
  guest_experience: "guest",
  marketing: "marketing",
};

export function buildPlan(input: {
  domain: DecisionDomain;
  module: string;
  top: EvaluatedOption | null;
  horizonDays: number;
}): DecisionPlan {
  const { domain, module, top, horizonDays } = input;
  const role = ROLE_FOR[domain];

  if (!top) {
    return {
      objective: "Escalate — no option satisfied the active constraints.",
      status: "draft",
      steps: [
        {
          sequence: 1,
          title: "Escalate to management",
          objective: "Review the constraints that excluded every option.",
          module: "platform",
          responsibleRole: "General manager",
          dependsOn: null,
          requiresApproval: true,
          expectedOutcome: "A constraint is relaxed or a new option is added.",
          status: "pending",
        },
      ],
    };
  }

  const steps: PlanStep[] = [];
  let seq = 0;
  const push = (s: Omit<PlanStep, "sequence" | "status">) => {
    seq += 1;
    steps.push({ ...s, sequence: seq, status: "pending" });
  };

  push({
    title: "Review the current position",
    objective: `Confirm the evidence behind "${top.option.title}" still holds before acting.`,
    module,
    responsibleRole: role,
    dependsOn: null,
    requiresApproval: false,
    expectedOutcome: "Evidence confirmed or the decision is re-run.",
  });

  push({
    title: "Check remaining capacity",
    objective: "Verify inventory, staffing and availability can absorb the chosen option.",
    module: VERIFY_MODULE[domain],
    responsibleRole: role,
    dependsOn: 1,
    requiresApproval: false,
    expectedOutcome: "Capacity confirmed for the action window.",
  });

  for (const tactic of top.option.tactics) {
    push({
      title: tactic,
      objective: `Execute the selected option: ${top.option.summary}`,
      module,
      responsibleRole: role,
      dependsOn: seq,
      requiresApproval: true,
      expectedOutcome: `${tactic} completed as specified.`,
    });
  }

  const monitorWindow = Math.min(72, Math.max(24, horizonDays * 4));
  push({
    title: `Monitor for ${monitorWindow} hours`,
    objective: "Track booking velocity, occupancy and guest signals against the prediction.",
    module: "platform",
    responsibleRole: role,
    dependsOn: seq,
    requiresApproval: false,
    expectedOutcome: "Observed movement recorded against the prediction.",
  });

  push({
    title: "Re-evaluate and record the outcome",
    objective: "Close the loop so the Intelligence Core can learn from the result.",
    module: "platform",
    responsibleRole: role,
    dependsOn: seq,
    requiresApproval: false,
    expectedOutcome: "Outcome captured as feedback and, if durable, as memory.",
  });

  return {
    objective: `${top.option.title} — ${top.option.summary}`,
    status: "draft",
    steps,
  };
}