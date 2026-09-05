/**
 * TRA HTTP client — category A (registration), B (token), D (receipt
 * submission ACK/timeout/network/malformed), G (Z-report ACK). Every test
 * mocks global fetch — nothing here reaches a real network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerVfd,
  requestAccessToken,
  submitReceiptXml,
  submitZReportXml,
} from "./traClient.server";
import { TraProtocolError } from "./traTypes";

function mockFetchOnce(
  impl: (
    url: string,
    init: RequestInit & { headers: Record<string, string> },
  ) => Promise<{
    ok: boolean;
    status: number;
    text?: () => Promise<string>;
    json?: () => Promise<unknown>;
  }>,
) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("registerVfd — category A", () => {
  it("parses a successful registration response", async () => {
    mockFetchOnce(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        "<EFDMS><ACKCODE>0</ACKCODE><ACKMSG>OK</ACKMSG><REGID>REG123</REGID><EFDSERIAL>EFD001</EFDSERIAL><UIN>UIN1</UIN><RECEIPTCODE>RC</RECEIPTCODE><TAXOFFICE>DAR</TAXOFFICE><REGION>DSM</REGION><USERNAME>u1</USERNAME><PASSWORD>p1</PASSWORD></EFDMS>",
    }));
    const res = await registerVfd("<EFDMS>...</EFDMS>", "SERIALB64");
    expect(res.ackCode).toBe("0");
    expect(res.regId).toBe("REG123");
    expect(res.efdSerial).toBe("EFD001");
    expect(res.username).toBe("u1");
    expect(res.password).toBe("p1");
  });

  it("rejects a registration TRA declined, never fabricating a REGID", async () => {
    mockFetchOnce(async () => ({
      ok: true,
      status: 200,
      text: async () => "<EFDMS><ACKCODE>1</ACKCODE><ACKMSG>Invalid TIN</ACKMSG></EFDMS>",
    }));
    const res = await registerVfd("<EFDMS>...</EFDMS>", "SERIALB64");
    expect(res.ackCode).toBe("1");
    expect(res.regId).toBeNull();
  });

  it("throws TRA_REGISTRATION_FAILED on a non-2xx HTTP response", async () => {
    mockFetchOnce(async () => ({ ok: false, status: 500, text: async () => "" }));
    await expect(registerVfd("<EFDMS/>", "S")).rejects.toMatchObject({
      code: "TRA_REGISTRATION_FAILED",
    });
  });

  it("throws TRA_INVALID_XML on a response with no ACKCODE — never crashes silently", async () => {
    mockFetchOnce(async () => ({ ok: true, status: 200, text: async () => "not xml at all" }));
    await expect(registerVfd("<EFDMS/>", "S")).rejects.toMatchObject({ code: "TRA_INVALID_XML" });
  });
});

describe("requestAccessToken — category B", () => {
  it("posts x-www-form-urlencoded with grant_type=password", async () => {
    let capturedBody = "";
    let capturedContentType = "";
    mockFetchOnce(async (_url, init) => {
      capturedBody = String(init.body);
      capturedContentType = init.headers["Content-Type"];
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "tok123", token_type: "bearer", expires_in: 3600 }),
      };
    });
    const res = await requestAccessToken("user1", "pass1");
    expect(capturedContentType).toBe("application/x-www-form-urlencoded");
    expect(capturedBody).toContain("grant_type=password");
    expect(capturedBody).toContain("username=user1");
    expect(capturedBody).toContain("password=pass1");
    expect(res.accessToken).toBe("tok123");
    expect(res.expiresInSeconds).toBe(3600);
  });

  it("classifies a 401 as TRA_AUTHENTICATION_FAILED", async () => {
    mockFetchOnce(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    await expect(requestAccessToken("bad", "creds")).rejects.toMatchObject({
      code: "TRA_AUTHENTICATION_FAILED",
    });
  });

  it("a response with no access_token is treated as an authentication failure, not a crash", async () => {
    mockFetchOnce(async () => ({ ok: true, status: 200, json: async () => ({ foo: "bar" }) }));
    await expect(requestAccessToken("u", "p")).rejects.toMatchObject({
      code: "TRA_AUTHENTICATION_FAILED",
    });
  });
});

describe("submitReceiptXml — category D", () => {
  it("ACKCODE 0 is success", async () => {
    mockFetchOnce(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        "<EFDMS><ACKCODE>0</ACKCODE><ACKMSG>Accepted</ACKMSG><RCTNUM>7</RCTNUM></EFDMS>",
    }));
    const ack = await submitReceiptXml("<xml/>", "SERIAL", "token123");
    expect(ack.ackCode).toBe("0");
    expect(ack.rctNum).toBe("7");
  });

  it("a non-zero ACKCODE is returned, not thrown — the caller decides rejected vs retry", async () => {
    mockFetchOnce(async () => ({
      ok: true,
      status: 200,
      text: async () => "<EFDMS><ACKCODE>3</ACKCODE><ACKMSG>Duplicate</ACKMSG></EFDMS>",
    }));
    const ack = await submitReceiptXml("<xml/>", "SERIAL", "token123");
    expect(ack.ackCode).toBe("3");
  });

  it("HTTP 401/403 is classified as TRA_TOKEN_EXPIRED", async () => {
    mockFetchOnce(async () => ({ ok: false, status: 401, text: async () => "" }));
    await expect(submitReceiptXml("<xml/>", "SERIAL", "expired")).rejects.toMatchObject({
      code: "TRA_TOKEN_EXPIRED",
    });
  });

  it("a network failure (fetch rejects) is classified as TRA_NETWORK_ERROR", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(submitReceiptXml("<xml/>", "SERIAL", "token")).rejects.toMatchObject({
      code: "TRA_NETWORK_ERROR",
    });
  });

  it("an AbortError (timeout) is classified as TRA_TIMEOUT, never silently treated as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }),
    );
    await expect(submitReceiptXml("<xml/>", "SERIAL", "token")).rejects.toMatchObject({
      code: "TRA_TIMEOUT",
    });
  });

  it("a malformed response body throws TRA_INVALID_XML rather than crashing", async () => {
    mockFetchOnce(async () => ({ ok: true, status: 200, text: async () => "<<<not xml" }));
    await expect(submitReceiptXml("<xml/>", "SERIAL", "token")).rejects.toBeInstanceOf(
      TraProtocolError,
    );
  });
});

describe("submitZReportXml — category G", () => {
  it("parses a successful Z-report ACK", async () => {
    mockFetchOnce(async () => ({
      ok: true,
      status: 200,
      text: async () => "<EFDMS><ACKCODE>0</ACKCODE><ACKMSG>Z-report accepted</ACKMSG></EFDMS>",
    }));
    const ack = await submitZReportXml("<xml/>", "SERIAL", "token");
    expect(ack.ackCode).toBe("0");
  });

  it("a rejected Z-report ACK is returned with its message, never thrown as success", async () => {
    mockFetchOnce(async () => ({
      ok: true,
      status: 200,
      text: async () => "<EFDMS><ACKCODE>9</ACKCODE><ACKMSG>Sequence mismatch</ACKMSG></EFDMS>",
    }));
    const ack = await submitZReportXml("<xml/>", "SERIAL", "token");
    expect(ack.ackCode).toBe("9");
    expect(ack.ackMessage).toMatch(/sequence/i);
  });
});
