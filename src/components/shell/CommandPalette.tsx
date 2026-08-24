import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import type { NavGroup } from "./navigation";
export function CommandPalette({ open, onOpenChange, groups }: { open: boolean; onOpenChange: (open: boolean) => void; groups: NavGroup[] }) {
  const navigate = useNavigate();
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onOpenChange(!open); } }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onOpenChange, open]);
  return <CommandDialog open={open} onOpenChange={onOpenChange}><CommandInput placeholder="Go to a workspace, till or report…" /><CommandList><CommandEmpty>No matching workspace.</CommandEmpty>{groups.map((group) => <CommandGroup key={group.label} heading={group.label}>{group.items.map((item) => <CommandItem key={item.to} value={`${group.label} ${item.label} ${item.hint ?? ""}`} onSelect={() => { onOpenChange(false); void navigate({ to: item.to }); }} className="gap-3"><item.icon className="size-4 shrink-0" aria-hidden /><span className="flex-1 truncate">{item.label}</span>{item.hint && <span className="hidden truncate text-xs text-muted-foreground sm:block">{item.hint}</span>}</CommandItem>)}</CommandGroup>)}</CommandList></CommandDialog>;
}
