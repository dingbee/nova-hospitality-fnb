import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  listMemberStationAssignmentsSchema,
  listMembersSchema,
  removeMemberSchema,
  setMemberStationAssignmentSchema,
  upsertMemberSchema,
  workspaceSchema,
} from "./contracts";
import { setPosPinSchema, clearPosPinSchema } from "../sales/pos-session.contracts";

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

export const listMemberStationAssignmentsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listMemberStationAssignmentsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./members.server");
    return mod.listMemberStationAssignments(context.supabase, context.userId, data);
  });

export const setMemberStationAssignmentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setMemberStationAssignmentSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./members.server");
    return mod.setMemberStationAssignment(context.supabase, context.userId, data);
  });


export const setStaffPosPinFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setPosPinSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("../sales/pos-session.server");
    return mod.setPosPin(context.supabase, context.userId, data);
  });

export const clearStaffPosPinFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => clearPosPinSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("../sales/pos-session.server");
    return mod.clearPosPin(context.supabase, context.userId, data);
  });
