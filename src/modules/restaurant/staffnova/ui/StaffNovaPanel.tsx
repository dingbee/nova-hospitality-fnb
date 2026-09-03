import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Brain, Sparkles, Wand2, X } from "lucide-react";
import { PRODUCT } from "@/config/product";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { askStaffNovaFn } from "../staffnova.functions";
import { commitNovaPreparationFn } from "../../prepare/prepare.functions";
import { executeNovaPreparationFn, previewNovaExecutionFn } from "../../act/act.functions";
import { forgetRestaurantMemoryFn, recallRestaurantMemoryFn } from "../../memory/memory.functions";
import type { NovaIntentContract } from "../../understand/intent.contracts";
import type { NovaPreparation, NovaPreparationWorkflow } from "../../prepare/prepare.contracts";
import type { NovaExecutableWorkflow } from "../../act/act.contracts";

const STARTER_PROMPTS = [
  "What should we prepare for tomorrow?",
  "Why did food cost increase this week?",
  "Which items need replenishment?",
  "What happened to kitchen performance today?",
];

type StaffNovaTurn =
  | { id: string; role: "user"; content: string }
  | {
      id: string;
      role: "assistant";
      content: string;
      degraded: boolean;
      understanding?: NovaIntentContract;
      preparation?: NovaPreparation;
    };

/** I12: the existing route + tab each preparable workflow's draft is reviewed in — never a new NOVA-specific page. */
const WORKFLOW_ROUTE: Record<
  NovaPreparationWorkflow,
  { to: string; search?: Record<string, string> }
> = {
  purchase_request: { to: "/admin/restaurant/procurement", search: { tab: "requests" } },
  stock_transfer: { to: "/admin/restaurant/inventory-control", search: { tab: "transfers" } },
  requisition: { to: "/admin/restaurant/requisitions" },
};
const WORKFLOW_LABEL: Record<NovaPreparationWorkflow, string> = {
  purchase_request: "purchase request",
  stock_transfer: "stock transfer",
  requisition: "requisition",
};

/**
 * I12: the "Prepare & open" action. Nothing is written until this button
 * is clicked — previewNovaPreparation (already run automatically) only
 * ever classified readiness. A click calls commitNovaPreparationFn, which
 * independently re-verifies everything again server-side before creating
 * the one real (draft-status, non-operational) row; once that succeeds the
 * button becomes "Open", which only ever navigates to the EXISTING
 * workflow page — that page remains the authoritative place to review,
 * edit, and eventually submit/approve/dispatch it.
 */
function PreparationActions({
  preparation,
  contract,
  tenantId,
}: {
  preparation: NovaPreparation;
  contract: NovaIntentContract;
  tenantId: string;
}) {
  const navigate = useNavigate();
  const commitFn = useServerFn(commitNovaPreparationFn);
  const [committed, setCommitted] = useState<{
    createdRecordId: string;
    documentNumber: string | null;
  } | null>(null);

  const commit = useMutation({
    mutationFn: () => commitFn({ data: { tenantId, contract } }),
    networkMode: "always",
    onSuccess: (result) => {
      if (result.createdRecordId) {
        setCommitted({
          createdRecordId: result.createdRecordId,
          documentNumber: result.documentNumber,
        });
      }
    },
  });

  if (!preparation.workflow) return null;
  const label = WORKFLOW_LABEL[preparation.workflow];
  const route = WORKFLOW_ROUTE[preparation.workflow];

  if (committed) {
    return (
      <div className="mt-2 space-y-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => navigate({ to: route.to, search: route.search })}
        >
          Open {label}
          {committed.documentNumber ? ` (${committed.documentNumber})` : ""}
        </Button>
        {EXECUTABLE_WORKFLOWS.includes(preparation.workflow) && (
          <ExecutionActions
            workflow={preparation.workflow as NovaExecutableWorkflow}
            recordId={committed.createdRecordId}
            tenantId={tenantId}
          />
        )}
      </div>
    );
  }

  if (preparation.readiness !== "ready" && preparation.readiness !== "ready_with_warnings") {
    return <p className="mt-2 text-xs text-muted-foreground">{preparation.message}</p>;
  }

  return (
    <div className="mt-2 space-y-1">
      {preparation.warnings.map((w) => (
        <p key={w} className="text-xs text-muted-foreground">
          {w}
        </p>
      ))}
      <Button type="button" size="sm" disabled={commit.isPending} onClick={() => commit.mutate()}>
        {commit.isPending ? "Preparing…" : `Prepare & open ${label}`}
      </Button>
      {commit.isError && (
        <p className="text-xs text-destructive">
          Something went wrong preparing this — please try again.
        </p>
      )}
    </div>
  );
}

const EXECUTABLE_WORKFLOWS: readonly NovaPreparationWorkflow[] = ["stock_transfer"];

/**
 * I13 — the "Execute" confirmation boundary. Only rendered once I12 has
 * already committed a real draft (never before, per spec section 4: a user
 * message must never reach a mutation without this explicit confirmation
 * step). Fetches a fresh, re-verified preview on mount/retry — never
 * trusts the chat turn's stale preparation snapshot — and the Execute
 * button itself calls executeNovaPreparationFn, which re-verifies
 * everything again server-side before touching anything (see
 * act.server.ts). Failure never hides behind a generic error: the
 * server's own operational-language message is shown verbatim.
 */
function ExecutionActions({
  workflow,
  recordId,
  tenantId,
}: {
  workflow: NovaExecutableWorkflow;
  recordId: string;
  tenantId: string;
}) {
  const previewFn = useServerFn(previewNovaExecutionFn);
  const executeFn = useServerFn(executeNovaPreparationFn);
  const [reviewing, setReviewing] = useState(false);

  const preview = useMutation({
    mutationFn: () => previewFn({ data: { tenantId, workflow, recordId } }),
    networkMode: "always",
  });
  const execute = useMutation({
    mutationFn: () => executeFn({ data: { tenantId, workflow, recordId } }),
    networkMode: "always",
  });

  if (execute.data) {
    return execute.data.ok ? (
      <div className="mt-2 rounded-md border border-green-600/30 bg-green-600/10 px-2 py-1.5 text-xs whitespace-pre-line text-foreground">
        {execute.data.message}
      </div>
    ) : (
      <p className="mt-2 text-xs text-destructive">{execute.data.message}</p>
    );
  }

  if (!reviewing) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-2"
        onClick={() => {
          setReviewing(true);
          preview.mutate();
        }}
      >
        Review & execute
      </Button>
    );
  }

  if (preview.isPending || !preview.data) {
    return <p className="mt-2 text-xs text-muted-foreground">Checking…</p>;
  }

  if (preview.data.readiness !== "ready") {
    return <p className="mt-2 text-xs text-muted-foreground">{preview.data.message}</p>;
  }

  return (
    <div className="mt-2 space-y-1 rounded-md border px-2 py-1.5">
      <p className="text-xs font-medium">
        Ready to execute this stock movement:
        {preview.data.sourceLocationName && preview.data.destinationLocationName
          ? ` ${preview.data.sourceLocationName} → ${preview.data.destinationLocationName}`
          : ""}
      </p>
      <ul className="text-xs text-muted-foreground">
        {preview.data.lines.map((l) => (
          <li key={l.inventoryItemId}>
            • {l.inventoryItemName} — {l.quantity}
          </li>
        ))}
      </ul>
      {preview.data.warnings.map((w) => (
        <p key={w} className="text-xs text-amber-600">
          {w}
        </p>
      ))}
      <div className="flex gap-1.5 pt-1">
        <Button type="button" size="sm" variant="ghost" onClick={() => setReviewing(false)}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={execute.isPending}
          onClick={() => execute.mutate()}
        >
          {execute.isPending ? "Executing…" : "Execute movement"}
        </Button>
      </div>
    </div>
  );
}

function newTurnId() {
  return Math.random().toString(36).slice(2);
}

/**
 * I11: the small "Understanding" card shown instead of a plain answer when
 * a staff message was classified as an operational instruction rather
 * than a question — reuses this panel's own chat bubble, no new UI
 * surface. The summary text alone (content) already states everything
 * resolved/missing/ambiguous in plain English; this only adds a visual
 * label plus, when present, the concrete list of unresolved candidates so
 * a manager can see at a glance what still needs clarifying.
 */
function UnderstandingBadgeAndCandidates({ understanding }: { understanding: NovaIntentContract }) {
  const needsClarification =
    understanding.ambiguities.length > 0 || understanding.missingInformation.length > 0;
  return (
    <div className="mb-1.5 space-y-1.5">
      <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <Wand2 className="size-3" aria-hidden />
        Understanding{needsClarification ? " — needs clarification" : ""}
      </div>
      {understanding.ambiguities.map((a) => (
        <div key={a.field} className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
          {a.candidates.length > 0
            ? `Did you mean: ${a.candidates.map((c) => c.name).join(", ")}?`
            : a.reason}
        </div>
      ))}
    </div>
  );
}

/**
 * I15 — "what NOVA remembers", deliberately compact (spec: not a
 * complicated memory dashboard). Lists this tenant's shared operating
 * memory plus the signed-in staff member's own personal memory (never
 * another staff member's — recallRestaurantMemoryFn already enforces
 * that server-side) with a one-click Forget per row. Forgetting marks the
 * row dismissed server-side, never a hard delete.
 */
function MemoryPanel({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const recallFn = useServerFn(recallRestaurantMemoryFn);
  const forgetFn = useServerFn(forgetRestaurantMemoryFn);
  const queryClient = useQueryClient();
  const queryKey = ["staff-nova-memory", tenantId];

  const memories = useQuery({
    queryKey,
    queryFn: () => recallFn({ data: { tenantId, limit: 20 } }),
  });

  const forget = useMutation({
    mutationFn: (memoryId: string) => forgetFn({ data: { tenantId, memoryId } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  return (
    <div className="mb-2 rounded-md border bg-card p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1 text-xs font-medium">
          <Brain className="size-3" aria-hidden /> What {PRODUCT.aiName} remembers
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      {memories.isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
      {memories.data && memories.data.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Nothing remembered yet. Tell {PRODUCT.aiName} a preference and it can remember it here.
        </p>
      )}
      <ul className="space-y-1">
        {(memories.data ?? []).map((m) => (
          <li
            key={m.id}
            className="flex items-start justify-between gap-2 rounded bg-muted/50 px-1.5 py-1 text-xs"
          >
            <span>
              <span className="mr-1 rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">
                {m.scope === "user" ? "Personal" : "Restaurant"}
              </span>
              {m.memoryValue}
            </span>
            <button
              type="button"
              disabled={forget.isPending}
              onClick={() => forget.mutate(m.id)}
              className="shrink-0 text-muted-foreground hover:text-destructive"
            >
              Forget
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Staff Ask NOVA — a bounded conversational panel over this tenant's own
 * already-computed operational data. See staffnova.server.ts for the
 * grounding/security design. This component owns only chat UI state
 * (turns, input text) — nothing here is persisted, matching guest Ask
 * NOVA's own client-held-only conversation model.
 */
export function StaffNovaPanel({
  open,
  onOpenChange,
  tenantId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
}) {
  const askFn = useServerFn(askStaffNovaFn);
  const [turns, setTurns] = useState<StaffNovaTurn[]>([]);
  const [input, setInput] = useState("");
  const [memoryOpen, setMemoryOpen] = useState(false);

  const ask = useMutation({
    mutationFn: (message: string) => {
      const history = turns.map((t) => ({ role: t.role, content: t.content }));
      return askFn({ data: { tenantId, message, history } });
    },
    networkMode: "always",
    onSuccess: (result) => {
      setTurns((t) => [
        ...t,
        {
          id: newTurnId(),
          role: "assistant",
          content: result.answer,
          degraded: result.degraded,
          understanding: result.understanding,
          preparation: result.preparation,
        },
      ]);
    },
    onError: () => {
      setTurns((t) => [
        ...t,
        {
          id: newTurnId(),
          role: "assistant",
          content: `Something went wrong reaching ${PRODUCT.aiName}. Please try again.`,
          degraded: true,
        },
      ]);
    },
  });

  const send = (message: string) => {
    const text = message.trim();
    if (!text || ask.isPending) return;
    setTurns((t) => [...t, { id: newTurnId(), role: "user", content: text }]);
    setInput("");
    ask.mutate(text);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center justify-between gap-1.5">
            <span className="flex items-center gap-1.5">
              <Sparkles className="size-4 text-primary" aria-hidden /> Ask {PRODUCT.aiName}
            </span>
            <button
              type="button"
              onClick={() => setMemoryOpen((v) => !v)}
              className="flex items-center gap-1 text-xs font-normal text-muted-foreground hover:text-foreground"
            >
              <Brain className="size-3.5" aria-hidden /> Memory
            </button>
          </SheetTitle>
        </SheetHeader>

        {memoryOpen && <MemoryPanel tenantId={tenantId} onClose={() => setMemoryOpen(false)} />}

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto py-2">
          {turns.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Ask about sales, menu performance, inventory, purchasing, kitchen performance, or
              current findings and decisions for this restaurant. {PRODUCT.aiName} only answers
              from this restaurant's own data — if it doesn't have what you're asking for, it'll
              say so.
            </p>
          )}
          {turns.map((t) =>
            t.role === "user" ? (
              <div
                key={t.id}
                className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-3 py-2 text-sm text-primary-foreground"
              >
                {t.content}
              </div>
            ) : (
              <div
                key={t.id}
                className={`mr-auto max-w-[90%] rounded-2xl rounded-tl-sm border px-3 py-2 text-sm ${
                  t.degraded ? "bg-muted text-muted-foreground" : "bg-card"
                }`}
              >
                {t.understanding && (
                  <UnderstandingBadgeAndCandidates understanding={t.understanding} />
                )}
                {t.content}
                {t.preparation && t.understanding && (
                  <PreparationActions
                    preparation={t.preparation}
                    contract={t.understanding}
                    tenantId={tenantId}
                  />
                )}
              </div>
            ),
          )}
          {ask.isPending && (
            <div className="mr-auto max-w-[90%] rounded-2xl rounded-tl-sm border bg-card px-3 py-2 text-sm text-muted-foreground">
              Thinking…
            </div>
          )}
        </div>

        {turns.length === 0 && (
          <div className="flex flex-wrap gap-1.5 pb-2">
            {STARTER_PROMPTS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => send(s)}
                className="min-h-9 rounded-full border px-3 text-xs text-foreground"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <form
          className="flex items-center gap-2 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Ask ${PRODUCT.aiName} about your restaurant…`}
            maxLength={2000}
            className="h-11"
          />
          <Button type="submit" disabled={ask.isPending || !input.trim()} className="h-11">
            Send
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}
