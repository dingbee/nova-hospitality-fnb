import { Moon, Sun } from "lucide-react";
import { useOsTheme } from "@/hooks/use-os-theme";
export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggle } = useOsTheme();
  const dark = theme === "dark";
  return <button type="button" onClick={toggle} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"} title={dark ? "Light mode" : "Dark mode"} className={`nova-theme-toggle ${className}`}>{dark ? <Sun className="size-[18px]" aria-hidden /> : <Moon className="size-[18px]" aria-hidden />}</button>;
}
