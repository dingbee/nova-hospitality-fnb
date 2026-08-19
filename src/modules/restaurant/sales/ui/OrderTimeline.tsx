/* eslint-disable @typescript-eslint/no-explicit-any -- server rows are untyped at this boundary. */
import { orderTimeline, type LifecycleInput } from "./lifecycle";

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** Chronological evidence of the service, read from timestamps already stored. */
export function OrderTimeline(props: LifecycleInput) {
  const entries = orderTimeline(props);
  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground">No service events recorded yet.</p>;
  }
  return (
    <ol className="space-y-1.5 text-xs">
      {entries.map((e, i) => (
        <li key={`${e.at}-${i}`} className="flex gap-2">
          <span className="tabular-nums text-muted-foreground">{time(e.at)}</span>
          <span className="min-w-0">
            <span className="block font-medium">{e.label}</span>
            {e.detail && <span className="block text-muted-foreground">{e.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}