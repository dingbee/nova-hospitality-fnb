/**
 * Build-provenance gate for every NOVA bundle, hosted or appliance.
 *
 * Vite inlines `import.meta.env.VITE_*` at build time. A bundle built in a
 * shell that still carries someone else's backend credentials silently ships
 * that origin — the source tree stays clean while the artefact points at a
 * foreign database. This check reads the artefact, not the source.
 *
 * The appliance has its own stricter gate (local/scripts/verify-bundle.sh);
 * this one is runtime-agnostic and runs from `bun run verify:bundle`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = process.argv[2] ?? "dist";

/** A real hosted project ref is exactly 20 lowercase alphanumerics. */
const HOSTED_ORIGIN = /https:\/\/[a-z0-9]{20}\.supabase\.(co|in)/g;
const FOREIGN_BRAND = /mtoni|lovable\.app|lovable\.dev/gi;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs|json|html|css|map)$/.test(p)) out.push(p);
  }
  return out;
}

const findings: string[] = [];
for (const file of walk(DIST)) {
  const text = readFileSync(file, "utf8");
  for (const m of new Set(text.match(HOSTED_ORIGIN) ?? [])) {
    findings.push(`${file}: hosted backend origin baked into the bundle -> ${m}`);
  }
  for (const m of new Set(text.match(FOREIGN_BRAND) ?? [])) {
    findings.push(`${file}: foreign product reference -> ${m}`);
  }
}

if (findings.length > 0) {
  console.error("FATAL: bundle provenance check failed.\n");
  for (const f of findings.slice(0, 20)) console.error("  " + f);
  console.error(
    "\nThe build environment supplied a foreign backend. Clear VITE_SUPABASE_*/SUPABASE_*" +
      " from the shell (or set this product's own values) and rebuild.",
  );
  process.exit(1);
}
console.log(`Bundle provenance OK — no foreign backend origin or product reference in ${DIST}.`);
