/**
 * Tablet-first entry shell.
 *
 * Every "New / Edit" action in Restaurant OS opens one of these: a side sheet
 * with a scrollable body and a sticky primary action, so a thumb can always
 * reach Save.
 */
import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface EntitySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  submitLabel?: string;
  onSubmit: () => void;
  pending?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  footerExtra?: React.ReactNode;
  wide?: boolean;
}

export function EntitySheet({
  open,
  onOpenChange,
  title,
  description,
  submitLabel = "Save",
  onSubmit,
  pending,
  disabled,
  children,
  footerExtra,
  wide,
}: EntitySheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn("flex w-full flex-col gap-0 p-0 sm:max-w-lg", wide && "sm:max-w-3xl")}
      >
        <SheetHeader className="border-b px-6 py-4 text-left">
          <SheetTitle>{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (!pending && !disabled) onSubmit();
          }}
        >
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">{children}</div>
          <div className="flex items-center gap-3 border-t bg-background px-6 py-4">
            {footerExtra}
            <div className="ml-auto flex gap-2">
              <Button type="button" variant="ghost" className="h-11" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" className="h-11 min-w-32" disabled={pending || disabled}>
                {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {submitLabel}
              </Button>
            </div>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

export function Field({
  label,
  hint,
  required,
  children,
  className,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="text-sm">
        {label}
        {required ? <span className="ml-0.5 text-destructive">*</span> : null}
      </Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function FieldRow({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}