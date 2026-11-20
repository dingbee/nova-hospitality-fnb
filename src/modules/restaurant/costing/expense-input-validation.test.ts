/* eslint-disable @typescript-eslint/no-explicit-any -- minimal fake Supabase boundary. */
/**
 * Regression: several validators used the regex literal /^\\d{4}-\\d{2}-\\d{2}$/,
 * which matches a literal backslash followed by "d" and therefore rejected
 * every real ISO date. Operational-expense creation, edit and recurring
 * schedule create/update/generation all failed validation before reaching
 * authorization or the database. These tests drive the real server functions
 * with valid input and assert they get past validation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ assertCapability: vi.fn() }));
vi.mock("../core/access.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/access.server")>()),
  assertCapability: (...args: unknown[]) => mocks.assertCapability(...args),
}));

const {
  createOperationalExpense,
  updateOperationalExpense,
  createRecurringExpenseSchedule,
  generateRecurringExpenseOccurrence,
} = await import("./costing.server");

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const CATEGORY = "33333333-3333-4333-8333-333333333333";
const EXPENSE = "44444444-4444-4444-8444-444444444444";
const SCHEDULE = "55555555-5555-4555-8555-555555555555";

/** Any DB access means validation passed; stop there with a sentinel. */
const REACHED = "reached-authorization";
const sb: any = { from: () => ({}) };

beforeEach(() => {
  mocks.assertCapability.mockReset();
  mocks.assertCapability.mockRejectedValue(new Error(REACHED));
});

const expense = {
  tenantId: TENANT,
  categoryId: CATEGORY,
  description: "Generator diesel",
  amount: 125000,
  currency: "TZS",
  incurredOn: "2026-11-20",
};

describe("operational-expense date validation accepts real ISO dates", () => {
  it("createOperationalExpense", async () => {
    await expect(createOperationalExpense(sb, USER, expense)).rejects.toThrow(REACHED);
  });

  it("updateOperationalExpense", async () => {
    await expect(
      updateOperationalExpense(sb, USER, { ...expense, expenseId: EXPENSE }),
    ).rejects.toThrow(REACHED);
  });

  it("createRecurringExpenseSchedule (nextOccurrence and endsOn)", async () => {
    await expect(
      createRecurringExpenseSchedule(sb, USER, {
        ...expense,
        cadence: "monthly",
        nextOccurrence: "2026-12-01",
        endsOn: "2027-12-01",
      } as any),
    ).rejects.toThrow(REACHED);
  });

  it("generateRecurringExpenseOccurrence", async () => {
    const reads: any = {
      select: () => reads,
      eq: () => reads,
      single: async () => {
        throw new Error(REACHED);
      },
    };
    await expect(
      generateRecurringExpenseOccurrence({ from: () => reads }, USER, {
        tenantId: TENANT,
        scheduleId: SCHEDULE,
        occurrenceDate: "2026-12-01",
      }),
    ).rejects.toThrow(REACHED);
  });

  it("still rejects malformed dates", async () => {
    await expect(
      createOperationalExpense(sb, USER, { ...expense, incurredOn: "20-11-2026" }),
    ).rejects.toThrow(/incurredOn|Invalid/);
    await expect(
      createOperationalExpense(sb, USER, { ...expense, incurredOn: "\\dddd-\\dd-\\dd" }),
    ).rejects.toThrow(/incurredOn|Invalid/);
    expect(mocks.assertCapability).not.toHaveBeenCalled();
  });
});

describe("server-function contracts keep fields the UI sends", () => {
  it("createOperationalExpense keeps supplierId and draft status (were stripped)", async () => {
    const { createOperationalExpenseInputSchema } = await import("./costing.contracts");
    const parsed = createOperationalExpenseInputSchema.parse({
      ...expense,
      supplierId: "66666666-6666-4666-8666-666666666666",
      expenseStatus: "draft",
    });
    expect(parsed).toMatchObject({
      supplierId: "66666666-6666-4666-8666-666666666666",
      expenseStatus: "draft",
      incurredOn: "2026-11-20",
    });
    expect(createOperationalExpenseInputSchema.parse(expense).expenseStatus).toBe("recorded");
    expect(
      createOperationalExpenseInputSchema.safeParse({ ...expense, expenseStatus: "approved" })
        .success,
    ).toBe(false);
  });

  it("createOperationalExpenseCategory keeps parentCategoryId (was stripped)", async () => {
    const { createOperationalExpenseCategoryInputSchema } = await import("./costing.contracts");
    expect(
      createOperationalExpenseCategoryInputSchema.parse({
        tenantId: TENANT,
        name: "Diesel",
        categoryKey: "sub_diesel",
        parentCategoryId: CATEGORY,
      }).parentCategoryId,
    ).toBe(CATEGORY);
  });
});
