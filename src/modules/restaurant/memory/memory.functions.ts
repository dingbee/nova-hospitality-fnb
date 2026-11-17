import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  correctRestaurantMemorySchema,
  forgetRestaurantMemorySchema,
  recallRestaurantMemorySchema,
  rememberRestaurantMemorySchema,
  submitRestaurantMemoryFeedbackSchema,
} from "./memory.contracts";

/** Only ever called after an explicit human confirmation — a direct staff statement, or a "Remember this?" click on an AI-proposed candidate. See memory.server.ts's file doc comment for the authority limit every reader of this data must respect. */
export const rememberRestaurantMemoryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => rememberRestaurantMemorySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./memory.server");
    return mod.rememberRestaurantMemory(context.supabase, context.userId, data);
  });

/** Returns only the caller's own personal memory plus this tenant's shared memory — never another staff member's personal rows (enforced in memory.server.ts, not just here). */
export const recallRestaurantMemoryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => recallRestaurantMemorySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./memory.server");
    return mod.recallRestaurantMemory(context.supabase, context.userId, data);
  });

/** Marks a memory dismissed — never a hard delete. */
export const forgetRestaurantMemoryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => forgetRestaurantMemorySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./memory.server");
    return mod.forgetRestaurantMemory(context.supabase, context.userId, data);
  });

/** Updates a memory's value in place — never appends a second, contradicting row. */
export const correctRestaurantMemoryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => correctRestaurantMemorySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./memory.server");
    return mod.correctRestaurantMemory(context.supabase, context.userId, data);
  });

export const submitRestaurantMemoryFeedbackFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => submitRestaurantMemoryFeedbackSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./memory.server");
    return mod.submitRestaurantMemoryFeedback(context.supabase, context.userId, data);
  });
