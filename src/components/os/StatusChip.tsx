import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

const toneClasses: Record<StatusTone, string> = {
  success: "bg-[color:var(--os-success-soft)] text-[color:var(--os-success)]",
  warning: "bg-[color:var(--os-warn-soft)] text-[color:var(--os-warn)]",
  danger: "bg-[color:var(--os-danger-soft)] text-[color:var(--os-danger)]",
  info: "bg-[color:var(--os-info-soft)] text-[color:var(--os-info)]",
  neutral: "bg-muted text-muted-foreground",
};

export function StatusChip({
  tone = "neutral",
  children,
  className,
}: {
  tone?: StatusTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[0.65rem] font-medium uppercase tracking-[0.18em]",
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
