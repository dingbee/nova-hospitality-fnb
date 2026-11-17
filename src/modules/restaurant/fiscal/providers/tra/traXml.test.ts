/**
 * TRA VFD XML builder — category C (Receipt XML) plus registration/Z-report
 * XML shape, tax/payment mapping and escaping. Pure functions, no I/O.
 */
import { describe, expect, it } from "vitest";
import {
  buildReceiptBody,
  buildRegistrationSignedContent,
  buildRegistrationXml,
  buildSignedReceiptXml,
  buildSignedZReportXml,
  buildZReportBody,
  escapeXml,
  extractXmlTags,
  formatTraDate,
  formatTraTime,
  formatZNum,
  resolvePaymentCode,
  resolveTaxCode,
} from "./traXml";
import type { TraReceiptFields, TraZReportFields } from "./traTypes";

describe("escapeXml", () => {
  it("escapes all five XML special characters", () => {
    expect(escapeXml(`Tom & Jerry's <Café> "Deluxe"`)).toBe(
      "Tom &amp; Jerry&apos;s &lt;Café&gt; &quot;Deluxe&quot;",
    );
  });
  it("never lets raw < or > from a customer name reach the XML string", () => {
    const evil = `<CUSTNAME>Real</CUSTNAME><INJECTED>true`;
    const escaped = escapeXml(evil);
    expect(escaped).not.toContain("<");
    expect(escaped).not.toContain(">");
  });
  it("passes through null/undefined as empty string", () => {
    expect(escapeXml(null)).toBe("");
    expect(escapeXml(undefined)).toBe("");
  });
});

describe("date/time formatting", () => {
  it("formatTraDate is DD/MM/YYYY", () => {
    expect(formatTraDate(new Date(2026, 2, 5))).toBe("05/03/2026"); // March 5, 2026
  });
  it("formatTraTime is HH:MM:SS, zero-padded", () => {
    expect(formatTraTime(new Date(2026, 0, 1, 9, 5, 3))).toBe("09:05:03");
  });
  it("formatZNum is YYYYMMDD", () => {
    expect(formatZNum(new Date(2026, 8, 4))).toBe("20260904");
  });
});

describe("resolveTaxCode", () => {
  it("18% with no explicit code resolves to A — the one unambiguous case", () => {
    expect(resolveTaxCode(18)).toBe("A");
  });
  it("an explicit taxpayer-configured code always wins, even at a non-standard rate", () => {
    expect(resolveTaxCode(0, "E")).toBe("E");
    expect(resolveTaxCode(18, "B")).toBe("B");
  });
  it("0% with no explicit classification is NEVER guessed — returns null, never defaults to A", () => {
    expect(resolveTaxCode(0)).toBeNull();
    expect(resolveTaxCode(0, null)).toBeNull();
    expect(resolveTaxCode(0, undefined)).toBeNull();
  });
  it("an invalid/unknown explicit code is ignored, not passed through", () => {
    expect(resolveTaxCode(0, "Z")).toBeNull();
    expect(resolveTaxCode(0, "vat18")).toBeNull();
  });
});

describe("resolvePaymentCode", () => {
  it("maps every known LexiBite payment method to a TRA code", () => {
    expect(resolvePaymentCode("cash")).toBe("CASH");
    expect(resolvePaymentCode("card")).toBe("CCARD");
    expect(resolvePaymentCode("mobile_money")).toBe("EMONEY");
    expect(resolvePaymentCode("bank_transfer")).toBe("EMONEY");
    expect(resolvePaymentCode("room_charge")).toBe("INVOICE");
  });
  it("voucher and comp have no TRA settlement equivalent — never fabricated", () => {
    expect(resolvePaymentCode("voucher")).toBeNull();
    expect(resolvePaymentCode("comp")).toBeNull();
  });
  it("an unknown method is never guessed", () => {
    expect(resolvePaymentCode("crypto")).toBeNull();
  });
});

function receiptFields(overrides: Partial<TraReceiptFields> = {}): TraReceiptFields {
  return {
    date: "04/09/2026",
    time: "12:30:00",
    tin: "123-456-789",
    regId: "REG123",
    efdSerial: "EFD00001",
    custIdType: null,
    custId: null,
    custName: null,
    mobileNum: null,
    rctNum: 7,
    dc: 3,
    gc: 7,
    znum: "20260904",
    rctvnum: "RC0000000007",
    items: [
      { id: 1, description: "Classic Chicken Burger", quantity: 2, taxCode: "A", amount: 36000 },
    ],
    totalTaxExcl: 30508.47,
    totalTaxIncl: 36000,
    discount: 0,
    payments: [{ type: "CASH", amount: 36000 }],
    vatTotals: [{ taxCode: "A", netAmount: 30508.47, taxAmount: 5491.53 }],
    ...overrides,
  };
}

describe("buildReceiptBody / buildSignedReceiptXml — category C", () => {
  it("RCTNUM equals GC (spec section 5) and DC/ZNUM/RCTVNUM are all present", () => {
    const body = buildReceiptBody(receiptFields());
    expect(body).toContain("<RCTNUM>7</RCTNUM>");
    expect(body).toContain("<GC>7</GC>");
    expect(body).toContain("<DC>3</DC>");
    expect(body).toContain("<ZNUM>20260904</ZNUM>");
    expect(body).toContain("<RCTVNUM>RC0000000007</RCTVNUM>");
  });

  it("includes correct tax mapping, payment mapping and VAT totals", () => {
    const body = buildReceiptBody(receiptFields());
    expect(body).toContain("<TAXCODE>A</TAXCODE>");
    expect(body).toContain("<PMTTYPE>CASH</PMTTYPE>");
    expect(body).toContain("<PMTAMOUNT>36000.00</PMTAMOUNT>");
    expect(body).toContain("<VATRATE>A</VATRATE>");
    expect(body).toContain("<NETTAMOUNT>30508.47</NETTAMOUNT>");
    expect(body).toContain("<TAXAMOUNT>5491.53</TAXAMOUNT>");
  });

  it("escapes a malicious item description instead of letting it break the XML structure", () => {
    const body = buildReceiptBody(
      receiptFields({
        items: [
          {
            id: 1,
            description: `Burger</DESC><INJECTED>x`,
            quantity: 1,
            taxCode: "A",
            amount: 1000,
          },
        ],
      }),
    );
    expect(body).not.toContain("<INJECTED>");
    expect(body).toContain("&lt;/DESC&gt;&lt;INJECTED&gt;x");
  });

  it("the signed XML wraps the EXACT body string passed to it — never reconstructs it (spec section 7)", () => {
    const body = buildReceiptBody(receiptFields());
    const xml = buildSignedReceiptXml(body, "FAKESIGNATURE==");
    expect(xml).toContain(`<RCT>${body}</RCT>`);
    expect(xml).toContain("<EFDMSSIGNATURE>FAKESIGNATURE==</EFDMSSIGNATURE>");
  });

  it("multiple items and multiple VAT classes each get their own line", () => {
    const body = buildReceiptBody(
      receiptFields({
        items: [
          { id: 1, description: "Soda", quantity: 2, taxCode: "A", amount: 4000 },
          { id: 2, description: "Bread (zero-rated)", quantity: 1, taxCode: "C", amount: 1000 },
        ],
        vatTotals: [
          { taxCode: "A", netAmount: 3389.83, taxAmount: 610.17 },
          { taxCode: "C", netAmount: 1000, taxAmount: 0 },
        ],
      }),
    );
    expect(body).toContain("<ID>1</ID>");
    expect(body).toContain("<ID>2</ID>");
    expect((body.match(/<VATTOTAL>/g) ?? []).length).toBe(2);
  });
});

describe("buildRegistrationXml — spec section 2", () => {
  it("REGDATA carries TIN, CERTKEY and EFDMSSIGNATURE together, signature last", () => {
    const signedContent = buildRegistrationSignedContent("123-456-789", "CERTKEY-ABC");
    const xml = buildRegistrationXml("123-456-789", "CERTKEY-ABC", "SIGBASE64==");
    expect(xml).toContain("<TIN>123-456-789</TIN>");
    expect(xml).toContain("<CERTKEY>CERTKEY-ABC</CERTKEY>");
    expect(xml).toContain("<EFDMSSIGNATURE>SIGBASE64==</EFDMSSIGNATURE>");
    // The signed content is exactly what appears before the signature tag.
    expect(xml).toContain(`${signedContent}<EFDMSSIGNATURE>SIGBASE64==</EFDMSSIGNATURE>`);
  });
});

function zReportFields(overrides: Partial<TraZReportFields> = {}): TraZReportFields {
  return {
    date: "04/09/2026",
    time: "23:59:00",
    header: "Z REPORT",
    vrn: "VRN0001",
    tin: "123-456-789",
    taxOffice: "Dar es Salaam",
    regId: "REG123",
    zNumber: 12,
    efdSerial: "EFD00001",
    registrationDate: "2026-01-01T00:00:00.000Z",
    user: "SYSTEM",
    simImsi: "",
    totalTaxExcl: 100000,
    totalTaxIncl: 118000,
    vatTotals: [{ taxCode: "A", netAmount: 100000, taxAmount: 18000 }],
    payments: [{ type: "CASH", amount: 118000 }],
    ...overrides,
  };
}

describe("buildZReportBody — spec section 11", () => {
  it("ZNUMBER (progressive) never gets confused with ZNUM (YYYYMMDD, a receipt concept)", () => {
    const body = buildZReportBody(zReportFields({ zNumber: 42 }));
    expect(body).toContain("<ZNUMBER>42</ZNUMBER>");
    expect(body).not.toContain("<ZNUM>");
  });
  it("includes FWVERSION 3.0 and FWCHECKSUM WEBAPI as documented", () => {
    const body = buildZReportBody(zReportFields());
    expect(body).toContain("<FWVERSION>3.0</FWVERSION>");
    expect(body).toContain("<FWCHECKSUM>WEBAPI</FWCHECKSUM>");
  });
  it("the signed Z-report XML wraps the exact body, unchanged", () => {
    const body = buildZReportBody(zReportFields());
    const xml = buildSignedZReportXml(body, "ZSIG==");
    expect(xml).toContain(`<ZREPORT>${body}</ZREPORT>`);
  });
});

describe("extractXmlTags — response parsing", () => {
  it("extracts only the requested tags from a flat TRA-style response", () => {
    const xml = "<EFDMS><ACKCODE>0</ACKCODE><ACKMSG>Received &amp; Accepted</ACKMSG></EFDMS>";
    const fields = extractXmlTags(xml, ["ACKCODE", "ACKMSG"]);
    expect(fields.ACKCODE).toBe("0");
    expect(fields.ACKMSG).toBe("Received & Accepted");
  });
  it("a missing tag is simply absent, never throws", () => {
    const fields = extractXmlTags("<EFDMS></EFDMS>", ["ACKCODE"]);
    expect(fields.ACKCODE).toBeUndefined();
  });
});
