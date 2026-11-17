import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

type Tone = "green" | "gold" | "info" | "warn" | "danger" | "neutral";

const toneClass: Record<Tone, string> = {
  green: "bg-[color:var(--os-green-soft)] text-[color:var(--os-green)]",
  gold: "bg-[color:var(--os-gold-soft)] text-[color:var(--os-gold)]",
  info: "bg-[color:var(--os-info-soft)] text-[color:var(--os-info)]",
  warn: "bg-[color:var(--os-warn-soft)] text-[color:var(--os-warn)]",
  danger: "bg-[color:var(--os-danger-soft)] text-[color:var(--os-danger-strong)]",
  neutral: "bg-white/[0.04] text-[color:var(--os-ink-2)]",
};

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  trend,
  tone = "green",
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: ComponentType<{ className?: string }>;
  trend?: { value: string; positive?: boolean };
  tone?: Tone;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "os-card os-fade-in relative min-w-0 overflow-hidden p-4 sm:p-5 hover:-translate-y-[1px]",
        className,
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full opacity-[0.10] blur-2xl"
        style={{ background: "radial-gradient(closest-side, var(--os-green), transparent 70%)" }}
      />
      <div className="relative flex min-w-0 items-start gap-2">
        <p className="min-w-0 flex-1 break-words text-[0.62rem] font-medium uppercase leading-5 tracking-[0.14em] text-[color:var(--os-ink-3)] sm:text-[0.66rem] sm:tracking-[0.18em]">
          {label}
        </p>
        {Icon && (
          <span
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 ring-inset ring-white/[0.05] sm:h-9 sm:w-9",
              toneClass[tone],
            )}
          >
            <Icon className="h-4 w-4" />
          </span>
        )}
      </div>
      <p className="relative mt-4 text-[2rem] font-semibold leading-none tracking-tight text-[color:var(--os-ink)] tabular-nums sm:mt-5 sm:text-[2.4rem]">
        {value}
      </p>
      {(hint || trend) && (
        <div className="relative mt-3 flex min-w-0 items-center justify-between gap-2 sm:mt-4">
          {hint && <p className="min-w-0 text-xs text-[color:var(--os-ink-3)]">{hint}</p>}
          {trend && (
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-[0.65rem] font-medium",
                trend.positive
                  ? "bg-[color:var(--os-success-soft)] text-[color:var(--os-success)]"
                  : "bg-[color:var(--os-danger-soft)] text-[color:var(--os-danger-strong)]",
              )}
            >
              {trend.value}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
