/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * I11 — thin per-domain adapters over the one reusable matching engine
 * (catalog/matching.ts), exactly the pattern inventory.server.ts's
 * matchInventoryItems and import/matching-adapters.ts already establish:
 * fetch tenant-scoped candidate rows, reshape into CatalogMatchCandidate[],
 * hand to matchCatalogItem. No new fuzzy-matching logic is written here.
 *
 * Menu items and locations have no SKU/barcode of their own in this app's
 * data model, so only the fuzzy-name tier of the cascade ever fires for
 * them — that's expected, not a gap.
 */
import { assertTenantRead } from "../core/access.server";
import {
  matchCatalogItem,
  type CatalogMatchCandidate,
  type CatalogMatchResult,
} from "../catalog/matching";
import type { NovaCandidate, NovaEntityMatchStatus } from "./intent.contracts";

type Sb = any;

export async function matchMenuEntities(
  sb: Sb,
  userId: string,
  input: { tenantId: string; name: string; limit?: number },
): Promise<CatalogMatchResult[]> {
  await assertTenantRead(sb, userId, input.tenantId);
  const { data, error } = await sb
    .from("restaurant_menu_items")
    .select("id, name, slug")
    .eq("tenant_id", input.tenantId)
    .eq("available", true);
  if (error) throw new Error(error.message);
  const candidates: CatalogMatchCandidate[] = ((data ?? []) as any[]).map((i) => ({
    id: i.id as string,
    sku: (i.slug as string) ?? (i.id as string),
    name: i.name as string,
  }));
  return matchCatalogItem({ name: input.name }, candidates, { limit: input.limit ?? 5 });
}

export async function matchLocationEntities(
  sb: Sb,
  userId: string,
  input: { tenantId: string; name: string; limit?: number },
): Promise<CatalogMatchResult[]> {
  await assertTenantRead(sb, userId, input.tenantId);
  const { data, error } = await sb
    .from("restaurant_locations")
    .select("id, code, name, status")
    .eq("tenant_id", input.tenantId)
    .eq("status", "active");
  if (error) throw new Error(error.message);
  const candidates: CatalogMatchCandidate[] = ((data ?? []) as any[]).map((l) => ({
    id: l.id as string,
    sku: (l.code as string) ?? (l.id as string),
    name: l.name as string,
  }));
  return matchCatalogItem({ name: input.name }, candidates, { limit: input.limit ?? 5 });
}

export interface SupplierRow {
  id: string;
  code: string | null;
  name: string;
  metadata: Record<string, unknown> | null;
}

export async function matchSupplierEntities(
  sb: Sb,
  userId: string,
  input: { tenantId: string; name: string; limit?: number },
): Promise<CatalogMatchResult[]> {
  await assertTenantRead(sb, userId, input.tenantId);
  const { data, error } = await sb
    .from("restaurant_suppliers")
    .select("id, code, name, status")
    .eq("tenant_id", input.tenantId)
    .eq("status", "active");
  if (error) throw new Error(error.message);
  const candidates: CatalogMatchCandidate[] = ((data ?? []) as any[]).map((s) => ({
    id: s.id as string,
    sku: (s.code as string) ?? (s.id as string),
    name: s.name as string,
  }));
  return matchCatalogItem({ name: input.name }, candidates, { limit: input.limit ?? 5 });
}

/** Tenant-wide "preferred supplier" flag (restaurant_suppliers.metadata.preferred) — a separate concept from a per-line named-supplier match. */
export async function listPreferredSuppliers(
  sb: Sb,
  userId: string,
  tenantId: string,
): Promise<SupplierRow[]> {
  await assertTenantRead(sb, userId, tenantId);
  const { data, error } = await sb
    .from("restaurant_suppliers")
    .select("id, code, name, status, metadata")
    .eq("tenant_id", tenantId)
    .eq("status", "active");
  if (error) throw new Error(error.message);
  return ((data ?? []) as any[])
    .filter((s) => (s.metadata as Record<string, unknown> | null)?.preferred === true)
    .map((s) => ({ id: s.id, code: s.code ?? null, name: s.name, metadata: s.metadata ?? null }));
}

export interface EntityMatchOutcome {
  status: NovaEntityMatchStatus;
  resolvedId: string | null;
  resolvedName: string | null;
  candidates: NovaCandidate[];
}

/**
 * Turns ranked matchCatalogItem() output into a resolution outcome, reusing
 * the exact ambiguity heuristic Import Studio's stage.ts:classify()
 * already established: the top two candidates within 0.05 of each other's
 * score are treated as a genuine tie — never guessed between, even when
 * the top hit is itself tier "exact" (two catalog items can both contain
 * every word of a short query).
 */
export function classifyMatchOutcome(ranked: readonly CatalogMatchResult[]): EntityMatchOutcome {
  const top = ranked[0];
  const topCandidates = (): NovaCandidate[] =>
    ranked
      .slice(0, 3)
      .filter((r) => r.score > 0)
      .map((r) => ({ id: r.candidate.id, name: r.candidate.name, score: r.score }));

  if (!top || top.score <= 0) {
    return { status: "unresolved", resolvedId: null, resolvedName: null, candidates: [] };
  }

  const runnerUp = ranked[1];
  const tie = Boolean(runnerUp && runnerUp.score > 0 && runnerUp.score >= top.score - 0.05);
  if (tie) {
    return {
      status: "ambiguous",
      resolvedId: null,
      resolvedName: null,
      candidates: topCandidates(),
    };
  }

  if (top.confidence === "exact") {
    return {
      status: "exact",
      resolvedId: top.candidate.id,
      resolvedName: top.candidate.name,
      candidates: topCandidates(),
    };
  }
  if (top.confidence === "high") {
    return {
      status: "high",
      resolvedId: top.candidate.id,
      resolvedName: top.candidate.name,
      candidates: topCandidates(),
    };
  }
  // medium/low confidence, no tie: not a case of "several plausible candidates",
  // just not confident enough to resolve — surface the weak candidates rather
  // than silently guessing.
  return {
    status: "unresolved",
    resolvedId: null,
    resolvedName: null,
    candidates: topCandidates(),
  };
}
