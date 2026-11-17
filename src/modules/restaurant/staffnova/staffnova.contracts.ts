import { z } from "zod";

/**
 * Staff Ask NOVA — a bounded conversational entry point over the restaurant's
 * OWN already-computed operational data (sales, menu, inventory, purchasing,
 * kitchen, findings, decisions). Deliberately separate from the guest Ask
 * NOVA contract (selfnova.contracts.ts): that one is unauthenticated and
 * table-scoped; this one is authenticated and tenant/capability-scoped, and
 * `authorization-gate.test.ts` must never see the two confused.
 */

const staffNovaTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(2000),
});

export const staffNovaAskSchema = z.object({
  tenantId: z.string().uuid(),
  message: z.string().min(1).max(2000),
  /** Prior turns for conversational context — client-held only, never persisted server-side, same "no new memory/storage" boundary the guest version keeps. Bounded so a long chat can't blow out the AI gateway prompt. */
  history: z.array(staffNovaTurnSchema).max(12).default([]),
});
export type StaffNovaAskInput = z.infer<typeof staffNovaAskSchema>;
