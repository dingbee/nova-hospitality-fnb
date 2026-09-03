import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { StatusChip, type StatusTone } from "./StatusChip";
import { cn } from "@/lib/utils";

export interface IntelligenceModuleProps {
  icon?: React.ReactNode;
  title: string;
  /** Concise one-liner shown collapsed — e.g. "Chicken Burger margin requires review". Never the whole payload (spec Part 4: "Do NOT display the entire intelligence payload when collapsed"). */
  headline: string;
  priorityLabel?: string;
  priorityTone?: StatusTone;
  /** Small supporting line, e.g. "2 active recommendations". */
  meta?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}

/**
 * One collapsible intelligence domain (Menu/Inventory/Kitchen/Purchasing/
 * etc.). Presentation only — computes nothing, invents nothing; callers
 * pass already-computed summary fields and the same detail content that
 * used to render unconditionally. Built on Radix Collapsible (via the
 * existing shadcn wrapper), so expand/collapse state, keyboard
 * interaction and ARIA (aria-expanded, aria-controls) are handled
 * correctly by construction — see spec Part 13. The height/opacity
 * transition comes from tw-animate-css (already imported globally),
 * which honors prefers-reduced-motion on its own.
 */
export function IntelligenceModule({
  icon,
  title,
  headline,
  priorityLabel,
  priorityTone = "neutral",
  meta,
  defaultOpen = false,
  children,
  className,
}: IntelligenceModuleProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  const contentId = React.useId();

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn("os-card os-fade-in overflow-hidden", className)}
    >
      <CollapsibleTrigger
        className="group flex w-full items-start gap-3 p-4 text-left sm:p-5"
        aria-controls={contentId}
      >
        {icon && (
          <span className="mt-0.5 shrink-0 text-[color:var(--os-ink-3)]" aria-hidden>
            {icon}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-display text-lg font-semibold tracking-tight text-[color:var(--os-ink)] group-hover:text-primary">
              {title}
            </span>
            {priorityLabel && <StatusChip tone={priorityTone}>{priorityLabel}</StatusChip>}
          </span>
          <span className="mt-1 block text-sm text-[color:var(--os-ink-2)]">{headline}</span>
          {meta && (
            <span className="mt-0.5 block text-xs text-[color:var(--os-ink-3)]">{meta}</span>
          )}
        </span>
        <span className="mt-1 flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
          {open ? "Collapse" : "Expand"}
          <ChevronDown
            className={cn("size-4 transition-transform duration-200", open && "rotate-180")}
            aria-hidden
          />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent
        id={contentId}
        className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down"
      >
        <div className="border-t border-[color:var(--os-hairline)] px-4 pb-5 pt-4 sm:px-5">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
