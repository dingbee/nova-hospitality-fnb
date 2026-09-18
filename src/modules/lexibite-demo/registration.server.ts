/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * LexiBite Demo Access — registration (P02.2).
 *
 * This is a pre-authentication write path: there is no signed-in user yet,
 * so unlike every other write in this codebase it cannot go through RLS.
 * It always runs against the service-role client (never exposed to the
 * client bundle — see src/integrations/supabase/client.server.ts) and never
 * trusts anything from the caller beyond the validated request body.
 *
 * Verification reuses Supabase Auth itself (admin.generateLink) rather than
 * inventing a token table: the returned action link is Supabase's own
 * signed, single-use, expiring token. Delivery reuses the product's
 * existing generic email adapter (src/lib/notifications/adapters.server.ts)
 * — the same one commercial notifications and receipts already send
 * through — rather than depending on Supabase's own SMTP configuration,
 * which nothing else in this product uses.
 */
import type { z } from "zod";
import { sendEmail, emailConfigured } from "@/lib/notifications/adapters.server";
import { DEMO_RATE_LIMITS, DEMO_REGISTRATION_STATUS, DEMO_SOURCE } from "./constants";
import type { RegisterDemoProspectResult, registerDemoProspectSchema } from "./contracts";

type Sb = any;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function activateRedirectUrl(origin: string): string {
  return `${origin}/lexibite/demo/activate`;
}

function verificationEmail(firstName: string, actionLink: string) {
  const subject = "Your LexiBite demo is ready to verify";
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1a1a1a">
<h2 style="margin:0 0 12px">Hi ${escapeHtml(firstName)},</h2>
<p>Thanks for requesting a LexiBite demo. Confirm your email to launch your own guided session of the real product — Kilimanjaro Grill, a working restaurant &amp; bar running on LexiBite.</p>
<p style="margin:24px 0"><a href="${actionLink}" style="background:#111;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">Verify &amp; launch demo</a></p>
<p style="color:#666;font-size:13px">This link is single-use and expires. If you didn't request this, you can ignore this email.</p>
</body></html>`;
  const text = `Hi ${firstName},\n\nConfirm your email to launch your LexiBite demo:\n${actionLink}\n\nIf you didn't request this, you can ignore this email.`;
  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

async function issueVerificationLink(
  admin: Sb,
  email: string,
  origin: string,
  hasExistingUser: boolean,
): Promise<{ actionLink: string; userId: string }> {
  const redirectTo = activateRedirectUrl(origin);
  const { data, error } = await admin.auth.admin.generateLink(
    hasExistingUser
      ? { type: "magiclink", email, options: { redirectTo } }
      : {
          type: "invite",
          email,
          options: { redirectTo, data: { demo: true, source: DEMO_SOURCE } },
        },
  );
  if (error || !data?.properties?.action_link || !data?.user?.id) {
    throw new Error(error?.message ?? "Could not generate a verification link.");
  }
  return { actionLink: data.properties.action_link as string, userId: data.user.id as string };
}

export async function registerDemoProspect(
  admin: Sb,
  input: z.infer<typeof registerDemoProspectSchema>,
  meta: { ip: string | null; origin: string },
): Promise<RegisterDemoProspectResult> {
  const normalized = normalizeEmail(input.workEmail);
  const ipHash = meta.ip ? await hashIp(meta.ip) : null;

  if (ipHash) {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await admin
      .from("lexibite_demo_registrations")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ipHash)
      .gte("created_at", since);
    if ((count ?? 0) >= DEMO_RATE_LIMITS.MAX_REGISTRATIONS_PER_IP_PER_HOUR) {
      return {
        status: "error",
        registrationId: null,
        message: "Too many demo requests from this network. Please try again later.",
      };
    }
  }

  const { data: existing } = await admin
    .from("lexibite_demo_registrations")
    .select("id, status")
    .eq("work_email_normalized", normalized)
    .maybeSingle();

  if (existing) {
    return {
      status: "already_registered",
      registrationId: existing.id,
      message:
        existing.status === "pending_verification"
          ? "You've already requested a demo — check your email, or request a new link."
          : "You already have LexiBite demo access. Check your email for the launch link, or sign in.",
    };
  }

  const { data: inserted, error: insertErr } = await admin
    .from("lexibite_demo_registrations")
    .insert({
      first_name: input.firstName,
      last_name: input.lastName,
      work_email: input.workEmail,
      work_email_normalized: normalized,
      company: input.company,
      job_role: input.role,
      country: input.country,
      phone: input.phone ?? null,
      source: DEMO_SOURCE,
      status: DEMO_REGISTRATION_STATUS.PENDING_VERIFICATION,
      ip_hash: ipHash,
    })
    .select("id")
    .single();

  if (insertErr || !inserted) {
    // Race: two concurrent requests for the same email. Treat the second as
    // "already registered" rather than surfacing a raw constraint error.
    if (insertErr && /duplicate key/i.test(insertErr.message)) {
      return {
        status: "already_registered",
        registrationId: null,
        message: "You've already requested a demo — check your email.",
      };
    }
    return {
      status: "error",
      registrationId: null,
      message: "Couldn't register your demo request. Please try again.",
    };
  }

  try {
    const { actionLink, userId } = await issueVerificationLink(
      admin,
      input.workEmail,
      meta.origin,
      false,
    );
    await admin
      .from("lexibite_demo_registrations")
      .update({ auth_user_id: userId, verification_sent_at: new Date().toISOString() })
      .eq("id", inserted.id);

    if (emailConfigured()) {
      const { subject, html, text } = verificationEmail(input.firstName, actionLink);
      await sendEmail({
        to: input.workEmail,
        subject,
        html,
        text,
        idempotencyKey: `demo-verify-${inserted.id}`,
      });
    }
  } catch (e) {
    await admin
      .from("lexibite_demo_registrations")
      .update({ status: DEMO_REGISTRATION_STATUS.ERROR })
      .eq("id", inserted.id);
    return {
      status: "error",
      registrationId: inserted.id,
      message:
        "Registered, but we couldn't send your verification email. Please request a new link.",
    };
  }

  return {
    status: "verification_required",
    registrationId: inserted.id,
    message: "Check your email to verify and launch your LexiBite demo.",
  };
}

export async function resendDemoVerification(
  admin: Sb,
  workEmail: string,
  meta: { origin: string },
): Promise<RegisterDemoProspectResult> {
  const normalized = normalizeEmail(workEmail);
  const { data: reg } = await admin
    .from("lexibite_demo_registrations")
    .select("id, first_name, status, verification_resend_count, verification_sent_at, auth_user_id")
    .eq("work_email_normalized", normalized)
    .maybeSingle();

  if (!reg) {
    // Do not reveal whether an email is registered (avoids enumeration).
    return {
      status: "verification_required",
      registrationId: null,
      message: "If that email has a pending demo request, a new link has been sent.",
    };
  }

  if (reg.verification_resend_count >= DEMO_RATE_LIMITS.MAX_RESENDS) {
    return {
      status: "error",
      registrationId: reg.id,
      message: "Too many resend attempts. Please contact sales.",
    };
  }
  if (reg.verification_sent_at) {
    const elapsedSeconds = (Date.now() - new Date(reg.verification_sent_at).getTime()) / 1000;
    if (elapsedSeconds < DEMO_RATE_LIMITS.MIN_RESEND_INTERVAL_SECONDS) {
      return {
        status: "error",
        registrationId: reg.id,
        message: "Please wait a moment before requesting another link.",
      };
    }
  }

  const { actionLink, userId } = await issueVerificationLink(
    admin,
    workEmail,
    meta.origin,
    Boolean(reg.auth_user_id),
  );
  await admin
    .from("lexibite_demo_registrations")
    .update({
      auth_user_id: reg.auth_user_id ?? userId,
      verification_sent_at: new Date().toISOString(),
      verification_resend_count: reg.verification_resend_count + 1,
    })
    .eq("id", reg.id);

  if (emailConfigured()) {
    const { subject, html, text } = verificationEmail(reg.first_name, actionLink);
    await sendEmail({
      to: workEmail,
      subject,
      html,
      text,
      idempotencyKey: `demo-resend-${reg.id}-${reg.verification_resend_count + 1}`,
    });
  }

  return {
    status: "verification_required",
    registrationId: reg.id,
    message: "If that email has a pending demo request, a new link has been sent.",
  };
}

export async function getDemoRegistrationStatus(
  admin: Sb,
  registrationId: string,
): Promise<{ status: string } | null> {
  const { data } = await admin
    .from("lexibite_demo_registrations")
    .select("status")
    .eq("id", registrationId)
    .maybeSingle();
  return data ? { status: data.status } : null;
}
