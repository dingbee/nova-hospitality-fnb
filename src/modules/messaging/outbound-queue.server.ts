/* eslint-disable @typescript-eslint/no-explicit-any -- privileged Supabase rows are validated at this boundary. */
import { randomUUID } from "node:crypto";
import { decryptSecret } from "@/modules/api-platform/crypto.server";
import { getIntegrationSecret } from "@/modules/api-platform/integrations.server";
import { writeCommercialAudit } from "@/modules/commercial/audit.server";
import { assertCapability } from "@/modules/restaurant/core/access.server";
import {
  MetaGraphError,
  sendTextMessage,
} from "./providers/meta-cloud-api.server";

type Db = any;
type ClaimedOutboundJob = {
  id: string;
  tenant_id: string;
  property_id: string;
  location_id: string;
  binding_id: string;
  conversation_id: string;
  portal_session_id: string | null;
  recipient_phone: string;
  body_ciphertext: string;
  body_iv: string;
  body_tag: string;
  attempt_count: number;
  max_attempts: number;
};

async function updateJob(
  db: Db,
  job: ClaimedOutboundJob,
  workerId: string,
  patch: Record<string, unknown>,
) {
  const { error } = await db
    .from("wa_outbound_jobs")
    .update({ ...patch, locked_at: null, locked_by: null, updated_at: new Date().toISOString() })
    .eq("id", job.id)
    .eq("status", "processing")
    .eq("locked_by", workerId);
  if (error) throw new Error("outbound_job_state_update_failed");
}

async function markRetry(db: Db, job: ClaimedOutboundJob, workerId: string) {
  const delaySeconds = Math.min(3600, 5 * 2 ** Math.min(job.attempt_count - 1, 10));
  await updateJob(db, job, workerId, {
    status: job.attempt_count >= job.max_attempts ? "failed" : "retry",
    next_attempt_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
    last_error: job.attempt_count >= job.max_attempts ? "meta_rate_limit_retry_exhausted" : "meta_rate_limited",
  });
  return job.attempt_count >= job.max_attempts ? "failed" : "retried";
}

async function markUncertain(db: Db, job: ClaimedOutboundJob, workerId: string, code: string) {
  await updateJob(db, job, workerId, { status: "uncertain", last_error: code });
}

async function markFailed(db: Db, job: ClaimedOutboundJob, workerId: string, code: string) {
  await updateJob(db, job, workerId, { status: "failed", last_error: code });
}

async function findExistingOutboundMessage(db: Db, jobId: string) {
  const { data, error } = await db
    .from("wa_messages")
    .select("id, provider_message_id, provider_timestamp")
    .eq("outbound_job_id", jobId)
    .maybeSingle();
  if (error) throw new Error("outbound_message_lookup_failed");
  return data;
}

async function processOneOutboundJob(db: Db, job: ClaimedOutboundJob, workerId: string) {
  const existingMessage = await findExistingOutboundMessage(db, job.id);
  if (existingMessage) {
    await updateJob(db, job, workerId, {
      status: "sent",
      provider_message_id: existingMessage.provider_message_id,
      sent_at: existingMessage.provider_timestamp ?? new Date().toISOString(),
      last_error: null,
    });
    return "sent" as const;
  }

  const { data: binding, error: bindingError } = await db
    .from("wa_phone_number_bindings")
    .select("id, integration_id, phone_number_id, status")
    .eq("id", job.binding_id)
    .eq("tenant_id", job.tenant_id)
    .eq("property_id", job.property_id)
    .eq("location_id", job.location_id)
    .maybeSingle();
  if (bindingError || !binding || binding.status !== "active") {
    await markFailed(db, job, workerId, "receiving_number_inactive");
    return "failed" as const;
  }

  const { data: integration, error: integrationError } = await db
    .from("api_integrations")
    .select("id, status, provider, channel_key, integration_type, config")
    .eq("id", binding.integration_id)
    .eq("tenant_id", job.tenant_id)
    .eq("property_id", job.property_id)
    .maybeSingle();
  if (
    integrationError ||
    !integration ||
    integration.status !== "active" ||
    integration.provider !== "meta-whatsapp" ||
    integration.channel_key !== "whatsapp" ||
    integration.integration_type !== "channel"
  ) {
    await markFailed(db, job, workerId, "whatsapp_integration_inactive");
    return "failed" as const;
  }

  const wabaId = typeof integration.config?.wabaId === "string" ? integration.config.wabaId : "";
  if (!/^\d{3,32}$/.test(wabaId)) {
    await markFailed(db, job, workerId, "whatsapp_waba_configuration_unavailable");
    return "failed" as const;
  }

  if (job.portal_session_id) {
    const { data: portalSession, error: portalSessionError } = await db
      .from("restaurant_guest_commerce_sessions")
      .select("expires_at, revoked_at")
      .eq("id", job.portal_session_id)
      .eq("tenant_id", job.tenant_id)
      .eq("property_id", job.property_id)
      .eq("location_id", job.location_id)
      .maybeSingle();
    if (
      portalSessionError ||
      !portalSession ||
      portalSession.revoked_at !== null ||
      !Number.isFinite(new Date(portalSession.expires_at).getTime()) ||
      new Date(portalSession.expires_at).getTime() <= Date.now()
    ) {
      await markFailed(db, job, workerId, "guest_portal_session_expired_or_revoked");
      return "failed" as const;
    }
  }

  const { data: conversation, error: conversationError } = await db
    .from("wa_conversations")
    .select("last_message_at")
    .eq("id", job.conversation_id)
    .eq("tenant_id", job.tenant_id)
    .maybeSingle();
  const lastInboundAt = conversation?.last_message_at ? new Date(conversation.last_message_at).getTime() : 0;
  if (
    conversationError ||
    !Number.isFinite(lastInboundAt) ||
    Date.now() - lastInboundAt > 24 * 60 * 60 * 1000
  ) {
    await markFailed(db, job, workerId, "meta_customer_service_window_expired");
    return "failed" as const;
  }

  let accessToken: string | null;
  try {
    accessToken = await getIntegrationSecret(db, job.tenant_id, integration.id);
  } catch {
    await markFailed(db, job, workerId, "whatsapp_access_token_decryption_failed");
    return "failed" as const;
  }
  if (!accessToken) {
    await markFailed(db, job, workerId, "whatsapp_access_token_unavailable");
    return "failed" as const;
  }

  let body: string;
  try {
    body = decryptSecret({
      ciphertext: job.body_ciphertext,
      iv: job.body_iv,
      tag: job.body_tag,
    });
  } catch {
    await markFailed(db, job, workerId, "outbound_message_decryption_failed");
    return "failed" as const;
  }

  try {
    const response = await sendTextMessage(
      { accessToken, wabaId, phoneNumberId: binding.phone_number_id },
      job.recipient_phone,
      body,
      { graphApiVersion: integration.config?.graphApiVersion },
    );
    const providerMessageId = response.messages?.[0]?.id;
    if (!providerMessageId) {
      await markUncertain(db, job, workerId, "meta_response_missing_message_id");
      return "uncertain" as const;
    }

    const redactedContent = body.replace(/https?:\/\/[^\s]+/g, "[secure guest link]");
    const sentAt = new Date().toISOString();
    const { error: messageError } = await db.from("wa_messages").insert({
      tenant_id: job.tenant_id,
      property_id: job.property_id,
      location_id: job.location_id,
      conversation_id: job.conversation_id,
      outbound_job_id: job.id,
      provider_message_id: providerMessageId,
      direction: "outbound",
      message_type: "text",
      status: "sent",
      content: redactedContent,
      payload: { provider: "meta-whatsapp", messageType: "text" },
      provider_timestamp: sentAt,
    });
    if (messageError) {
      if (messageError.code === "23505") {
        const recorded = await findExistingOutboundMessage(db, job.id);
        if (recorded) {
          await updateJob(db, job, workerId, {
            status: "sent",
            provider_message_id: recorded.provider_message_id,
            sent_at: recorded.provider_timestamp ?? sentAt,
            last_error: null,
          });
          return "sent" as const;
        }
      }
      await markUncertain(db, job, workerId, "meta_sent_message_record_uncertain");
      return "uncertain" as const;
    }

    await updateJob(db, job, workerId, {
      status: "sent",
      provider_message_id: providerMessageId,
      sent_at: sentAt,
      last_error: null,
    });
    return "sent" as const;
  } catch (error) {
    if (error instanceof MetaGraphError) {
      if (error.status === 429 || [4, 17, 32, 613].includes(error.code ?? -1)) {
        return markRetry(db, job, workerId);
      }
      if (error.status === null || error.status >= 500) {
        await markUncertain(db, job, workerId, "meta_delivery_outcome_uncertain");
        return "uncertain" as const;
      }
      await markFailed(db, job, workerId, error.code === 190 ? "meta_token_invalid" : "meta_message_rejected");
      return "failed" as const;
    }
    await markUncertain(db, job, workerId, "meta_delivery_outcome_uncertain");
    return "uncertain" as const;
  }
}

/** Dispatch encrypted WhatsApp messages; uncertain network outcomes are never retried automatically. */
export async function processPendingMetaOutboundJobs(
  db: Db,
  options: { limit?: number; workerId?: string } = {},
) {
  const workerId = options.workerId ?? randomUUID();
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const { data, error } = await db.rpc("wa_claim_outbound_jobs", {
    _limit: limit,
    _lease_seconds: 90,
    _worker_id: workerId,
  });
  if (error) throw new Error("outbound_job_claim_failed");

  const jobs = Array.isArray(data) ? (data as ClaimedOutboundJob[]) : [];
  let sent = 0;
  let retried = 0;
  let failed = 0;
  let uncertain = 0;

  for (const job of jobs) {
    try {
      const result = await processOneOutboundJob(db, job, workerId);
      if (result === "sent") sent += 1;
      else if (result === "retried") retried += 1;
      else if (result === "failed") failed += 1;
      else uncertain += 1;
    } catch {
      await markUncertain(db, job, workerId, "outbound_processing_outcome_uncertain");
      uncertain += 1;
    }
  }

  return { claimed: jobs.length, sent, retried, failed, uncertain };
}

/** Requeue only after an operator explicitly confirms Meta did not deliver the uncertain message. */
export async function requeueMetaOutboundJob(
  admin: Db,
  userDb: Db,
  userId: string,
  jobId: string,
  confirmedNotDelivered: boolean,
) {
  if (confirmedNotDelivered !== true) {
    throw new Error("Explicit confirmation that Meta did not deliver this message is required.");
  }
  const { data: job, error: lookupError } = await admin
    .from("wa_outbound_jobs")
    .select("id, tenant_id, property_id, status, provider_message_id")
    .eq("id", jobId)
    .maybeSingle();
  if (
    lookupError ||
    !job ||
    !["uncertain", "failed"].includes(job.status) ||
    !job.tenant_id ||
    !job.property_id
  ) {
    throw new Error("Outbound job is unavailable for requeue.");
  }

  const { data: existingMessage, error: messageLookupError } = await admin
    .from("wa_messages")
    .select("id")
    .eq("outbound_job_id", jobId)
    .maybeSingle();
  if (messageLookupError || existingMessage || job.provider_message_id) {
    throw new Error("A provider message record already exists; this job cannot be requeued safely.");
  }

  await assertCapability(userDb, userId, job.tenant_id, "tenant.manage", {
    propertyId: job.property_id,
  });
  const { error } = await admin
    .from("wa_outbound_jobs")
    .update({
      status: "retry",
      attempt_count: 0,
      next_attempt_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: null,
    })
    .eq("id", jobId)
    .eq("status", job.status);
  if (error) throw new Error("Outbound job could not be requeued.");

  await writeCommercialAudit(userDb, {
    actorId: userId,
    action: "whatsapp.outbound_job.requeued",
    entityType: "wa_outbound_job",
    entityId: jobId,
    tenantId: job.tenant_id,
    reason: "Operator confirmed the prior Meta delivery attempt was not delivered.",
    after: { propertyId: job.property_id, status: "retry" },
  });
  return { jobId, status: "retry" as const };
}
