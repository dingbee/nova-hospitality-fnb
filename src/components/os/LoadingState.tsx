import { LexiBiteLoader } from "@/components/brand/LexiBiteLoader";

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-[18px] border border-border bg-[color:var(--os-surface)]/40 py-10 text-sm text-muted-foreground">
      <LexiBiteLoader size="sm" label={label} showLabel />
    </div>
  );
}
