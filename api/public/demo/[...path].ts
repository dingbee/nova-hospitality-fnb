/**
 * LexiBite Demo Access — standalone Vercel Function.
 *
 * This endpoint is intentionally self-contained. The LexiBite application is
 * built with TanStack Start/Nitro, while /api is emitted by Vercel as a
 * separate Node.js Function. The Vercel deployment currently does not bundle
 * extensionless imports from src/*.server.ts into the standalone function;
 * importing those modules therefore crashes at runtime with ERR_MODULE_NOT_FOUND.
 *
 * Keep business behavior aligned with src/modules/lexibite-demo/*:
 * - public, rate-limited registration
 * - Supabase Auth generateLink for verification
 * - custom email relay
 * - no tenant/session/role input accepted from the caller
 * - activation origin is fixed to the production LexiBite domain
 */
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const DEMO_SOURCE = "LEXIBITE_DEMO";
const MAX_REGISTRATIONS_PER_IP_PER_HOUR = 5;
const MAX_RESENDS = 5;
const MIN_RESEND_INTERVAL_SECONDS = 60;
const PRODUCTION_ORIGIN = "https://lexibite.nolmark.co";

const registerSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  workEmail: z.string().trim().email().max(200),
  company: z.string().trim().min(1).max(160),
  role: z.string().trim().min(1).max(120),
  country: z.string().trim().min(1).max(80),
  phone: z.string().trim().max(40).optional(),
  source: z.literal(DEMO_SOURCE).default(DEMO_SOURCE),
});

const resendSchema = z.object({
  workEmail: z.string().trim().email().max(200),
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function corsHeaders(request: Request): Record<string, string> {
  const configured = (env("NOLMARK_ALLOWED_ORIGIN") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowed = [...new Set(["https://nolmark.co", "https://www.nolmark.co", ...configured])];
  const origin = request.headers.get("origin");
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? null;
  return request.headers.get("x-real-ip");
}

async function hashIp(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(ip),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function escapeHtml(value: string): string {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

function createSupabaseAdmin() {
  const url = env("SUPABASE_URL");
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !serviceRoleKey) {
    throw new Error(
      `Missing Supabase environment variable(s): ${[
        !url ? "SUPABASE_URL" : null,
        !serviceRoleKey ? "SUPABASE_SERVICE_ROLE_KEY" : null,
      ]
        .filter(Boolean)
        .join(", ")}`,
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

async function sendEmail(input: {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
}): Promise<boolean> {
  const webhook = env("NOVA_EMAIL_WEBHOOK_URL");
  if (!webhook) return true;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Idempotency-Key": input.idempotencyKey,
  };
  const key = env("NOVA_EMAIL_WEBHOOK_KEY");
  if (key) headers.Authorization = `Bearer ${key}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers,
      body: JSON.stringify({
        from: env("NOVA_EMAIL_FROM") ?? "no-reply@nova-hospitality.local",
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
      signal: controller.signal,
    });
    return response.ok;
  } finally {
    clearTimeout(timer);
  }
}

function verificationEmail(firstName: string, actionLink: string) {
  return {
    subject: "Your LexiBite demo is ready to verify",
    html: `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1a1a1a">
<h2 style="margin:0 0 12px">Hi ${escapeHtml(firstName)},</h2>
<p>Thanks for requesting a LexiBite demo. Confirm your email to launch your own guided session of the real product — Kilimanjaro Grill, a working restaurant &amp; bar running on LexiBite.</p>
<p style="margin:24px 0"><a href="${escapeHtml(actionLink)}" style="background:#111;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">Verify &amp; launch demo</a></p>
<p style="color:#666;font-size:13px">This link is single-use and expires. If you didn't request this, you can ignore this email.</p>
</body></html>`,
    text: `Hi ${firstName},

Confirm your email to launch your LexiBite demo:
${actionLink}

If you didn't request this, you can ignore this email.`,
  };
}

async function issueVerificationLink(
  admin: ReturnType<typeof createSupabaseAdmin>,
  email: string,
  hasExistingUser: boolean,
) {
  const redirectTo = `${PRODUCTION_ORIGIN}/lexibite/demo/activate`;
  const { data, error } = await admin.auth.admin.generateLink(
    hasExistingUser
      ? {
          type: "magiclink",
          email,
          options: { redirectTo },
        }
      : {
          type: "invite",
          email,
          options: {
            redirectTo,
            data: { demo: true, source: DEMO_SOURCE },
          },
        },
  );

  if (error || !data?.properties?.action_link || !data?.user?.id) {
    throw new Error(error?.message ?? "Could not generate a verification link.");
  }

  return {
    actionLink: data.properties.action_link,
    userId: data.user.id,
  };
}

async function registerDemo(request: Request): Promise<Response> {
  let input: z.infer<typeof registerSchema>;
  try {
    input = registerSchema.parse(await request.json());
  } catch {
    return json({ status: "error", message: "Invalid registration payload." }, 400);
  }

  const admin = createSupabaseAdmin();
  const normalized = normalizeEmail(input.workEmail);
  const ip = clientIp(request);
  const ipHash = ip ? await hashIp(ip) : null;

  if (ipHash) {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count, error } = await admin
      .from("lexibite_demo_registrations")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ipHash)
      .gte("created_at", since);

    if (error) throw error;

    if ((count ?? 0) >= MAX_REGISTRATIONS_PER_IP_PER_HOUR) {
      return json({
        status: "error",
        registrationId: null,
        message: "Too many demo requests from this network. Please try again later.",
      });
    }
  }

  const { data: existing, error: existingError } = await admin
    .from("lexibite_demo_registrations")
    .select("id, status")
    .eq("work_email_normalized", normalized)
    .maybeSingle();

  if (existingError) throw existingError;

  if (existing) {
    return json({
      status: "already_registered",
      registrationId: existing.id,
      message:
        existing.status === "pending_verification"
          ? "You've already requested a demo — check your email, or request a new link."
          : "You already have LexiBite demo access. Check your email for the launch link, or sign in.",
    });
  }

  const { data: inserted, error: insertError } = await admin
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
      status: "pending_verification",
      ip_hash: ipHash,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    if (insertError && /duplicate key/i.test(insertError.message)) {
      return json({
        status: "already_registered",
        registrationId: null,
        message: "You've already requested a demo — check your email.",
      });
    }
    throw insertError ?? new Error("Could not create demo registration.");
  }

  try {
    const { actionLink, userId } = await issueVerificationLink(
      admin,
      input.workEmail,
      false,
    );

    await admin
      .from("lexibite_demo_registrations")
      .update({
        auth_user_id: userId,
        verification_sent_at: new Date().toISOString(),
      })
      .eq("id", inserted.id);

    const email = verificationEmail(input.firstName, actionLink);
    const delivered = await sendEmail({
      ...email,
      to: input.workEmail,
      idempotencyKey: `demo-verify-${inserted.id}`,
    });

    if (!delivered && env("NOVA_EMAIL_WEBHOOK_URL")) {
      throw new Error("Verification email provider rejected the request.");
    }
  } catch (error) {
    await admin
      .from("lexibite_demo_registrations")
      .update({ status: "error" })
      .eq("id", inserted.id);
    throw error;
  }

  return json({
    status: "verification_required",
    registrationId: inserted.id,
    message: "Check your email to verify and launch your LexiBite demo.",
  });
}

async function resendDemo(request: Request): Promise<Response> {
  let input: z.infer<typeof resendSchema>;
  try {
    input = resendSchema.parse(await request.json());
  } catch {
    return json({ status: "error", message: "Invalid request." }, 400);
  }

  const admin = createSupabaseAdmin();
  const normalized = normalizeEmail(input.workEmail);

  const { data: registration, error } = await admin
    .from("lexibite_demo_registrations")
    .select(
      "id, first_name, status, verification_resend_count, verification_sent_at, auth_user_id",
    )
    .eq("work_email_normalized", normalized)
    .maybeSingle();

  if (error) throw error;

  if (!registration) {
    return json({
      status: "verification_required",
      registrationId: null,
      message: "If that email has a pending demo request, a new link has been sent.",
    });
  }

  if (registration.verification_resend_count >= MAX_RESENDS) {
    return json({
      status: "error",
      registrationId: registration.id,
      message: "Too many resend attempts. Please contact sales.",
    });
  }

  if (registration.verification_sent_at) {
    const elapsedSeconds =
      (Date.now() - new Date(registration.verification_sent_at).getTime()) / 1000;
    if (elapsedSeconds < MIN_RESEND_INTERVAL_SECONDS) {
      return json({
        status: "error",
        registrationId: registration.id,
        message: "Please wait a moment before requesting another link.",
      });
    }
  }

  const { actionLink, userId } = await issueVerificationLink(
    admin,
    input.workEmail,
    Boolean(registration.auth_user_id),
  );

  const nextCount = registration.verification_resend_count + 1;
  await admin
    .from("lexibite_demo_registrations")
    .update({
      auth_user_id: registration.auth_user_id ?? userId,
      verification_sent_at: new Date().toISOString(),
      verification_resend_count: nextCount,
    })
    .eq("id", registration.id);

  const email = verificationEmail(registration.first_name, actionLink);
  const delivered = await sendEmail({
    ...email,
    to: input.workEmail,
    idempotencyKey: `demo-resend-${registration.id}-${nextCount}`,
  });

  if (!delivered && env("NOVA_EMAIL_WEBHOOK_URL")) {
    throw new Error("Verification email provider rejected the request.");
  }

  return json({
    status: "verification_required",
    registrationId: registration.id,
    message: "If that email has a pending demo request, a new link has been sent.",
  });
}

async function registrationStatus(request: Request, registrationId: string): Promise<Response> {
  const admin = createSupabaseAdmin();
  const { data, error } = await admin
    .from("lexibite_demo_registrations")
    .select("status")
    .eq("id", registrationId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return json({ status: "error", message: "Not found." }, 404);
  return json({ status: data.status });
}

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/public/demo/")) {
    return json({ status: "error", message: "Not found." }, 404);
  }

  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  try {
    if (url.pathname === "/api/public/demo/register" && request.method === "POST") {
      return withHeaders(await registerDemo(request), cors);
    }

    if (url.pathname === "/api/public/demo/resend" && request.method === "POST") {
      return withHeaders(await resendDemo(request), cors);
    }

    const statusMatch = url.pathname.match(
      /^\/api\/public\/demo\/registration\/([0-9a-f-]{36})$/i,
    );
    if (statusMatch && request.method === "GET") {
      return withHeaders(await registrationStatus(request, statusMatch[1]!), cors);
    }

    return withHeaders(json({ status: "error", message: "Not found." }, 404), cors);
  } catch (error) {
    console.error("[LexiBite Demo API]", error);
    return withHeaders(
      json({
        status: "error",
        registrationId: null,
        message: "Couldn't complete your LexiBite demo request.",
      }, 500),
      cors,
    );
  }
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) merged.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}
