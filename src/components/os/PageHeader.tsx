import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="grid min-w-0 grid-cols-1 items-start gap-3 sm:flex sm:flex-wrap sm:items-end sm:justify-between sm:gap-4">
      <div className="min-w-0 max-w-full">
        <h1 className="min-w-0 max-w-full break-words font-display text-xl leading-snug text-foreground sm:truncate sm:text-2xl lg:text-3xl">
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground sm:mt-2">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </header>
  );
}
