/**
 * TRA VFD XML — the one deterministic serializer/escaper/parser for the TRA
 * protocol (spec section 6/7/28: build ONE dedicated builder, never
 * concatenate XML strings elsewhere in the codebase). Pure and browser-safe:
 * no Supabase, no fetch, no signing key material — every function here is a
 * plain string transform, fully unit-testable without I/O.
 *
 * Exact tag nesting reproduces this sprint's own specification (itself a
 * transcription of https://tra-docs.netlify.app/guide/api/); this
 * environment's network egress to that host was blocked when an attempt was
 * made to re-verify it live (see final report), so treat the receipt/Z-report
 * element ordering as "best-effort per the given spec", not "confirmed
 * byte-for-byte against TRA". The one guarantee that does NOT depend on that
 * verification: buildReceiptBody()/buildZReportBody() return the exact string
 * that gets signed AND the exact string embedded in the final envelope —
 * nothing is rebuilt between signing and sending (spec section 7).
 */
import {
  PAYMENT_METHOD_TO_TRA_CODE,
  TRA_TAX_CODES,
  type TraPaymentCode,
  type TraReceiptFields,
  type TraTaxCode,
  type TraZReportFields,
} from "./traTypes";

// ---------------------------------------------------------------------------
// Escaping — every free-text field (customer name, item description,
// business name, address) goes through this before touching an XML string.
// ---------------------------------------------------------------------------
export function escapeXml(value: string | null | undefined): string {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tag(name: string, value: string | number): string {
  return `<${name}>${typeof value === "number" ? value : escapeXml(value)}</${name}>`;
}

function money(n: number): string {
  return (Number.isFinite(n) ? n : 0).toFixed(2);
}

// ---------------------------------------------------------------------------
// Date/time — TRA VFD fields are DD/MM/YYYY and HH:MM:SS, ZNUM is YYYYMMDD.
// ---------------------------------------------------------------------------
function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

export function formatTraDate(d: Date): string {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function formatTraTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatZNum(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

// ---------------------------------------------------------------------------
// Tax / payment mapping (spec section 6) — never fabricate; return null and
// let the caller fail configuration/validation instead of guessing.
// ---------------------------------------------------------------------------
export function resolveTaxCode(rate: number, explicitCode?: string | null): TraTaxCode | null {
  if (explicitCode && (TRA_TAX_CODES as readonly string[]).includes(explicitCode)) {
    return explicitCode as TraTaxCode;
  }
  // The only classification derivable from a bare rate without an explicit,
  // taxpayer-configured mapping: TRA's standard 18% rate is unambiguously A.
  // A 0% rate could legally be B, C, D or E — that requires the operator to
  // have set restaurant_tax_rules.tra_tax_code explicitly.
  if (Math.abs(rate - 18) < 0.005) return "A";
  return null;
}

export function resolvePaymentCode(method: string): TraPaymentCode | null {
  return PAYMENT_METHOD_TO_TRA_CODE[method] ?? null;
}

// ---------------------------------------------------------------------------
// Registration — spec section 2. Signature is computed over REGDATA's own
// content (TIN + CERTKEY) before EFDMSSIGNATURE is appended alongside it.
// ---------------------------------------------------------------------------
export function buildRegistrationSignedContent(tin: string, certKey: string): string {
  return `${tag("TIN", tin)}${tag("CERTKEY", certKey)}`;
}

export function buildRegistrationXml(
  tin: string,
  certKey: string,
  signatureBase64: string,
): string {
  const regData = `${buildRegistrationSignedContent(tin, certKey)}${tag("EFDMSSIGNATURE", signatureBase64)}`;
  return `<?xml version="1.0" encoding="UTF-8"?><EFDMS><REGDATA>${regData}</REGDATA></EFDMS>`;
}

// ---------------------------------------------------------------------------
// Receipt — spec sections 5/6. buildReceiptBody() is the exact byte sequence
// that must be signed; buildSignedReceiptXml() only ever wraps that same
// string, never reconstructs it.
// ---------------------------------------------------------------------------
export function buildReceiptBody(fields: TraReceiptFields): string {
  const items = fields.items
    .map((it) =>
      [
        "<ITEM>",
        tag("ID", it.id),
        tag("DESC", it.description),
        tag("QTY", it.quantity),
        tag("TAXCODE", it.taxCode),
        tag("AMT", money(it.amount)),
        "</ITEM>",
      ].join(""),
    )
    .join("");

  const payments = fields.payments
    .map((p) => `<PAYMENT>${tag("PMTTYPE", p.type)}${tag("PMTAMOUNT", money(p.amount))}</PAYMENT>`)
    .join("");

  const vatTotals = fields.vatTotals
    .map(
      (v) =>
        `<VATTOTAL>${tag("VATRATE", v.taxCode)}${tag("NETTAMOUNT", money(v.netAmount))}${tag("TAXAMOUNT", money(v.taxAmount))}</VATTOTAL>`,
    )
    .join("");

  return [
    tag("DATE", fields.date),
    tag("TIME", fields.time),
    tag("TIN", fields.tin),
    tag("REGID", fields.regId),
    tag("EFDSERIAL", fields.efdSerial),
    fields.custIdType ? tag("CUSTIDTYPE", fields.custIdType) : "",
    fields.custId ? tag("CUSTID", fields.custId) : "",
    fields.custName ? tag("CUSTNAME", fields.custName) : "",
    fields.mobileNum ? tag("MOBILENUM", fields.mobileNum) : "",
    tag("RCTNUM", fields.rctNum),
    tag("DC", fields.dc),
    tag("GC", fields.gc),
    tag("ZNUM", fields.znum),
    tag("RCTVNUM", fields.rctvnum),
    `<ITEMS>${items}</ITEMS>`,
    `<TOTALS>${tag("TOTALTAXEXCL", money(fields.totalTaxExcl))}${tag("TOTALTAXINCL", money(fields.totalTaxIncl))}${tag("DISCOUNT", money(fields.discount))}</TOTALS>`,
    `<PAYMENTS>${payments}</PAYMENTS>`,
    `<VATTOTALS>${vatTotals}</VATTOTALS>`,
  ].join("");
}

export function buildSignedReceiptXml(body: string, signatureBase64: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><EFDMS><RCT>${body}</RCT>${tag("EFDMSSIGNATURE", signatureBase64)}</EFDMS>`;
}

// ---------------------------------------------------------------------------
// Z report — spec section 11. ZNUMBER (progressive) is a distinct concept
// from a receipt's ZNUM (YYYYMMDD) — this builder never conflates them.
// ---------------------------------------------------------------------------
export function buildZReportBody(fields: TraZReportFields): string {
  const vatTotals = fields.vatTotals
    .map(
      (v) =>
        `<VATTOTAL>${tag("VATRATE", v.taxCode)}${tag("NETTAMOUNT", money(v.netAmount))}${tag("TAXAMOUNT", money(v.taxAmount))}</VATTOTAL>`,
    )
    .join("");
  const payments = fields.payments
    .map((p) => `<PAYMENT>${tag("PMTTYPE", p.type)}${tag("PMTAMOUNT", money(p.amount))}</PAYMENT>`)
    .join("");

  return [
    tag("DATE", fields.date),
    tag("TIME", fields.time),
    tag("HEADER", fields.header),
    tag("VRN", fields.vrn),
    tag("TIN", fields.tin),
    fields.taxOffice ? tag("TAXOFFICE", fields.taxOffice) : "",
    tag("REGID", fields.regId),
    tag("ZNUMBER", fields.zNumber),
    tag("EFDSERIAL", fields.efdSerial),
    fields.registrationDate ? tag("REGISTRATIONDATE", fields.registrationDate) : "",
    tag("USER", fields.user),
    tag("SIMIMSI", fields.simImsi),
    tag("FWVERSION", "3.0"),
    tag("FWCHECKSUM", "WEBAPI"),
    `<TOTALS>${tag("TOTALTAXEXCL", money(fields.totalTaxExcl))}${tag("TOTALTAXINCL", money(fields.totalTaxIncl))}</TOTALS>`,
    `<VATTOTALS>${vatTotals}</VATTOTALS>`,
    `<PAYMENTS>${payments}</PAYMENTS>`,
    "<CHANGES></CHANGES>",
    "<ERRORS></ERRORS>",
  ].join("");
}

export function buildSignedZReportXml(body: string, signatureBase64: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><EFDMS><ZREPORT>${body}</ZREPORT>${tag("EFDMSSIGNATURE", signatureBase64)}</EFDMS>`;
}

// ---------------------------------------------------------------------------
// Response parsing — TRA's documented responses are flat (no repeated
// elements), so a constrained per-tag extraction is safe and avoids pulling
// in a general-purpose XML parser for a handful of known fields. Anything
// that isn't one of the requested tags is never looked at.
// ---------------------------------------------------------------------------
export function extractXmlTags(xml: string, tagNames: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of tagNames) {
    const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(xml);
    if (match) out[name] = unescapeXml(match[1].trim());
  }
  return out;
}
