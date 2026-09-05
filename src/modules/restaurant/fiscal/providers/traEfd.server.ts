/**
 * TRA EFD/VFD adapter — real TEST/sandbox implementation.
 *
 * This makes actual HTTP requests to virtual.tra.go.tz when TRA certificate
 * material is configured; it never simulates a TRA response (spec sections
 * 24/27). When unconfigured, every operation reports a configuration error
 * naming exactly what is missing — never a fabricated success or a silent
 * fallback to the internal test double (providers/testAdapter.server.ts,
 * which is a separate thing entirely: a deterministic stand-in used only by
 * this repo's own automated tests, never selected for a real tenant).
 *
 * "Production" has no approved TRA contract in this sprint (same as before
 * this sprint) — createTraEfdAdapter("production") still returns null, so
 * the Fiscal Core's existing "no adapter -> configuration_error" path
 * applies unchanged; no production endpoint is ever called.
 *
 * Required server-only env vars for TEST mode:
 *   TRA_VFD_PRIVATE_KEY_PEM / _PATH / _BASE64  — PEM private key
 *   TRA_VFD_CERTIFICATE_PEM / _PATH / _BASE64  — PEM certificate
 *   TRA_VFD_CERT_KEY                           — CERTKEY issued alongside the certificate (registration only)
 *   FISCAL_CREDENTIAL_ENCRYPTION_KEY            — 32-byte base64 key for at-rest token/password encryption
 * None of these are read for any purpose beyond the checks below — no
 * fallback value is ever invented for a missing one.
 */
import type {
  FiscalConnectivityResult,
  FiscalProviderAdapter,
  FiscalSubmissionInput,
  FiscalSubmissionResult,
} from "../adapter";
import type { FiscalEnvironment, FiscalErrorClass } from "../contracts";
import {
  registerVfd,
  requestAccessToken,
  submitReceiptXml,
  submitZReportXml,
} from "./tra/traClient.server";
import {
  decryptFiscalSecret,
  encryptFiscalSecret,
  isCredentialStoreConfigured,
} from "./tra/traCrypto.server";
import {
  certificateSerialBase64,
  loadTraCertificateMaterial,
  signSha1Rsa,
} from "./tra/traSign.server";
import {
  TraProtocolError,
  type TraErrorCode,
  type TraReceiptLine,
  type TraReceiptPayment,
  type TraVatTotal,
} from "./tra/traTypes";
import {
  buildReceiptBody,
  buildRegistrationXml,
  buildRegistrationSignedContent,
  buildSignedReceiptXml,
  buildSignedZReportXml,
  buildZReportBody,
  resolvePaymentCode,
  resolveTaxCode,
} from "./tra/traXml";

type Sb = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary.

function isTraConfigured(): boolean {
  return Boolean(loadTraCertificateMaterial()) && isCredentialStoreConfigured();
}

function errorCodeToOutcome(code: TraErrorCode): {
  outcome: Exclude<FiscalSubmissionResult["outcome"], "success" | "duplicate">;
  errorClass: FiscalErrorClass;
} {
  switch (code) {
    case "TRA_TIMEOUT":
      return { outcome: "timeout", errorClass: "timeout" };
    case "TRA_NETWORK_ERROR":
      return { outcome: "network_error", errorClass: "network" };
    case "TRA_AUTHENTICATION_FAILED":
    case "TRA_TOKEN_EXPIRED":
      return { outcome: "authentication_error", errorClass: "authentication" };
    case "TRA_INVALID_XML":
    case "TRA_SIGNATURE_FAILED":
      return { outcome: "malformed_response", errorClass: "unknown" };
    default:
      return { outcome: "malformed_response", errorClass: "configuration" };
  }
}

function configError(reason: string, signedXml?: string): FiscalSubmissionResult {
  return { outcome: "malformed_response", errorClass: "configuration", reason, signedXml };
}

export function createTraEfdAdapter(environment: FiscalEnvironment): FiscalProviderAdapter | null {
  if (environment === "production") {
    // No approved TRA production contract exists — never invent one.
    return null;
  }

  return {
    providerCode: "tra_efd",
    environment: "test",

    async verifyConnectivity(): Promise<FiscalConnectivityResult> {
      const cert = loadTraCertificateMaterial();
      if (!cert) {
        return {
          ok: false,
          detail: "TRA certificate is not configured for this environment.",
        };
      }
      if (!isCredentialStoreConfigured()) {
        return { ok: false, detail: "Credential encryption is not configured." };
      }
      // A static configuration check only — this never claims a live TRA
      // session exists. Use the dedicated "Test TRA connection" action
      // (fiscal.server.ts's testFiscalConnection) for a real round trip.
      return {
        ok: true,
        detail: "TRA certificate configured. Run 'Test TRA connection' for a live check.",
      };
    },

    async submitReceipt(input: FiscalSubmissionInput): Promise<FiscalSubmissionResult> {
      const cert = loadTraCertificateMaterial();
      if (!cert) return configError("TRA certificate is not configured.");
      if (!input.accessToken)
        return configError("No valid TRA access token — register/authenticate first.");

      let certSerial: string;
      try {
        certSerial = certificateSerialBase64(cert.certificatePem);
      } catch (err) {
        return configError((err as TraProtocolError).message);
      }

      // Retry: resend the exact original bytes, never rebuild (spec 5/9/22).
      if (input.existingSignedXml) {
        try {
          const ack = await submitReceiptXml(
            input.existingSignedXml,
            certSerial,
            input.accessToken,
          );
          if (ack.ackCode === "0") {
            return {
              outcome: "success",
              fiscalReceiptNumber: input.numbering?.rctvnum ?? String(input.numbering?.gc ?? ""),
              verificationCode: null,
              zNumber: input.numbering?.znum ?? null,
              acknowledgedAt: new Date().toISOString(),
              signedXml: input.existingSignedXml,
              rctvnum: input.numbering?.rctvnum,
              ackCode: ack.ackCode,
              ackMessage: ack.ackMessage,
            };
          }
          return {
            outcome: "rejected",
            errorClass: "provider_rejection",
            reason: ack.ackMessage || "TRA rejected the receipt.",
            signedXml: input.existingSignedXml,
            ackCode: ack.ackCode,
            ackMessage: ack.ackMessage,
          };
        } catch (err) {
          const mapped = errorCodeToOutcome((err as TraProtocolError).code ?? "TRA_NETWORK_ERROR");
          return {
            ...mapped,
            reason: (err as Error).message,
            signedXml: input.existingSignedXml,
          };
        }
      }

      if (!input.registration) {
        return configError(
          "VFD is not registered with TRA yet — register before fiscalizing receipts.",
        );
      }
      if (!input.numbering) {
        return configError("Fiscal numbering was not allocated for this receipt.");
      }

      // Resolve TRA tax classification per line — never default to A.
      const items: TraReceiptLine[] = [];
      for (let i = 0; i < input.receipt.items.length; i++) {
        const line = input.receipt.items[i];
        const taxCode = resolveTaxCode(line.taxRate, line.taxClassificationCode);
        if (!taxCode) {
          return configError(
            `Item "${line.description}" has no TRA tax classification (rate ${line.taxRate}%). Configure its tax rule's TRA code (A-E) before fiscalizing.`,
          );
        }
        items.push({
          id: i + 1,
          description: line.description,
          quantity: line.quantity,
          taxCode,
          amount: line.lineTotal,
        });
      }

      if (input.receipt.payments.length === 0) {
        return configError("No payments recorded for this order — cannot submit to TRA.");
      }
      const payments: TraReceiptPayment[] = [];
      for (const p of input.receipt.payments) {
        const code = resolvePaymentCode(p.method);
        if (!code) {
          return configError(
            `Payment method "${p.method}" has no TRA payment type mapping — cannot submit to TRA.`,
          );
        }
        payments.push({ type: code, amount: p.amount });
      }

      const vatByCode = new Map<string, TraVatTotal>();
      for (const it of items) {
        const line = input.receipt.items[it.id - 1];
        const existing = vatByCode.get(it.taxCode);
        const netAmount = line.lineTotal - line.taxAmount;
        if (existing) {
          existing.netAmount += netAmount;
          existing.taxAmount += line.taxAmount;
        } else {
          vatByCode.set(it.taxCode, { taxCode: it.taxCode, netAmount, taxAmount: line.taxAmount });
        }
      }

      const rctvnum =
        input.numbering.rctvnum ??
        `${input.registration.receiptCode}${String(input.numbering.gc).padStart(8, "0")}`;
      const body = buildReceiptBody({
        date: input.numbering.rctDate,
        time: input.numbering.rctTime,
        tin: input.configuration.tin ?? "",
        regId: input.registration.regId,
        efdSerial: input.registration.efdSerial,
        custIdType: null,
        custId: null,
        custName: null,
        mobileNum: null,
        rctNum: input.numbering.gc,
        dc: input.numbering.dc,
        gc: input.numbering.gc,
        znum: input.numbering.znum,
        rctvnum,
        items,
        totalTaxExcl: input.receipt.subtotal,
        totalTaxIncl: input.receipt.total,
        // Order-level discount is not currently threaded into the fiscal
        // payload (FiscalReceiptLineInput carries no discount field) — the
        // final totals above are still the real, already-discounted order
        // totals; only this breakdown field is a disclosed gap.
        discount: 0,
        payments,
        vatTotals: Array.from(vatByCode.values()),
      });

      let signature: string;
      try {
        signature = signSha1Rsa(body, cert.privateKeyPem);
      } catch (err) {
        return configError((err as TraProtocolError).message);
      }
      const xml = buildSignedReceiptXml(body, signature);

      try {
        const ack = await submitReceiptXml(xml, certSerial, input.accessToken);
        if (ack.ackCode === "0") {
          return {
            outcome: "success",
            fiscalReceiptNumber: rctvnum,
            verificationCode: null, // pending — TRA's TEST ACK does not carry one (spec 18: never fabricate)
            zNumber: input.numbering.znum,
            acknowledgedAt: new Date().toISOString(),
            signedXml: xml,
            rctvnum,
            ackCode: ack.ackCode,
            ackMessage: ack.ackMessage,
          };
        }
        return {
          outcome: "rejected",
          errorClass: "provider_rejection",
          reason: ack.ackMessage || "TRA rejected the receipt.",
          signedXml: xml,
          ackCode: ack.ackCode,
          ackMessage: ack.ackMessage,
        };
      } catch (err) {
        const mapped = errorCodeToOutcome((err as TraProtocolError).code ?? "TRA_NETWORK_ERROR");
        return { ...mapped, reason: (err as Error).message, signedXml: xml };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Registration orchestration (spec section 2) — DB-aware, so it lives here
// rather than in the stateless adapter above.
// ---------------------------------------------------------------------------
export interface TraRegistrationOutcome {
  ackCode: string;
  ackMessage: string;
  regId: string | null;
  efdSerial: string | null;
  uin: string | null;
  receiptCode: string | null;
  taxOffice: string | null;
  region: string | null;
}

export async function registerTraVfd(
  sb: Sb,
  tenantId: string,
  fiscalConfigurationId: string,
): Promise<TraRegistrationOutcome> {
  const { data: config } = await sb
    .from("restaurant_fiscal_configurations")
    .select("id, tin")
    .eq("tenant_id", tenantId)
    .eq("id", fiscalConfigurationId)
    .maybeSingle();
  if (!config)
    throw new TraProtocolError("TRA_CONFIGURATION_REQUIRED", "Fiscal configuration not found.");
  if (!config.tin) {
    throw new TraProtocolError(
      "TRA_CONFIGURATION_REQUIRED",
      "TIN must be set before VFD registration.",
    );
  }

  const cert = loadTraCertificateMaterial();
  if (!cert) {
    throw new TraProtocolError(
      "TRA_CERTIFICATE_MISSING",
      "TRA certificate is not configured (TRA_VFD_PRIVATE_KEY_PEM / TRA_VFD_CERTIFICATE_PEM, or the _PATH / _BASE64 variants).",
    );
  }
  const certKey = process.env.TRA_VFD_CERT_KEY;
  if (!certKey) {
    throw new TraProtocolError("TRA_CONFIGURATION_REQUIRED", "TRA_VFD_CERT_KEY is not configured.");
  }
  if (!isCredentialStoreConfigured()) {
    throw new TraProtocolError(
      "TRA_CONFIGURATION_REQUIRED",
      "FISCAL_CREDENTIAL_ENCRYPTION_KEY is not configured — cannot store TRA-issued credentials safely.",
    );
  }

  const certSerial = certificateSerialBase64(cert.certificatePem);
  const signedContent = buildRegistrationSignedContent(config.tin, certKey);
  const signature = signSha1Rsa(signedContent, cert.privateKeyPem);
  const xml = buildRegistrationXml(config.tin, certKey, signature);

  const response = await registerVfd(xml, certSerial);
  if (response.ackCode !== "0" || !response.regId) {
    throw new TraProtocolError(
      "TRA_REGISTRATION_FAILED",
      response.ackMessage || "TRA registration was not accepted.",
    );
  }

  const { data: existingDevice } = await sb
    .from("restaurant_fiscal_devices")
    .select("id, device_serial")
    .eq("tenant_id", tenantId)
    .eq("fiscal_configuration_id", fiscalConfigurationId)
    .maybeSingle();

  const registrationInfo = {
    regId: response.regId,
    efdSerial: response.efdSerial,
    receiptCode: response.receiptCode,
    taxOffice: response.taxOffice,
    region: response.region,
    ackCode: response.ackCode,
    ackMessage: response.ackMessage,
    registeredAt: new Date().toISOString(),
  };

  await sb.from("restaurant_fiscal_devices").upsert(
    {
      tenant_id: tenantId,
      fiscal_configuration_id: fiscalConfigurationId,
      device_serial:
        existingDevice?.device_serial ??
        response.efdSerial ??
        `EFD-${fiscalConfigurationId.slice(0, 8)}`,
      uin: response.uin,
      registration_info: registrationInfo,
      status: "registered",
    },
    { onConflict: "tenant_id,device_serial" },
  );

  if (response.username && response.password) {
    await sb.from("restaurant_fiscal_credentials").upsert(
      {
        tenant_id: tenantId,
        fiscal_configuration_id: fiscalConfigurationId,
        tra_username: response.username,
        tra_password_encrypted: encryptFiscalSecret(response.password),
        access_token_encrypted: null,
        token_type: null,
        issued_at: null,
        expires_at: null,
      },
      { onConflict: "tenant_id,fiscal_configuration_id" },
    );
  }

  return {
    ackCode: response.ackCode,
    ackMessage: response.ackMessage,
    regId: response.regId,
    efdSerial: response.efdSerial,
    uin: response.uin,
    receiptCode: response.receiptCode,
    taxOffice: response.taxOffice,
    region: response.region,
  };
}

// ---------------------------------------------------------------------------
// Token management (spec section 3) — reuse a still-valid stored token;
// only request a new one when missing/expired.
// ---------------------------------------------------------------------------
export type TraTokenOutcome = { token: string } | { error: TraErrorCode; message: string };

export async function ensureTraAccessToken(
  sb: Sb,
  tenantId: string,
  fiscalConfigurationId: string,
): Promise<TraTokenOutcome> {
  const { data: creds } = await sb
    .from("restaurant_fiscal_credentials")
    .select("tra_username, tra_password_encrypted, access_token_encrypted, expires_at")
    .eq("tenant_id", tenantId)
    .eq("fiscal_configuration_id", fiscalConfigurationId)
    .maybeSingle();

  if (!creds?.tra_username || !creds?.tra_password_encrypted) {
    return { error: "TRA_CONFIGURATION_REQUIRED", message: "VFD is not registered with TRA yet." };
  }

  if (creds.access_token_encrypted && creds.expires_at) {
    const expiresAt = new Date(creds.expires_at).getTime();
    if (expiresAt > Date.now() + 30_000) {
      return { token: decryptFiscalSecret(creds.access_token_encrypted) };
    }
  }

  let password: string;
  try {
    password = decryptFiscalSecret(creds.tra_password_encrypted);
  } catch {
    return {
      error: "TRA_CONFIGURATION_REQUIRED",
      message: "Stored TRA credentials could not be decrypted.",
    };
  }

  try {
    const tokenRes = await requestAccessToken(creds.tra_username, password);
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + tokenRes.expiresInSeconds * 1000);
    await sb
      .from("restaurant_fiscal_credentials")
      .update({
        access_token_encrypted: encryptFiscalSecret(tokenRes.accessToken),
        token_type: tokenRes.tokenType,
        issued_at: issuedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", tenantId)
      .eq("fiscal_configuration_id", fiscalConfigurationId);
    return { token: tokenRes.accessToken };
  } catch (err) {
    if (err instanceof TraProtocolError) return { error: err.code, message: err.message };
    return { error: "TRA_NETWORK_ERROR", message: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Z-report submission (spec section 11).
// ---------------------------------------------------------------------------
export async function submitTraZReport(
  sb: Sb,
  tenantId: string,
  fiscalConfigurationId: string,
  zReportRow: {
    id: string;
    business_date: string;
    subtotal: number;
    tax_total: number;
    total: number;
    receipt_count: number;
    submission_attempt_count?: number;
  },
): Promise<{ ackCode: string; ackMessage: string; zNumber: number }> {
  const { data: device } = await sb
    .from("restaurant_fiscal_devices")
    .select("registration_info")
    .eq("tenant_id", tenantId)
    .eq("fiscal_configuration_id", fiscalConfigurationId)
    .maybeSingle();
  const reg = (device?.registration_info ?? {}) as Record<string, string>;
  if (!reg.regId || !reg.efdSerial) {
    throw new TraProtocolError("TRA_CONFIGURATION_REQUIRED", "VFD is not registered with TRA yet.");
  }

  const { data: config } = await sb
    .from("restaurant_fiscal_configurations")
    .select("tin, vrn")
    .eq("tenant_id", tenantId)
    .eq("id", fiscalConfigurationId)
    .maybeSingle();
  if (!config?.tin || !config?.vrn) {
    throw new TraProtocolError(
      "TRA_CONFIGURATION_REQUIRED",
      "TIN and VRN must be set before Z-report submission.",
    );
  }

  const cert = loadTraCertificateMaterial();
  if (!cert)
    throw new TraProtocolError("TRA_CERTIFICATE_MISSING", "TRA certificate is not configured.");

  const tokenOutcome = await ensureTraAccessToken(sb, tenantId, fiscalConfigurationId);
  if ("error" in tokenOutcome) throw new TraProtocolError(tokenOutcome.error, tokenOutcome.message);

  const zNumber = await sb.rpc("restaurant_fiscal_next_counter", {
    _tenant: tenantId,
    _fiscal_config: fiscalConfigurationId,
    _counter_type: "znumber",
    _period_key: "ALL",
  });
  if (zNumber.error || !zNumber.data) {
    throw new TraProtocolError("TRA_SEQUENCE_ERROR", "Could not allocate a Z-report number.");
  }

  const now = new Date();
  const body = buildZReportBody({
    date: now.toLocaleDateString("en-GB"),
    time: now.toTimeString().slice(0, 8),
    header: "Z REPORT",
    vrn: config.vrn,
    tin: config.tin,
    taxOffice: reg.taxOffice ?? null,
    regId: reg.regId,
    zNumber: Number(zNumber.data),
    efdSerial: reg.efdSerial,
    registrationDate: reg.registeredAt ?? null,
    user: "SYSTEM",
    simImsi: "",
    totalTaxExcl: Number(zReportRow.subtotal),
    totalTaxIncl: Number(zReportRow.total),
    vatTotals: [
      {
        taxCode: "A",
        netAmount: Number(zReportRow.subtotal),
        taxAmount: Number(zReportRow.tax_total),
      },
    ],
    payments: [],
  });

  const certSerial = certificateSerialBase64(cert.certificatePem);
  const signature = signSha1Rsa(body, cert.privateKeyPem);
  const xml = buildSignedZReportXml(body, signature);

  await sb
    .from("restaurant_fiscal_z_reports")
    .update({ request_xml: xml, regid_snapshot: reg.regId, efd_serial_snapshot: reg.efdSerial })
    .eq("tenant_id", tenantId)
    .eq("id", zReportRow.id);

  const ack = await submitZReportXml(xml, certSerial, tokenOutcome.token);

  await sb
    .from("restaurant_fiscal_z_reports")
    .update({
      state: ack.ackCode === "0" ? "acknowledged" : "failed",
      z_number: String(zNumber.data),
      ack_code: ack.ackCode,
      ack_message: ack.ackMessage,
      submitted_at: now.toISOString(),
      acknowledged_at: ack.ackCode === "0" ? new Date().toISOString() : null,
      submission_attempt_count: zReportRow.submission_attempt_count
        ? Number(zReportRow.submission_attempt_count) + 1
        : 1,
    })
    .eq("tenant_id", tenantId)
    .eq("id", zReportRow.id);

  return { ackCode: ack.ackCode, ackMessage: ack.ackMessage, zNumber: Number(zNumber.data) };
}
