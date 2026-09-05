/**
 * TRA VFD (Virtual Fiscal Device) protocol types — shared between the pure
 * XML builder (traXml.ts) and the server-only HTTP client (traClient.server.ts).
 * Browser-safe: types only, no I/O, no secrets.
 *
 * Field names and endpoints follow the TRA VFD WebAPI documented at
 * https://tra-docs.netlify.app/guide/api/ (TEST/sandbox host:
 * virtual.tra.go.tz) as reproduced in this sprint's specification. This
 * environment's network egress to that host is blocked (see final report),
 * so exact XML nesting could not be re-verified byte-for-byte against the
 * live docs during this implementation — the field lists below are taken
 * directly from the specification's own transcription of that page.
 */

export const TRA_TEST_BASE_URL = "https://virtual.tra.go.tz";
export const TRA_TEST_ENDPOINTS = {
  registration: `${TRA_TEST_BASE_URL}/efdmsRctApi/api/vfdRegReq`,
  token: `${TRA_TEST_BASE_URL}/efdmsRctApi/vfdtoken`,
  receipt: `${TRA_TEST_BASE_URL}/efdmsRctApi/api/efdmsRctInfo`,
  zReport: `${TRA_TEST_BASE_URL}/efdmsRctApi/api/efdmszreport`,
  verify: `${TRA_TEST_BASE_URL}/efdmsRctVerify/Home/Index`,
} as const;

/** The only host TEST mode is ever allowed to talk to (spec section 17). */
export const TRA_TEST_ALLOWED_HOST = "virtual.tra.go.tz";

// ---------------------------------------------------------------------------
// Tax classification (spec section 6 / 25) — never invented per line: A is
// only assigned when the rate is unambiguously 18%; every other case must
// come from an explicit, taxpayer-configured restaurant_tax_rules.tra_tax_code.
// ---------------------------------------------------------------------------
export const TRA_TAX_CODES = ["A", "B", "C", "D", "E"] as const;
export type TraTaxCode = (typeof TRA_TAX_CODES)[number];

export const TRA_TAX_RATE_BY_CODE: Record<TraTaxCode, number> = {
  A: 18,
  B: 0,
  C: 0,
  D: 0,
  E: 0,
};

// ---------------------------------------------------------------------------
// Payment type mapping (spec section 6) — LexiBite's POS_PAYMENT_METHODS
// mapped to TRA's five documented receipt payment types. "voucher" and
// "comp" have no faithful TRA settlement equivalent (they are not a form of
// payment settlement at all) and are deliberately left unmapped: a line
// using either must fail fiscalization with TRA_INVALID_XML rather than
// submit a guessed code.
// ---------------------------------------------------------------------------
export const TRA_PAYMENT_CODES = ["CASH", "CHEQUE", "CCARD", "EMONEY", "INVOICE"] as const;
export type TraPaymentCode = (typeof TRA_PAYMENT_CODES)[number];

export const PAYMENT_METHOD_TO_TRA_CODE: Record<string, TraPaymentCode | undefined> = {
  cash: "CASH",
  card: "CCARD",
  mobile_money: "EMONEY",
  bank_transfer: "EMONEY",
  room_charge: "INVOICE",
};

// ---------------------------------------------------------------------------
// Deterministic error taxonomy (spec section 20).
// ---------------------------------------------------------------------------
export const TRA_ERROR_CODES = [
  "TRA_CONFIGURATION_REQUIRED",
  "TRA_CERTIFICATE_MISSING",
  "TRA_CERTIFICATE_INVALID",
  "TRA_CERTIFICATE_PASSWORD_INVALID",
  "TRA_REGISTRATION_FAILED",
  "TRA_AUTHENTICATION_FAILED",
  "TRA_TOKEN_EXPIRED",
  "TRA_NETWORK_ERROR",
  "TRA_TIMEOUT",
  "TRA_REJECTED",
  "TRA_DUPLICATE",
  "TRA_INVALID_XML",
  "TRA_SIGNATURE_FAILED",
  "TRA_SEQUENCE_ERROR",
  "TRA_Z_REPORT_FAILED",
] as const;
export type TraErrorCode = (typeof TRA_ERROR_CODES)[number];

export class TraProtocolError extends Error {
  readonly code: TraErrorCode;
  constructor(code: TraErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "TraProtocolError";
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
export interface TraRegistrationResponse {
  ackCode: string;
  ackMessage: string;
  regId: string | null;
  efdSerial: string | null;
  uin: string | null;
  tin: string | null;
  vrn: string | null;
  receiptCode: string | null;
  taxOffice: string | null;
  region: string | null;
  username: string | null;
  password: string | null;
  tokenPath: string | null;
  taxCode: string | null;
  raw: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------
export interface TraTokenResponse {
  accessToken: string;
  tokenType: string;
  expiresInSeconds: number;
}

// ---------------------------------------------------------------------------
// Receipt line / totals inputs to the XML builder — already resolved by the
// caller (fiscal.server.ts); traXml.ts does no lookups of its own.
// ---------------------------------------------------------------------------
export interface TraReceiptLine {
  id: number;
  description: string;
  quantity: number;
  taxCode: TraTaxCode;
  amount: number;
}

export interface TraReceiptPayment {
  type: TraPaymentCode;
  amount: number;
}

export interface TraVatTotal {
  taxCode: TraTaxCode;
  netAmount: number;
  taxAmount: number;
}

export interface TraReceiptFields {
  date: string; // DD/MM/YYYY — frozen at first submission attempt
  time: string; // HH:MM:SS — frozen at first submission attempt
  tin: string;
  regId: string;
  efdSerial: string;
  custIdType: string | null;
  custId: string | null;
  custName: string | null;
  mobileNum: string | null;
  rctNum: number; // = GC
  dc: number;
  gc: number;
  znum: string; // YYYYMMDD, receipt's original fiscal-day
  rctvnum: string; // RECEIPTCODE + GC
  items: TraReceiptLine[];
  totalTaxExcl: number;
  totalTaxIncl: number;
  discount: number;
  payments: TraReceiptPayment[];
  vatTotals: TraVatTotal[];
}

export interface TraReceiptAck {
  ackCode: string;
  ackMessage: string;
  rctNum: string | null;
  date: string | null;
  time: string | null;
  raw: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Z report
// ---------------------------------------------------------------------------
export interface TraZReportFields {
  date: string;
  time: string;
  header: string;
  vrn: string;
  tin: string;
  taxOffice: string | null;
  regId: string;
  zNumber: number; // ZNUMBER — progressive, distinct from ZNUM
  efdSerial: string;
  registrationDate: string | null;
  user: string;
  simImsi: string;
  totalTaxExcl: number;
  totalTaxIncl: number;
  vatTotals: TraVatTotal[];
  payments: TraReceiptPayment[];
}

export interface TraZReportAck {
  ackCode: string;
  ackMessage: string;
  raw: Record<string, string>;
}
