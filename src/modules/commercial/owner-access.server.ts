/* Commercial customer owner access — platform-controlled onboarding. */
import { assertCommercialAdmin } from "./access.server";
import { writeCommercialAudit } from "./audit.server";
import type {
  InviteCommercialOwnerInput,
  RevokeCommercialOwnerInvitationInput,
  ListCommercialOwnerAccessInput,
} from "./contracts";

type Sb = any;

function publicOrigin(): string {
  const configured =
    process.env.LEXIBITE_APP_ORIGIN ??
    process.env.PUBLIC_APP_URL ??
    "https://lexibite.nolmark.co";
  return configured.replace(/\/$/, "");
}

async function authUserByEmail(adminClient: any, email: string) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(error.message);
    const user = (data?.users ?? []).find(
      (u: any) => String(u.email ?? "").toLowerCase() === email.toLowerCase(),
    );
    if (user) return user;
    if ((data?.users ?? []).length < 1000) break;
  }
  return null;
}

export async function listOwnerAccess(
  sb: Sb,
  userId: string,
  input: ListCommercialOwnerAccessInput,
) {
  await assertCommercialAdmin(sb, userId);
  const admin: any = (await import("@/integrations/supabase/client.server")).supabaseAdmin;

  let q = admin
    .from("commercial_owner_invitations")
    .select("id, tenant_id, email, full_name, status, auth_user_id, invited_at, last_sent_at, accepted_at")
    .order("created_at", { ascending: false });

  if (input.tenantId) q = q.eq("tenant_id", input.tenantId);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const tenantIds = [...new Set((data ?? []).map((r: any) => r.tenant_id))];
  if (tenantIds.length === 0) return [];

  const { data: tenants, error: tenantError } = await admin
    .from("restaurant_tenants")
    .select("id, name, slug")
    .in("id", tenantIds);
  if (tenantError) throw new Error(tenantError.message);

  const names = new Map((tenants ?? []).map((t: any) => [t.id, t]));

  return (data ?? []).map((row: any) => ({
    ...row,
    tenantName: names.get(row.tenant_id)?.name ?? "Unknown customer",
    tenantSlug: names.get(row.tenant_id)?.slug ?? null,
  }));
}

export async function inviteCommercialOwner(
  sb: Sb,
  userId: string,
  input: InviteCommercialOwnerInput,
) {
  await assertCommercialAdmin(sb, userId);
  const admin: any = (await import("@/integrations/supabase/client.server")).supabaseAdmin;
  const email = input.email.trim().toLowerCase();

  const [{ data: billing, error: billingError }, { data: subscription, error: subError }] =
    await Promise.all([
      admin
        .from("commercial_billing_accounts")
        .select("commercial_status")
        .eq("tenant_id", input.tenantId)
        .maybeSingle(),
      admin
        .from("restaurant_subscriptions")
        .select("status")
        .eq("tenant_id", input.tenantId)
        .maybeSingle(),
    ]);

  if (billingError) throw new Error(billingError.message);
  if (subError) throw new Error(subError.message);
  if (billing?.commercial_status !== "active" || !["active", "trial"].includes(subscription?.status)) {
    throw new Error("Customer must have an active commercial account and active/trial subscription before owner access can be issued.");
  }

  const { data: pending } = await admin
    .from("commercial_owner_invitations")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("status", "pending")
    .maybeSingle();
  if (pending) throw new Error("This customer already has a pending owner invitation.");

  // LexiBite owner onboarding is invitation-only. Supabase's Admin Invite API
  // rejects confirmed existing accounts; do not silently convert that into a
  // direct tenant-role grant because that bypasses the intended invitation
  // boundary.
  const existing = await authUserByEmail(admin, email);
  if (existing?.confirmed_at) {
    throw new Error(
      "This email already has a confirmed LexiBite account. Use a different owner email for a new customer invitation.",
    );
  }

  const { data: invitation, error: invitationError } = await admin
    .from("commercial_owner_invitations")
    .insert({
      tenant_id: input.tenantId,
      email,
      full_name: input.fullName ?? null,
      invited_by: userId,
    })
    .select("id")
    .single();

  if (invitationError) throw new Error(invitationError.message);

  const origin = publicOrigin();
  const redirectTo = origin
    ? `${origin}/onboarding?activation=${invitation.id}`
    : undefined;

  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: input.fullName ?? null },
    ...(redirectTo ? { redirectTo } : {}),
  });

  if (inviteError) {
    await admin.from("commercial_owner_invitations").delete().eq("id", invitation.id);
    throw new Error(inviteError.message);
  }

  if (!invited.user?.id) {
    await admin.from("commercial_owner_invitations").delete().eq("id", invitation.id);
    throw new Error("Supabase created the invitation without returning an owner account.");
  }

  const { error: linkError } = await admin
    .from("commercial_owner_invitations")
    .update({ auth_user_id: invited.user.id, last_sent_at: new Date().toISOString() })
    .eq("id", invitation.id);
  if (linkError) throw new Error(linkError.message);

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "owner.invitation.sent",
    entityType: "commercial_owner_invitations",
    entityId: invitation.id,
    tenantId: input.tenantId,
    reason: `Owner invitation sent to ${email}.`,
  });

  return { mode: "invited", invitationId: invitation.id, userId: invited.user.id, email };
}

export async function revokeCommercialOwnerInvitation(
  sb: Sb,
  userId: string,
  input: RevokeCommercialOwnerInvitationInput,
) {
  await assertCommercialAdmin(sb, userId);
  const admin: any = (await import("@/integrations/supabase/client.server")).supabaseAdmin;

  const { data, error } = await admin
    .from("commercial_owner_invitations")
    .update({ status: "revoked", updated_at: new Date().toISOString() })
    .eq("id", input.invitationId)
    .eq("status", "pending")
    .select("id, tenant_id, email, auth_user_id")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("Invitation is no longer pending.");

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "owner.invitation.revoked",
    entityType: "commercial_owner_invitations",
    entityId: data.id,
    tenantId: data.tenant_id,
    reason: `Owner invitation revoked for ${data.email}.`,
  });

  return { ok: true };
}
