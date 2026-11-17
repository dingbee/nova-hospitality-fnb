/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * TRA EFD real adapter + registration/token/Z-report orchestration.
 * Categories A (registration), B (token), C (receipt XML via the adapter),
 * D (receipt submission), G (Z-report), H (security: no secret ever
 * returned from these functions).
 *
 * traClient.server.ts (the actual fetch layer) is mocked here — this file
 * proves the ADAPTER's own logic (validation, numbering wiring, signing,
 * persistence, retry-with-original-payload), not the HTTP transport, which
 * traClient.server.test.ts already covers directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { TEST_TRA_CERTIFICATE_PEM, TEST_TRA_PRIVATE_KEY_PEM } from "./tra/__fixtures__/testCert";

vi.mock("./tra/traClient.server", () => ({
  registerVfd: vi.fn(),
  requestAccessToken: vi.fn(),
  submitReceiptXml: vi.fn(),
  submitZReportXml: vi.fn(),
}));

import * as traClient from "./tra/traClient.server";
import {
  createTraEfdAdapter,
  ensureTraAccessToken,
  registerTraVfd,
  submitTraZReport,
} from "./traEfd.server";
import type { FiscalSubmissionInput } from "../adapter";

const TENANT = "11111111-1111-1111-1111-111111111111";
const CONFIG_ID = "22222222-2222-2222-2222-222222222222";

function makeFakeSb(seed: {
  configs?: any[];
  devices?: any[];
  credentials?: any[];
  zReports?: any[];
}) {
  const state = {
    restaurant_fiscal_configurations: seed.configs ?? [],
    restaurant_fiscal_devices: seed.devices ?? [],
    restaurant_fiscal_credentials: seed.credentials ?? [],
    restaurant_fiscal_z_reports: seed.zReports ?? [],
  } as Record<string, any[]>;
  let seq = 0;

  function from(table: string) {
    const rows = state[table] ?? (state[table] = []);
    let filtered = [...rows];
    let mode: "select" | "upsert" | "update" = "select";
    let payload: any;

    const api: any = {
      select: () => api,
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return api;
      },
      maybeSingle: async () => ({ data: filtered[0] ?? null, error: null }),
      single: async () => ({
        data: filtered[0] ?? null,
        error: filtered[0] ? null : { message: "not found" },
      }),
      upsert(row: any, opts?: { onConflict?: string }) {
        mode = "upsert";
        payload = row;
        const keyCols = (opts?.onConflict ?? "id").split(",");
        const existing = rows.find((r) => keyCols.every((c) => r[c] === row[c]));
        if (existing) Object.assign(existing, row);
        else rows.push({ id: `row-${++seq}`, ...row });
        return api;
      },
      update(patch: any) {
        mode = "update";
        payload = patch;
        return api;
      },
      then(resolve: (v: { data: any; error: any }) => unknown) {
        if (mode === "update") {
          for (const r of filtered) Object.assign(r, payload);
        }
        return Promise.resolve(resolve({ data: filtered, error: null }));
      },
    };
    return api;
  }

  const counters = new Map<string, number>();
  const rpc = vi.fn(async (fn: string, args: any) => {
    if (fn === "restaurant_fiscal_next_counter") {
      const key = `${args._fiscal_config}:${args._counter_type}:${args._period_key}`;
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return { data: next, error: null };
    }
    return { data: null, error: null };
  });

  return { from, rpc, state };
}

describe("createTraEfdAdapter", () => {
  it("production always returns null — no approved TRA production contract exists", () => {
    expect(createTraEfdAdapter("production")).toBeNull();
  });

  it("test returns a real (non-null) adapter object, never the internal simulator", () => {
    const adapter = createTraEfdAdapter("test");
    expect(adapter).not.toBeNull();
    expect(adapter!.providerCode).toBe("tra_efd");
  });
});

describe("traEfd adapter — verifyConnectivity", () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("reports not-ok when no certificate is configured — never claims connected", async () => {
    delete process.env.TRA_VFD_PRIVATE_KEY_PEM;
    delete process.env.TRA_VFD_CERTIFICATE_PEM;
    const adapter = createTraEfdAdapter("test")!;
    const result = await adapter.verifyConnectivity();
    expect(result.ok).toBe(false);
  });
});

describe("traEfd adapter — submitReceipt (categories C/D/H)", () => {
  const ORIGINAL = { ...process.env };
  beforeEach(() => {
    process.env.TRA_VFD_PRIVATE_KEY_PEM = TEST_TRA_PRIVATE_KEY_PEM;
    process.env.TRA_VFD_CERTIFICATE_PEM = TEST_TRA_CERTIFICATE_PEM;
    process.env.FISCAL_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    vi.clearAllMocks();
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  function baseInput(overrides: Partial<FiscalSubmissionInput> = {}): FiscalSubmissionInput {
    return {
      environment: "test",
      idempotencyKey: "fiscal:order-1",
      configuration: {
        businessName: "LexiBite Demo",
        tin: "123-456-789",
        vrn: "VRN1",
        deviceSerial: "EFD-1",
      },
      receipt: {
        currency: "TZS",
        subtotal: 30508.47,
        taxTotal: 5491.53,
        total: 36000,
        issuedAt: new Date().toISOString(),
        paymentMethods: ["cash"],
        payments: [{ method: "cash", amount: 36000 }],
        items: [
          {
            orderItemId: "item-1",
            description: "Classic Chicken Burger",
            quantity: 2,
            unitPrice: 18000,
            taxClassificationCode: "A",
            taxRate: 18,
            taxAmount: 5491.53,
            lineTotal: 36000,
          },
        ],
      },
      numbering: { gc: 7, dc: 3, znum: "20260904", rctDate: "04/09/2026", rctTime: "12:30:00" },
      registration: { regId: "REG123", efdSerial: "EFD001", receiptCode: "RC" },
      accessToken: "valid-token",
      existingSignedXml: null,
      ...overrides,
    };
  }

  it("no access token -> configuration error, never attempts HTTP", async () => {
    const adapter = createTraEfdAdapter("test")!;
    const result = await adapter.submitReceipt(baseInput({ accessToken: null }));
    expect(result.outcome).not.toBe("success");
    expect("errorClass" in result && result.errorClass).toBe("configuration");
    expect(traClient.submitReceiptXml).not.toHaveBeenCalled();
  });

  it("no registration -> configuration error naming registration, never fabricates REGID/EFDSERIAL", async () => {
    const adapter = createTraEfdAdapter("test")!;
    const result = await adapter.submitReceipt(baseInput({ registration: null }));
    expect("errorClass" in result && result.errorClass).toBe("configuration");
    expect("reason" in result && result.reason).toMatch(/registered/i);
  });

  it("a line with no TRA tax classification (0% rate, no explicit code) fails validation — never defaults to A", async () => {
    const adapter = createTraEfdAdapter("test")!;
    const result = await adapter.submitReceipt(
      baseInput({
        receipt: {
          ...baseInput().receipt,
          items: [
            {
              orderItemId: "item-1",
              description: "Zero-rated bread",
              quantity: 1,
              unitPrice: 1000,
              taxClassificationCode: null,
              taxRate: 0,
              taxAmount: 0,
              lineTotal: 1000,
            },
          ],
        },
      }),
    );
    expect("errorClass" in result && result.errorClass).toBe("configuration");
    expect("reason" in result && result.reason).toMatch(/Zero-rated bread/);
    expect(traClient.submitReceiptXml).not.toHaveBeenCalled();
  });

  it("an unmappable payment method (voucher) fails validation before any HTTP call", async () => {
    const adapter = createTraEfdAdapter("test")!;
    const result = await adapter.submitReceipt(
      baseInput({
        receipt: { ...baseInput().receipt, payments: [{ method: "voucher", amount: 36000 }] },
      }),
    );
    expect("errorClass" in result && result.errorClass).toBe("configuration");
    expect("reason" in result && result.reason).toMatch(/voucher/i);
  });

  it("SUCCESS: builds signed XML, RCTNUM=GC, submits, and returns the TRA RCTVNUM as the fiscal receipt number", async () => {
    (traClient.submitReceiptXml as any).mockResolvedValue({
      ackCode: "0",
      ackMessage: "Accepted",
      rctNum: "7",
      date: "04/09/2026",
      time: "12:30:00",
      raw: {},
    });
    const adapter = createTraEfdAdapter("test")!;
    const result = await adapter.submitReceipt(baseInput());
    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.fiscalReceiptNumber).toBe("RC00000007");
      expect(result.zNumber).toBe("20260904");
      expect(result.signedXml).toContain("<RCTNUM>7</RCTNUM>");
      expect(result.signedXml).toContain("<GC>7</GC>");
      expect(result.signedXml).not.toContain("undefined");
    }
    const [xmlArg] = (traClient.submitReceiptXml as any).mock.calls[0];
    expect(xmlArg).toContain("<TAXCODE>A</TAXCODE>");
  });

  it("REJECTED: a non-zero ACKCODE never becomes fiscalized", async () => {
    (traClient.submitReceiptXml as any).mockResolvedValue({
      ackCode: "5",
      ackMessage: "Duplicate receipt",
      rctNum: null,
      date: null,
      time: null,
      raw: {},
    });
    const adapter = createTraEfdAdapter("test")!;
    const result = await adapter.submitReceipt(baseInput());
    expect(result.outcome).toBe("rejected");
  });

  it("RETRY: existingSignedXml is resent VERBATIM — the adapter never rebuilds it", async () => {
    (traClient.submitReceiptXml as any).mockResolvedValue({
      ackCode: "0",
      ackMessage: "Accepted",
      rctNum: "7",
      date: null,
      time: null,
      raw: {},
    });
    const originalXml =
      "<EFDMS><RCT>FROZEN-PAYLOAD</RCT><EFDMSSIGNATURE>OLD</EFDMSSIGNATURE></EFDMS>";
    const adapter = createTraEfdAdapter("test")!;
    const result = await adapter.submitReceipt(
      baseInput({
        existingSignedXml: originalXml,
        numbering: {
          gc: 7,
          dc: 3,
          znum: "20260904",
          rctDate: "04/09/2026",
          rctTime: "12:30:00",
          rctvnum: "RC00000007",
        },
      }),
    );
    expect(result.outcome).toBe("success");
    const [xmlArg] = (traClient.submitReceiptXml as any).mock.calls[0];
    expect(xmlArg).toBe(originalXml);
    if (result.outcome === "success") expect(result.signedXml).toBe(originalXml);
  });

  it("a network failure during retry still returns the original XML for persistence, never a rebuilt one", async () => {
    (traClient.submitReceiptXml as any).mockRejectedValue(
      Object.assign(new Error("network down"), {
        code: "TRA_NETWORK_ERROR",
        name: "TraProtocolError",
      }),
    );
    const originalXml = "<EFDMS><RCT>FROZEN</RCT><EFDMSSIGNATURE>S</EFDMSSIGNATURE></EFDMS>";
    const adapter = createTraEfdAdapter("test")!;
    const result = await adapter.submitReceipt(baseInput({ existingSignedXml: originalXml }));
    expect(result.outcome).toBe("network_error");
    expect("signedXml" in result && result.signedXml).toBe(originalXml);
  });
});

describe("registerTraVfd — category A", () => {
  const ORIGINAL = { ...process.env };
  beforeEach(() => {
    process.env.TRA_VFD_PRIVATE_KEY_PEM = TEST_TRA_PRIVATE_KEY_PEM;
    process.env.TRA_VFD_CERTIFICATE_PEM = TEST_TRA_CERTIFICATE_PEM;
    process.env.TRA_VFD_CERT_KEY = "CERTKEY-XYZ";
    process.env.FISCAL_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    vi.clearAllMocks();
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("stores REGID/EFDSERIAL from TRA — never lets a caller supply their own", async () => {
    (traClient.registerVfd as any).mockResolvedValue({
      ackCode: "0",
      ackMessage: "OK",
      regId: "TRA-REGID-999",
      efdSerial: "TRA-EFD-999",
      uin: "UIN-1",
      tin: "123-456-789",
      vrn: null,
      receiptCode: "RC",
      taxOffice: "DAR",
      region: "DSM",
      username: "vfduser",
      password: "vfdpass",
      tokenPath: null,
      taxCode: null,
      raw: {},
    });
    const sb = makeFakeSb({ configs: [{ id: CONFIG_ID, tenant_id: TENANT, tin: "123-456-789" }] });
    const result = await registerTraVfd(sb as any, TENANT, CONFIG_ID);
    expect(result.regId).toBe("TRA-REGID-999");

    const device = sb.state.restaurant_fiscal_devices.find(
      (d) => d.fiscal_configuration_id === CONFIG_ID,
    );
    expect(device.registration_info.regId).toBe("TRA-REGID-999");

    const creds = sb.state.restaurant_fiscal_credentials.find(
      (c) => c.fiscal_configuration_id === CONFIG_ID,
    );
    // Never plaintext in storage — the raw password string must not appear.
    expect(creds.tra_password_encrypted).not.toBe("vfdpass");
    expect(JSON.stringify(creds)).not.toContain("vfdpass");
  });

  it("throws when TIN is missing — never registers with a fabricated TIN", async () => {
    const sb = makeFakeSb({ configs: [{ id: CONFIG_ID, tenant_id: TENANT, tin: null }] });
    await expect(registerTraVfd(sb as any, TENANT, CONFIG_ID)).rejects.toMatchObject({
      code: "TRA_CONFIGURATION_REQUIRED",
    });
    expect(traClient.registerVfd).not.toHaveBeenCalled();
  });

  it("a TRA-declined registration throws TRA_REGISTRATION_FAILED and stores nothing", async () => {
    (traClient.registerVfd as any).mockResolvedValue({
      ackCode: "1",
      ackMessage: "Invalid TIN",
      regId: null,
      efdSerial: null,
      uin: null,
      tin: null,
      vrn: null,
      receiptCode: null,
      taxOffice: null,
      region: null,
      username: null,
      password: null,
      tokenPath: null,
      taxCode: null,
      raw: {},
    });
    const sb = makeFakeSb({ configs: [{ id: CONFIG_ID, tenant_id: TENANT, tin: "123-456-789" }] });
    await expect(registerTraVfd(sb as any, TENANT, CONFIG_ID)).rejects.toMatchObject({
      code: "TRA_REGISTRATION_FAILED",
    });
    expect(sb.state.restaurant_fiscal_devices).toHaveLength(0);
  });
});

describe("ensureTraAccessToken — category B (reuse valid, refresh expired)", () => {
  const ORIGINAL = { ...process.env };
  beforeEach(() => {
    process.env.FISCAL_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    vi.clearAllMocks();
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("not registered -> TRA_CONFIGURATION_REQUIRED, never calls the token endpoint", async () => {
    const sb = makeFakeSb({ credentials: [] });
    const result = await ensureTraAccessToken(sb as any, TENANT, CONFIG_ID);
    expect(result).toMatchObject({ error: "TRA_CONFIGURATION_REQUIRED" });
    expect(traClient.requestAccessToken).not.toHaveBeenCalled();
  });

  it("reuses a still-valid stored token — never requests a new one needlessly (spec section 3)", async () => {
    const { encryptFiscalSecret } = await import("./tra/traCrypto.server");
    const sb = makeFakeSb({
      credentials: [
        {
          tenant_id: TENANT,
          fiscal_configuration_id: CONFIG_ID,
          tra_username: "u",
          tra_password_encrypted: encryptFiscalSecret("p"),
          access_token_encrypted: encryptFiscalSecret("still-valid-token"),
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ],
    });
    const result = await ensureTraAccessToken(sb as any, TENANT, CONFIG_ID);
    expect(result).toMatchObject({ token: "still-valid-token" });
    expect(traClient.requestAccessToken).not.toHaveBeenCalled();
  });

  it("requests and stores a new token when the stored one is expired", async () => {
    const { encryptFiscalSecret, decryptFiscalSecret } = await import("./tra/traCrypto.server");
    (traClient.requestAccessToken as any).mockResolvedValue({
      accessToken: "brand-new-token",
      tokenType: "bearer",
      expiresInSeconds: 3600,
    });
    const sb = makeFakeSb({
      credentials: [
        {
          tenant_id: TENANT,
          fiscal_configuration_id: CONFIG_ID,
          tra_username: "u",
          tra_password_encrypted: encryptFiscalSecret("p"),
          access_token_encrypted: encryptFiscalSecret("old-expired-token"),
          expires_at: new Date(Date.now() - 1000).toISOString(),
        },
      ],
    });
    const result = await ensureTraAccessToken(sb as any, TENANT, CONFIG_ID);
    expect(result).toMatchObject({ token: "brand-new-token" });
    const stored = sb.state.restaurant_fiscal_credentials[0];
    expect(decryptFiscalSecret(stored.access_token_encrypted)).toBe("brand-new-token");
  });
});

describe("submitTraZReport — category G", () => {
  const ORIGINAL = { ...process.env };
  beforeEach(() => {
    process.env.TRA_VFD_PRIVATE_KEY_PEM = TEST_TRA_PRIVATE_KEY_PEM;
    process.env.TRA_VFD_CERTIFICATE_PEM = TEST_TRA_CERTIFICATE_PEM;
    process.env.FISCAL_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    vi.clearAllMocks();
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("allocates a progressive ZNUMBER distinct from any receipt's ZNUM and submits", async () => {
    const { encryptFiscalSecret } = await import("./tra/traCrypto.server");
    (traClient.submitZReportXml as any).mockResolvedValue({
      ackCode: "0",
      ackMessage: "OK",
      raw: {},
    });
    const sb = makeFakeSb({
      configs: [{ id: CONFIG_ID, tenant_id: TENANT, tin: "123-456-789", vrn: "VRN1" }],
      devices: [
        {
          tenant_id: TENANT,
          fiscal_configuration_id: CONFIG_ID,
          registration_info: {
            regId: "REG1",
            efdSerial: "EFD1",
            taxOffice: "DAR",
            registeredAt: "2026-01-01",
          },
        },
      ],
      credentials: [
        {
          tenant_id: TENANT,
          fiscal_configuration_id: CONFIG_ID,
          tra_username: "u",
          tra_password_encrypted: encryptFiscalSecret("p"),
          access_token_encrypted: encryptFiscalSecret("tok"),
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ],
      zReports: [
        {
          id: "z-1",
          tenant_id: TENANT,
          business_date: "2026-09-04",
          subtotal: 100000,
          tax_total: 18000,
          total: 118000,
          receipt_count: 5,
        },
      ],
    });
    const zRow = sb.state.restaurant_fiscal_z_reports[0];
    const ack = await submitTraZReport(sb as any, TENANT, CONFIG_ID, zRow as any);
    expect(ack.ackCode).toBe("0");
    expect(ack.zNumber).toBe(1);
    const updated = sb.state.restaurant_fiscal_z_reports[0];
    expect(updated.state).toBe("acknowledged");
    expect(updated.request_xml).toContain("<ZNUMBER>1</ZNUMBER>");
  });

  it("throws when the VFD is not registered — never fabricates REGID/EFDSERIAL for the Z-report", async () => {
    const sb = makeFakeSb({
      configs: [{ id: CONFIG_ID, tenant_id: TENANT, tin: "123-456-789", vrn: "VRN1" }],
      devices: [],
      zReports: [
        {
          id: "z-1",
          tenant_id: TENANT,
          business_date: "2026-09-04",
          subtotal: 0,
          tax_total: 0,
          total: 0,
          receipt_count: 0,
        },
      ],
    });
    await expect(
      submitTraZReport(
        sb as any,
        TENANT,
        CONFIG_ID,
        sb.state.restaurant_fiscal_z_reports[0] as any,
      ),
    ).rejects.toMatchObject({ code: "TRA_CONFIGURATION_REQUIRED" });
    expect(traClient.submitZReportXml).not.toHaveBeenCalled();
  });
});
