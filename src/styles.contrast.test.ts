import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Regression coverage for the P12 Screen 6 (Readiness Centre) axe-core
// color-contrast defect: the dark `.nova-os` token block's muted text and
// danger/success soft-badge foregrounds fell below WCAG AA 4.5:1 against
// their real paired backgrounds. This asserts the corrected token values
// (and their light-theme counterparts) directly against the CSS source, so
// a future edit that reintroduces a sub-AA value fails the suite instead of
// only being caught by a live axe sweep.

const css = readFileSync(join(__dirname, "styles.css"), "utf8");

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const num = parseInt(full, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const [R, G, B] = [r, g, b].map(srgbToLinear);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function contrastRatio(hexA: string, hexB: string): number {
  const La = relativeLuminance(hexToRgb(hexA));
  const Lb = relativeLuminance(hexToRgb(hexB));
  const lighter = Math.max(La, Lb);
  const darker = Math.min(La, Lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function compositeOverHex(rgba: [number, number, number, number], bgHex: string): string {
  const [r, g, b, a] = rgba;
  const [br, bg, bb] = hexToRgb(bgHex);
  const composite = [
    Math.round(r * a + br * (1 - a)),
    Math.round(g * a + bg * (1 - a)),
    Math.round(b * a + bb * (1 - a)),
  ];
  return "#" + composite.map((x) => x.toString(16).padStart(2, "0")).join("");
}

function parseRgba(value: string): [number, number, number, number] {
  const m = value.match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)/,
  );
  if (!m) throw new Error(`Could not parse rgba() value: ${value}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] !== undefined ? Number(m[4]) : 1];
}

function extractBlock(marker: string, after = ""): string {
  const searchFrom = after ? css.indexOf(after) : 0;
  if (after && searchFrom === -1) throw new Error(`Could not find anchor: ${after}`);
  const start = css.indexOf(marker, searchFrom);
  if (start === -1) throw new Error(`Could not find CSS block starting with: ${marker}`);
  const braceStart = css.indexOf("{", start);
  const braceEnd = css.indexOf("\n}", braceStart);
  return css.slice(braceStart, braceEnd);
}

function extractVar(block: string, name: string): string {
  const m = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`Could not find --${name} in block`);
  return m[1].trim();
}

const AA_NORMAL_TEXT = 4.5;

describe("nova-os design-token color contrast (WCAG AA, normal text)", () => {
  const darkBlock = extractBlock('[data-os-theme="dark"] .nova-os {');
  const lightBlock = extractBlock(":root {", "NOVA F&B OS — COMMAND CENTER SURFACE TOKENS");

  const darkSurface2 = extractVar(darkBlock, "os-surface-2");
  const darkSurface = extractVar(darkBlock, "os-surface");

  it("dark theme: --os-ink-3 (muted text) meets AA against --os-surface-2 and --os-surface", () => {
    const ink3 = extractVar(darkBlock, "os-ink-3");
    expect(contrastRatio(ink3, darkSurface2)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrastRatio(ink3, darkSurface)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it("dark theme: --os-danger-strong (badge text) meets AA against --os-danger-soft composited on --os-surface-2", () => {
    const dangerStrong = extractVar(darkBlock, "os-danger-strong");
    const dangerSoft = parseRgba(extractVar(darkBlock, "os-danger-soft"));
    const compositedBg = compositeOverHex(dangerSoft, darkSurface2);
    expect(contrastRatio(dangerStrong, compositedBg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it("dark theme: --os-success (badge text) meets AA against --os-success-soft composited on --os-surface-2", () => {
    const success = extractVar(darkBlock, "os-success");
    const successSoft = parseRgba(extractVar(darkBlock, "os-success-soft"));
    const compositedBg = compositeOverHex(successSoft, darkSurface2);
    expect(contrastRatio(success, compositedBg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it("dark theme: --os-danger (solid destructive-button role) does not regress white-foreground contrast below its pre-existing baseline", () => {
    // --os-danger doubles as --destructive with a white foreground elsewhere
    // in the app; this fix must not touch that role. Guard against a future
    // edit accidentally lightening --os-danger itself for the badge fix.
    const danger = extractVar(darkBlock, "os-danger");
    expect(contrastRatio("#FFFFFF", danger)).toBeGreaterThanOrEqual(4.0);
  });

  it("light theme: --os-success, --os-warn, --os-info (badge text) meet AA against their soft backgrounds", () => {
    const lightSurface2 = extractVar(lightBlock, "os-surface-2");
    for (const tone of ["success", "warn", "info"] as const) {
      const fg = extractVar(lightBlock, `os-${tone}`);
      const soft = parseRgba(extractVar(lightBlock, `os-${tone}-soft`));
      const compositedBg = compositeOverHex(soft, lightSurface2);
      expect(
        contrastRatio(fg, compositedBg),
        `--os-${tone} vs its own soft background`,
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it("light theme: --os-danger badge text still meets AA (already compliant; guards against regression)", () => {
    const lightSurface2 = extractVar(lightBlock, "os-surface-2");
    const fg = extractVar(lightBlock, "os-danger");
    const soft = parseRgba(extractVar(lightBlock, "os-danger-soft"));
    const compositedBg = compositeOverHex(soft, lightSurface2);
    expect(contrastRatio(fg, compositedBg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});
