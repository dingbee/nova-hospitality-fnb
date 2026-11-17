import type { ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";

export type ActionStage =
  | "recommend" | "preview" | "review" | "confirm" | "create"
  | "submit" | "approve" | "receive" | "complete";

const STAGES: Array<{ key: ActionStage; label: string }> = [
  { key: "recommend", label: "Recommend" },
  { key: "preview", label: "Preview" },
  { key: "review", label: "Review" },
  { key: "confirm", label: "Confirm" },
  { key: "create", label: "Create" },
  { key: "submit", label: "Submit" },
  { key: "approve", label: "Approve" },
  { key: "receive", label: "Receive" },
  { key: "complete", label: "Complete" },
];

export function ActionWorkspace({
  stage, title, summary, children,
}: { stage: ActionStage; title: string; summary?: string; children: ReactNode }) {
  const current = STAGES.findIndex((item) => item.key === stage);
  const visible = STAGES.slice(0, Math.min(current + 2, STAGES.length));
  return (
    <section className="mt-2 overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="border-b bg-muted/20 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-foreground">{title}</p>
            {summary && <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{summary}</p>}
          </div>
          <span className="shrink-0 rounded-full border bg-background px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{STAGES[current]?.label}</span>
        </div>
        <div className="mt-2 flex items-center gap-1 overflow-x-auto pb-0.5">
          {visible.map((item, index) => {
            const done = index < current;
            const active = index === current;
            return (
              <div key={item.key} className="flex shrink-0 items-center gap-1">
                <span className={"flex size-5 items-center justify-center rounded-full border text-[9px] " + (done ? "bg-primary text-primary-foreground" : active ? "border-primary text-primary" : "text-muted-foreground")}>
                  {done ? <Check className="size-3" aria-hidden /> : index + 1}
                </span>
                <span className={"text-[9px] font-medium " + (active ? "text-foreground" : "text-muted-foreground")}>{item.label}</span>
                {index < visible.length - 1 && <ChevronRight className="size-3 text-muted-foreground/60" aria-hidden />}
              </div>
            );
          })}
        </div>
      </div>
      <div className="px-3 py-2.5">{children}</div>
    </section>
  );
}
