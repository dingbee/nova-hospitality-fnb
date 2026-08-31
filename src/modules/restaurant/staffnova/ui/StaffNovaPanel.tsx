import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { Sparkles, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { askStaffNovaFn } from "../staffnova.functions";
import type { NovaIntentContract } from "../../understand/intent.contracts";

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
    };

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
        },
      ]);
    },
    onError: () => {
      setTurns((t) => [
        ...t,
        {
          id: newTurnId(),
          role: "assistant",
          content: "Something went wrong reaching NOVA. Please try again.",
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
          <SheetTitle className="flex items-center gap-1.5">
            <Sparkles className="size-4 text-primary" aria-hidden /> Ask NOVA
          </SheetTitle>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto py-2">
          {turns.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Ask about sales, menu performance, inventory, purchasing, kitchen performance, or
              current findings and decisions for this restaurant. NOVA only answers from this
              restaurant's own data — if it doesn't have what you're asking for, it'll say so.
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
            placeholder="Ask NOVA about your restaurant…"
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
