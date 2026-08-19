/**
 * Independence guard.
 *
 * This product must not name, link to, or authenticate against any other
 * product. The check is a test rather than a one-off script so a future
 * change cannot quietly reintroduce the coupling.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src", "standalone", "local"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".output", ".git"]);
const TEXT = /\.(ts|tsx|js|jsx|json|sql|sh|css|html|md|toml|yml|yaml)$/;

/** Names and origins that would betray a dependency on a foreign deployment. */
const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /mtoni/i, why: "references the originating customer deployment" },
  { pattern: /nvdjyvxqyfabgbaxcogu/i, why: "hard-codes a foreign backend project ref" },
  { pattern: /\.supabase\.co/i, why: "points at a hosted backend the product does not own" },
  { pattern: /lovable\.(dev|app)/i, why: "depends on the authoring platform at runtime" },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (TEXT.test(entry)) out.push(p);
  }
  return out;
}

const FILES = ROOTS.flatMap((r) => walk(r));

describe("independence", () => {
  it("scans a meaningful number of files", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  for (const { pattern, why } of FORBIDDEN) {
    it(`contains no source that ${why}`, () => {
      const hits: string[] = [];
      for (const f of FILES) {
        // The guard rails in ./nova and verify-bundle.sh mention the hosted
        // suffix in order to REFUSE it; that is the opposite of a dependency.
        if (/nova$|verify-bundle\.sh$|independence\.test\.ts$/.test(f)) continue;
        const text = readFileSync(f, "utf8");
        if (pattern.test(text)) hits.push(f);
      }
      expect(hits, `matched ${pattern}`).toEqual([]);
    });
  }

  it("ships its own product identity", async () => {
    const { PRODUCT } = await import("@/config/product");
    expect(PRODUCT.name).toBe("NOVA Hospitality F&B");
  });
});
