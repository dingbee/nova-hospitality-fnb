import { Check } from "lucide-react";
import { SERVICE_STAGES, STAGE_LABEL, type LifecycleState } from "./lifecycle";

/**
 * The service story, always visible: Table → Order → Production → Service →
 * Bill → Payment → Receipt → Closed. Purely a read-out of derived state.
 */
export function ServiceLifecycleBar({ life, compact = false }: { life: LifecycleState; compact?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1" aria-label="Service lifecycle">
      {SERVICE_STAGES.map((stage, i) => {
        const done = i < life.stageIndex;
        const current = i === life.stageIndex;
        return (
          <span
            key={stage}
            className={[
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
              current
                ? life.delayed
                  ? "border-destructive/50 bg-destructive/10 font-semibold text-destructive"
                  : "border-primary/50 bg-primary/10 font-semibold text-primary"
                : done
                  ? "border-border bg-muted text-muted-foreground"
                  : "border-dashed border-border text-muted-foreground/60",
              compact && !current && !done ? "hidden sm:inline-flex" : "",
            ].join(" ")}
            aria-current={current ? "step" : undefined}
          >
            {done && <Check className="size-3" />}
            {STAGE_LABEL[stage]}
          </span>
        );
      })}
    </div>
  );
}