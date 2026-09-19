import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { listMembersSchema, removeMemberSchema, upsertMemberSchema, workspaceSchema } from "./contracts";

export const getRestaurantWorkspaceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => workspaceSchema.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const mod = await import("./tenancy.server");
    return mod.getWorkspace(context.supabase, context.userId, data);
  });
export const listRestaurantMembersFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listMembersSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./members.server");
    return mod.listMembers(context.supabase, context.userId, data);
  });

export const upsertRestaurantMemberFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertMemberSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./members.server");
    return mod.upsertMember(context.supabase, context.userId, data);
  });

export const removeRestaurantMemberFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => removeMemberSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./members.server");
    return mod.removeMember(context.supabase, context.userId, data);
  });
