/**
 * P10 Phase 21 — real-browser certification harness build step.
 *
 * Bundles the ACTUAL, unmodified offline module source files (db.ts,
 * device.ts, queue.ts, connectivity.ts, snapshot.ts, contracts.ts — the
 * same files the production app imports, not a reimplementation) into a
 * single browser-target ESM file, so Playwright can exercise them in real
 * Chromium IndexedDB/online-offline-event semantics rather than Node +
 * fake-indexeddb.
 *
 * Deliberately excludes auth.ts/syncEngine.ts/adapters.ts/useOfflineSync.ts
 * — those depend on the Supabase client and React, which would require
 * either a live authenticated session against production data or a large
 * new local-backend test harness. See docs/p10-offline-operations.md
 * ("Browser certification scope") for why that full path is out of scope
 * for this pass.
 *
 * Output is written to e2e/.generated (gitignored) — never committed. Run
 * as Playwright's globalSetup, so it always runs once before the static
 * server and tests start.
 */
import { buildSync } from "esbuild";
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export default function buildHarness() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..");
  const outDir = join(repoRoot, "e2e", ".generated");

  mkdirSync(outDir, { recursive: true });

  const entry = join(outDir, "harness-entry.ts");
  writeFileSync(
    entry,
    `export * as db from "@/modules/restaurant/offline/db";
export * as device from "@/modules/restaurant/offline/device";
export * as queue from "@/modules/restaurant/offline/queue";
export * as connectivity from "@/modules/restaurant/offline/connectivity";
export * as snapshot from "@/modules/restaurant/offline/snapshot";
export * as contracts from "@/modules/restaurant/offline/contracts";
`,
  );

  buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    alias: { "@": join(repoRoot, "src") },
    outfile: join(outDir, "offline-bundle.js"),
  });

  copyFileSync(join(here, "harness.html"), join(outDir, "harness.html"));

  console.log(`Real-browser offline harness built at ${outDir}`);
}
