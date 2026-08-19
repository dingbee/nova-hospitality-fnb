import { Sparkles } from "lucide-react";
import { PageHeader } from "./PageHeader";

export function ComingSoon({
  title,
  description,
  moduleName,
}: {
  title: string;
  description?: string;
  moduleName?: string;
}) {
  return (
    <div className="space-y-8">
      <PageHeader title={title} description={description} />
      <div className="flex min-h-[420px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/40 p-12 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Sparkles className="h-6 w-6" />
        </div>
        <p className="text-xs uppercase tracking-[0.28em] text-muted-foreground">Coming soon</p>
        <h2 className="mt-3 font-display text-2xl text-foreground lg:text-3xl">
          {moduleName ?? title} is on the roadmap
        </h2>
        <p className="mt-3 max-w-md text-sm text-muted-foreground">
          This module is part of NOVA Hospitality F&B and will land in an upcoming sprint. The route,
          permissions, and navigation are already in place.
        </p>
      </div>
    </div>
  );
}
