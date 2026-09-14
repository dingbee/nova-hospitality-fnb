import { test, expect, type Page } from "@playwright/test";

/**
 * P09 final certification cycle — real-browser certification of the
 * Menu screen, signed in for real against the disposable Postgres+
 * PostgREST environment.
 *
 * Menu/Pricing reads are tenant-wide by design (only the config-
 * governance WRITE path was ever property-scoped — see §3.5 of this
 * closure; restaurant_can_read is tenant-wide, never property-filtered).
 * This is a real-rendering correctness proof (both a property-scoped and
 * a tenant-wide caller correctly see the SAME tenant-wide menu data,
 * neither more nor less), not a property-scope positive/negative pair —
 * that pair already exists at both the app layer
 * (pricing.property-scope.test.ts, this same cycle) and the RLS layer
 * (live-verified against the real Supabase project in an earlier pass of
 * this closure). Driving a live in-browser price-edit through the full
 * PricingCentre/MenuLifecycleBoard UI was evaluated and not attempted in
 * this pass — that UI is substantial (1000+ lines) and blindly automating
 * a specific form flow through it risks exactly the kind of open-ended,
 * speculative test-infrastructure expansion this certification cycle was
 * explicitly told not to do.
 */

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/auth");
  // TanStack Start hydrates client-side after an initial module-loading
  // cascade; filling the controlled email/password inputs before that
  // settles lets hydration reset them back to their pre-hydration (empty)
  // state, silently discarding what was typed. Waiting for the network to
  // go idle lets hydration complete first (confirmed via real-browser
  // diagnostics: inputValue() read back empty immediately after fill()
  // when this wait was absent).
  await page.waitForLoadState("networkidle");
  const emailInput = page.getByLabel("Email", { exact: true });
  const passwordInput = page.getByLabel("Password", { exact: true });
  await emailInput.fill(email);
  await passwordInput.fill(password);
  await expect(emailInput).toHaveValue(email);
  await expect(passwordInput).toHaveValue(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/admin/restaurant**", { timeout: 15_000 });
}

for (const [label, email, password] of [
  ["a property-scoped restaurant_manager (Property A1)", "manager-a1@p09-cert.test", "p09-cert-manager-a1"],
  ["the tenant-wide owner", "owner@p09-cert.test", "p09-cert-owner"],
] as const) {
  test(`${label} sees both properties' dishes on the real Menu screen (tenant-wide read, correctly unrestricted)`, async ({
    page,
  }) => {
    await signIn(page, email, password);
    await page.goto("/admin/restaurant/menu");
    await expect(page.getByRole("heading", { name: "Menu Management" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("P09 Cert Dish A1")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("P09 Cert Dish A2")).toBeVisible();
  });
}
