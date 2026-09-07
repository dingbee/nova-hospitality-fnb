/**
 * Compact POS header — deliberately NOT the standard PageHeader (2xl/3xl
 * display title + paragraph description): a till is an operational
 * workstation, not a marketing page, and every pixel spent on a headline
 * is a pixel the Floor/Bill/Menu workspace below doesn't get. Bounded to a
 * single compact row so it can never compete with the workspace for
 * vertical space, regardless of viewport height.
 */
export function PosPageHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-0 shrink-0 items-baseline justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold leading-tight text-foreground">{title}</h1>
        <p className="truncate text-xs leading-tight text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
