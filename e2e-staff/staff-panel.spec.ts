import { test, expect, type Page } from "@playwright/test";

/**
 * P09 final certification cycle — real-browser certification of Staff
 * Panel, signed in for real against the disposable Postgres+PostgREST
 * environment (see e2e-staff/support/ and playwright.staff.config.ts).
 *
 * Proves the actual property-scope defect this closure fixed (§3.1):
 * changing a member's role requires the actor to be scoped to that
 * member's own property (or hold a tenant-wide grant if the target row
 * is itself tenant-wide). manager-a1 is restaurant_manager scoped to
 * Property A1 only.
 */

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/auth");
  // TanStack Start hydrates client-side after an initial module-loading
  // cascade; filling the controlled email/password inputs before that
  // settles lets hydration reset them back to their pre-hydration (empty)
  // state, silently discarding what was typed. Waiting for the network to
  // go idle lets hydration complete first.
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

test("manager-a1 (Property A1) CAN change a same-property colleague's role — positive property-scope proof", async ({
  page,
}) => {
  await signIn(page, "manager-a1@p09-cert.test", "p09-cert-manager-a1");
  await page.goto("/admin/restaurant/staff");
  await expect(page.getByRole("heading", { name: "Staff & roles" })).toBeVisible();

  // staff-a1 (dde7526a-...) is the same-property viewer — its row's role
  // <select> is labeled "Role for <user_id>".
  const staffA1Select = page.getByLabel("Role for dde7526a-f217-4859-97b2-78283ddb400d");
  await expect(staffA1Select).toBeVisible();
  await staffA1Select.selectOption("chef");

  // A real, successful write: useAdminMutation's own success toast.
  await expect(page.getByText("Role updated.")).toBeVisible({ timeout: 10_000 });
});

test("manager-a1 (Property A1) CANNOT change the tenant-wide owner's role — negative property-scope proof, the core §3.1 escalation this closure fixed", async ({
  page,
}) => {
  await signIn(page, "manager-a1@p09-cert.test", "p09-cert-manager-a1");
  await page.goto("/admin/restaurant/staff");
  await expect(page.getByRole("heading", { name: "Staff & roles" })).toBeVisible();

  const ownerSelect = page.getByLabel("Role for 7e498502-fcdc-4da7-b1a0-5b3dabdd3dd4");
  await expect(ownerSelect).toBeVisible();
  await ownerSelect.selectOption("general_manager");

  // A real, server-rejected write surfaces as an error toast, not a
  // silent success — and the row must still show the ORIGINAL role,
  // proving the database was never actually changed.
  await expect(page.getByText(/forbidden|not granted/i)).toBeVisible({ timeout: 10_000 });
  await page.reload();
  await expect(page.getByLabel("Role for 7e498502-fcdc-4da7-b1a0-5b3dabdd3dd4")).toHaveValue("owner");
});

test("the tenant-wide owner CAN change any member's role, including the tenant-wide grant itself", async ({
  page,
}) => {
  await signIn(page, "owner@p09-cert.test", "p09-cert-owner");
  await page.goto("/admin/restaurant/staff");
  await expect(page.getByRole("heading", { name: "Staff & roles" })).toBeVisible();

  const managerSelect = page.getByLabel("Role for 24ac1cc3-ac6b-402f-bd5b-87830636a644");
  await expect(managerSelect).toBeVisible();
  await managerSelect.selectOption("general_manager");
  await expect(page.getByText("Role updated.")).toBeVisible({ timeout: 10_000 });
});
