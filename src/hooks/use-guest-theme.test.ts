import { describe, expect, it } from "vitest";
import { parseStoredThemePreference, resolveIsDark } from "./use-guest-theme";

describe("parseStoredThemePreference", () => {
  it("accepts each of the three real preferences", () => {
    expect(parseStoredThemePreference("light")).toBe("light");
    expect(parseStoredThemePreference("dark")).toBe("dark");
    expect(parseStoredThemePreference("system")).toBe("system");
  });

  it("treats a missing value (never chosen) as 'system' — follow the device by default", () => {
    expect(parseStoredThemePreference(null)).toBe("system");
    expect(parseStoredThemePreference(undefined)).toBe("system");
  });

  it("treats a corrupted/stale/unrecognised stored value as 'system' rather than throwing or guessing", () => {
    expect(parseStoredThemePreference("")).toBe("system");
    expect(parseStoredThemePreference("blue")).toBe("system");
    expect(parseStoredThemePreference("Dark")).toBe("system"); // case-sensitive on purpose — no silent normalisation
    expect(parseStoredThemePreference('{"theme":"dark"}')).toBe("system");
  });
});

describe("resolveIsDark", () => {
  it("'dark' is always dark, regardless of the device", () => {
    expect(resolveIsDark("dark", true)).toBe(true);
    expect(resolveIsDark("dark", false)).toBe(true);
  });

  it("'light' is always light, regardless of the device", () => {
    expect(resolveIsDark("light", true)).toBe(false);
    expect(resolveIsDark("light", false)).toBe(false);
  });

  it("'system' defers entirely to the device's own preference", () => {
    expect(resolveIsDark("system", true)).toBe(true);
    expect(resolveIsDark("system", false)).toBe(false);
  });
});
