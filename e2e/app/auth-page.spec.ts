import { test, expect } from "@playwright/test";

/**
 * P09 — real-browser certification of `/auth`, the actual unmodified
 * production sign-in screen (src/routes/auth.tsx). Every admin/enterprise
 * workflow this closure touched (Staff Panel, Multi-Location Command,
 * config governance, import) sits behind this same screen. See
 * playwright.auth.config.ts for why this route needs no backend or
 * mocking at all. Deliberately never submits the form — see that config's
 * own comment for why a real submit is intentionally out of scope here.
 */

test("renders with no console errors, and every field is reachable and labeled", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  await page.goto("/auth");

  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Create an account" })).toBeVisible();

  // Real label association, not just visual proximity — getByLabel only
  // matches a genuinely programmatically-associated control (here, the
  // wrapper-label pattern src/routes/auth.tsx actually uses).
  const email = page.getByLabel("Email", { exact: true });
  const password = page.getByLabel("Password", { exact: true });
  await expect(email).toBeVisible();
  await expect(password).toBeVisible();
  await expect(email).toHaveAttribute("type", "email");
  await expect(password).toHaveAttribute("type", "password");
  await expect(email).toHaveAttribute("required", "");
  await expect(password).toHaveAttribute("required", "");

  expect(consoleErrors, `console/page errors: ${consoleErrors.join("\n")}`).toEqual([]);
});

test("every control is reachable in order by keyboard alone, and real typing lands in the field", async ({
  page,
}) => {
  await page.goto("/auth");

  const email = page.getByLabel("Email", { exact: true });
  const password = page.getByLabel("Password", { exact: true });
  const submit = page.getByRole("button", { name: "Sign in" });
  const signUpLink = page.getByRole("link", { name: "Create an account" });

  await email.click();
  await expect(email).toBeFocused();
  await page.keyboard.type("owner@example.test");
  await expect(email).toHaveValue("owner@example.test");

  await page.keyboard.press("Tab");
  await expect(password).toBeFocused();
  await page.keyboard.type("a-real-password");
  await expect(password).toHaveValue("a-real-password");

  await page.keyboard.press("Tab");
  await expect(submit).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(signUpLink).toBeFocused();
});

test("password field masks input (type=password, never plain text)", async ({ page }) => {
  await page.goto("/auth");
  const password = page.getByLabel("Password", { exact: true });
  await password.fill("should-never-be-visible-as-plain-text");
  await expect(password).toHaveAttribute("type", "password");
});
