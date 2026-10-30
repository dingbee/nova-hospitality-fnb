import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("os-card os-fade-in min-w-0 p-6", className)}>
      {(title || actions) && (
        <header className="mb-4 flex min-w-0 flex-col items-stretch gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0 flex-1">
            {title && (
              <h2 className="font-display text-xl leading-tight tracking-tight text-[color:var(--os-ink)]">
                {title}
              </h2>
            )}
            {description && (
              <p className="mt-1 text-xs text-[color:var(--os-ink-3)]">{description}</p>
            )}
          </div>
          {actions && <div className="w-full min-w-0 sm:w-auto sm:shrink-0">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
