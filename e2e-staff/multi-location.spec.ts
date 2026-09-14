import { test, expect, type Page } from "@playwright/test";

/**
 * P09 final certification cycle — real-browser certification of
 * Multi-Location Command, signed in for real against the disposable
 * Postgres+PostgREST environment.
 *
 * Proves the READ-side property scope this feature has always had
 * (accessibleLocationIds, re-verified intact in §4 of this closure, not
 * rebuilt) in a real rendered page: a property-scoped caller sees only
 * their own outlet; a tenant-wide caller sees every outlet.
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

async function expandMultiLocationCommand(page: Page) {
  await page.goto("/admin/restaurant/pro-intelligence");
  const trigger = page.getByRole("button", { name: /Multi-location command/i });
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  await trigger.click();
}

test("manager-a1 (Property A1) sees only their own outlet — negative property-scope proof (Property A2 never appears)", async ({
  page,
}) => {
  await signIn(page, "manager-a1@p09-cert.test", "p09-cert-manager-a1");
  await expandMultiLocationCommand(page);

  await expect(page.getByText("P09 CERT Outlet A1")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("P09 CERT Outlet A2")).not.toBeVisible();
});

test("the tenant-wide owner sees every outlet across both properties — positive proof", async ({ page }) => {
  await signIn(page, "owner@p09-cert.test", "p09-cert-owner");
  await expandMultiLocationCommand(page);

  await expect(page.getByText("P09 CERT Outlet A1")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("P09 CERT Outlet A2")).toBeVisible();
});
