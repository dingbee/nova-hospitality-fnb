import { useCallback, useEffect, useState } from "react";

export type GuestThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "nova.guest.theme";

/** Pure — no DOM/localStorage. A value that isn't one of the three real preferences (missing key, corrupted storage, a stale value from a future version) is treated identically to "never chosen": follow the device. */
export function parseStoredThemePreference(raw: string | null | undefined): GuestThemePreference {
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  return "system";
}

/** Pure — the actual light/dark resolution rule, exercised directly in tests without needing a DOM: "dark" is dark, "light" is light, "system" defers entirely to the device's own preference. */
export function resolveIsDark(pref: GuestThemePreference, systemPrefersDark: boolean): boolean {
  if (pref === "dark") return true;
  if (pref === "light") return false;
  return systemPrefersDark;
}

function readStoredPreference(): GuestThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    return parseStoredThemePreference(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private browsing / storage disabled — falls back to "system" silently.
    return "system";
  }
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Guest Portal light/dark/system theme — a per-device display preference
 * only, entirely separate from:
 *  - the admin/staff OS theme (use-os-theme.ts's data-os-theme attribute,
 *    scoped to .nova-os and never touched here), and
 *  - every guest security/session mechanism (selforder-recovery.ts) — this
 *    is stored under its own localStorage key, never read for
 *    authorization, and never table/session-scoped. Losing this preference
 *    (private browsing, cleared storage) never affects ordering.
 *
 * Applies by toggling the literal `dark` class on <html> — the same
 * selector Tailwind's `dark:` variant and this project's own light/dark CSS
 * variable pairs in styles.css already key off
 * (`@custom-variant dark (&:is(.dark *));`, previously defined but unused).
 * <html> is used rather than a wrapper scoped to this route's own JSX,
 * because Radix/vaul portals (the Drawer/Dialog content used throughout the
 * guest order page) render as children of <body>, outside wherever this
 * route's own tree sits in the DOM — only a shared ancestor of <body> can
 * theme them via CSS cascade.
 */
export function useGuestTheme() {
  const [preference, setPreference] = useState<GuestThemePreference>("system");
  const [hydrated, setHydrated] = useState(false);

  const apply = useCallback((pref: GuestThemePreference) => {
    document.documentElement.classList.toggle("dark", resolveIsDark(pref, systemPrefersDark()));
  }, []);

  useEffect(() => {
    const stored = readStoredPreference();
    setPreference(stored);
    apply(stored);
    setHydrated(true);

    const mql = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onChange = () => {
      // Re-reads the current stored preference rather than closing over
      // `stored`, so this stays correct even if the guest changed their
      // choice since mount — only matters while actually following system.
      if (readStoredPreference() === "system") apply("system");
    };
    mql?.addEventListener?.("change", onChange);

    return () => {
      mql?.removeEventListener?.("change", onChange);
      // Never leave the guest-portal-only class applied once this route is
      // gone — restores <html> exactly as this route found it. The admin
      // app's own theming (data-os-theme/.nova-os) never reads this class,
      // so this is a belt-and-suspenders cleanup, not a correctness fix.
      document.documentElement.classList.remove("dark");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- apply has no deps (stable); only ever want to hydrate once on mount
  }, []);

  const setTheme = useCallback(
    (pref: GuestThemePreference) => {
      setPreference(pref);
      apply(pref);
      try {
        window.localStorage.setItem(STORAGE_KEY, pref);
      } catch {
        // See readStoredPreference — a write failure is never surfaced to the guest.
      }
    },
    [apply],
  );

  return { theme: preference, hydrated, setTheme };
}
