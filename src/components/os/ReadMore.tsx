import * as React from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * Secondary disclosure for a long block of text (spec: "Part 6 — Long
 * Detail Collapsing"). Below `previewChars`, renders the full text plain
 * — no control at all, since there's nothing to disclose. Above it, shows
 * a `previewChars`-ish leading excerpt (cut at a word boundary, never
 * mid-word) with a "Read more" toggle; the full text expands smoothly
 * beneath it via Radix Collapsible (height animation from tw-animate-css,
 * which already respects prefers-reduced-motion). Never truncates with an
 * ellipsis that discards context — the full text is always reachable.
 */
export function ReadMore({
  text,
  previewChars = 220,
  className,
}: {
  text: string;
  previewChars?: number;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);

  if (text.length <= previewChars) {
    return <p className={cn("text-sm text-foreground", className)}>{text}</p>;
  }

  const cut = text.lastIndexOf(" ", previewChars);
  const preview = text.slice(0, cut > 0 ? cut : previewChars).trimEnd();

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={className}>
      {!open && (
        <p className="text-sm text-foreground">
          {preview}
          {"… "}
          <CollapsibleTrigger className="font-medium text-primary underline-offset-2 hover:underline">
            Read more
          </CollapsibleTrigger>
        </p>
      )}
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down">
        <p className="text-sm text-foreground">{text}</p>
        <CollapsibleTrigger className="mt-1 text-xs font-medium text-primary underline-offset-2 hover:underline">
          Show less
        </CollapsibleTrigger>
      </CollapsibleContent>
    </Collapsible>
  );
}
