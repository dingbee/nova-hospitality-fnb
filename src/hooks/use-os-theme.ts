import { useCallback, useEffect, useState } from "react";
export type OsTheme = "light" | "dark";
const STORAGE_KEY = "nova.os.theme";
const DEFAULT_THEME: OsTheme = "dark";
function read(): OsTheme {
  if (typeof document === "undefined") return DEFAULT_THEME;
  try { const stored = window.localStorage.getItem(STORAGE_KEY); if (stored === "light" || stored === "dark") return stored; } catch {}
  return document.documentElement.getAttribute("data-os-theme") === "light" ? "light" : DEFAULT_THEME;
}
export function useOsTheme() {
  const [theme, setTheme] = useState<OsTheme>(DEFAULT_THEME);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { const next = read(); setTheme(next); setHydrated(true); document.documentElement.setAttribute("data-os-theme", next); }, []);
  const apply = useCallback((next: OsTheme) => { setTheme(next); document.documentElement.setAttribute("data-os-theme", next); try { window.localStorage.setItem(STORAGE_KEY, next); } catch {} }, []);
  const toggle = useCallback(() => apply(theme === "dark" ? "light" : "dark"), [apply, theme]);
  return { theme, hydrated, setTheme: apply, toggle };
}
