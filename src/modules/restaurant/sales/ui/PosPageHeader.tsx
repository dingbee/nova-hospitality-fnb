import { useEffect, useMemo, useState } from "react";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import { DEFAULT_TIMEZONE } from "@/modules/restaurant/core/product";

/**
 * Live date/time, formatted in the property's own operational timezone
 * (never the browser's) so a cashier's clock always reads local service
 * time regardless of where the device itself is set. Ticks on a plain
 * interval — a real clock, not a value computed once at first render — and
 * falls back to DEFAULT_TIMEZONE (the same Africa/Dar_es_Salaam default
 * PropertiesPanel/BusinessPanel already use) until the property record has
 * loaded or when none is configured.
 */
function useLiveClock(timeZone: string) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone,
      }),
    [timeZone],
  );
  const timeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone,
      }),
    [timeZone],
  );
  return { date: dateFormatter.format(now), time: timeFormatter.format(now) };
}

/**
 * Compact POS header — deliberately NOT the standard PageHeader (2xl/3xl
 * display title + paragraph description): a till is an operational
 * workstation, not a marketing page, and every pixel spent on a headline
 * is a pixel the Floor/Bill/Menu workspace below doesn't get. Bounded to a
 * single compact row so it can never compete with the workspace for
 * vertical space, regardless of viewport height.
 */
export function PosPageHeader({ title, description }: { title: string; description: string }) {
  // Deduped with PosWorkspace's own useRestaurantWorkspace() call below it —
  // same react-query cache key, so this never issues a second request.
  const ws = useRestaurantWorkspace();
  const timeZone = ws.data?.properties?.[0]?.timezone || DEFAULT_TIMEZONE;
  const clock = useLiveClock(timeZone);

  return (
    <div className="flex min-h-0 shrink-0 items-baseline justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold leading-tight text-foreground">{title}</h1>
        <p className="truncate text-xs leading-tight text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-xs font-medium leading-tight text-foreground">{clock.date}</p>
        <p className="text-sm font-semibold leading-tight tabular-nums text-foreground">
          {clock.time}
        </p>
      </div>
    </div>
  );
}
