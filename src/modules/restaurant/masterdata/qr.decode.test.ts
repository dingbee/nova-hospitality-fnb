/**
 * GEP6 — QR correctness, spec section 12 (A-J). Every test here runs the
 * REAL encoder (`qrcode`, the same one the browser card/pack renderer
 * uses) end to end: encode a PNG buffer -> decode its raw pixels with an
 * INDEPENDENT decoder (`jsqr`, never the same code path that encoded it)
 * -> assert the decoded text is exactly the expected guest URL. This is
 * the strongest correctness proof available without a physical camera —
 * see the GEP6 final report for the honest disclosure that a literal
 * phone scan could not be performed in this sandboxed environment, and
 * for the parallel proof against the real production table ids.
 *
 * `jsqr` + `pngjs` are devDependencies used ONLY here — never imported by
 * application code (the browser card/pack renderer uses `qrcode`'s own
 * canvas API and never needs to decode anything itself).
 */
import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { PNG } from "pngjs";
import jsQR from "jsqr";
import {
  LOGO_MAX_QR_FRACTION,
  buildGuestOrderUrl,
  buildTableQrCard,
  resolveQrRenderOptions,
} from "./qr";

const TABLE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TABLE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const TENANT_A = {
  name: "Kilimanjaro Hospitality Ltd",
  settings: { business: { tradingName: "Kilimanjaro Grill", logoUrl: null } },
};
const ORIGIN = "https://nova-hospitality-fnb.vercel.app";

/** Encodes `text` exactly the way the browser card renderer will, then decodes it back with an independent library. Returns the decoded text, or null if the decoder found nothing. */
async function encodeThenDecode(text: string, hasLogo = false): Promise<string | null> {
  const opts = resolveQrRenderOptions(hasLogo);
  const buf = await QRCode.toBuffer(text, {
    type: "png",
    errorCorrectionLevel: opts.errorCorrectionLevel,
    margin: opts.margin,
    width: opts.width,
  });
  const png = PNG.sync.read(buf);
  const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return result?.data ?? null;
}

/** Paints an opaque square of the given fraction of width, centered — simulating a composited logo, without needing an actual image file or a browser canvas. */
function overlayCenteredSquare(png: PNG, fraction: number) {
  const size = Math.floor(png.width * fraction);
  const startX = Math.floor((png.width - size) / 2);
  const startY = Math.floor((png.height - size) / 2);
  for (let y = startY; y < startY + size; y++) {
    for (let x = startX; x < startX + size; x++) {
      const idx = (png.width * y + x) << 2;
      png.data[idx] = 255;
      png.data[idx + 1] = 255;
      png.data[idx + 2] = 255;
      png.data[idx + 3] = 255;
    }
  }
}

describe("QR correctness — real encode, independent decode (spec section 12)", () => {
  it("A: Table A's QR decodes to exactly Table A's /order/{tableA.id} URL", async () => {
    const url = buildGuestOrderUrl(ORIGIN, TABLE_A);
    const decoded = await encodeThenDecode(url);
    expect(decoded).toBe(url);
  });

  it("B: Table B's QR decodes to a different URL than Table A's", async () => {
    const urlA = buildGuestOrderUrl(ORIGIN, TABLE_A);
    const urlB = buildGuestOrderUrl(ORIGIN, TABLE_B);
    const [decodedA, decodedB] = await Promise.all([
      encodeThenDecode(urlA),
      encodeThenDecode(urlB),
    ]);
    expect(decodedA).toBe(urlA);
    expect(decodedB).toBe(urlB);
    expect(decodedA).not.toBe(decodedB);
  });

  it("C: renaming Table A does not change what its QR decodes to — the URL is bound to the id, never the display name", async () => {
    const before = buildTableQrCard(
      TENANT_A,
      { id: TABLE_A, code: "T01", name: "Table 01" },
      ORIGIN,
    );
    const after = buildTableQrCard(
      TENANT_A,
      { id: TABLE_A, code: "PATIO-1", name: "Patio Table (renamed)" },
      ORIGIN,
    );
    const [decodedBefore, decodedAfter] = await Promise.all([
      encodeThenDecode(before.guestUrl),
      encodeThenDecode(after.guestUrl),
    ]);
    expect(decodedBefore).toBe(before.guestUrl);
    expect(decodedAfter).toBe(after.guestUrl);
    expect(decodedAfter).toBe(decodedBefore);
  });

  it("D: regenerating/downloading Table A's QR a second time produces the identical destination", async () => {
    const url = buildGuestOrderUrl(ORIGIN, TABLE_A);
    const [first, second] = await Promise.all([encodeThenDecode(url), encodeThenDecode(url)]);
    expect(first).toBe(url);
    expect(second).toBe(url);
  });

  it("E: a QR built from Tenant A's own card data can never encode Tenant B's table — the card function only ever reads the id it was given", async () => {
    const tenantACard = buildTableQrCard(
      TENANT_A,
      { id: TABLE_A, code: "T01", name: "Table 01" },
      ORIGIN,
    );
    const tenantBCard = buildTableQrCard(
      { name: "A Different Restaurant", settings: null },
      { id: TABLE_B, code: "T01", name: "Table 01" }, // same code/name, DIFFERENT tenant's table id
      ORIGIN,
    );
    const [decodedA, decodedB] = await Promise.all([
      encodeThenDecode(tenantACard.guestUrl),
      encodeThenDecode(tenantBCard.guestUrl),
    ]);
    expect(decodedA).toContain(TABLE_A);
    expect(decodedB).toContain(TABLE_B);
    expect(decodedA).not.toContain(TABLE_B);
    expect(decodedB).not.toContain(TABLE_A);
  });

  it("G: a table with no logo configured still produces a cleanly decodable QR", async () => {
    const card = buildTableQrCard(
      { name: "X", settings: null },
      { id: TABLE_A, code: "T01", name: "Table 01" },
      ORIGIN,
    );
    expect(card.businessLogoUrl).toBeNull();
    const decoded = await encodeThenDecode(card.guestUrl, false);
    expect(decoded).toBe(card.guestUrl);
  });

  it("H: the resolved brand name is present on the card alongside a correctly-decoding QR", async () => {
    const card = buildTableQrCard(TENANT_A, { id: TABLE_A, code: "T01", name: "Table 01" }, ORIGIN);
    expect(card.businessName).toBe("Kilimanjaro Grill");
    const decoded = await encodeThenDecode(card.guestUrl);
    expect(decoded).toBe(card.guestUrl);
  });

  it("a level-H QR with a centered logo covering the configured max fraction still decodes correctly — scan reliability survives the logo", async () => {
    const url = buildGuestOrderUrl(ORIGIN, TABLE_A);
    const opts = resolveQrRenderOptions(true);
    expect(opts.errorCorrectionLevel).toBe("H");
    const buf = await QRCode.toBuffer(url, {
      type: "png",
      errorCorrectionLevel: opts.errorCorrectionLevel,
      margin: opts.margin,
      width: opts.width,
    });
    const png = PNG.sync.read(buf);
    overlayCenteredSquare(png, LOGO_MAX_QR_FRACTION);
    const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    expect(result?.data).toBe(url);
  });

  it("a level-M QR (no logo) generated at native print resolution decodes cleanly — never a tiny code upscaled after the fact", async () => {
    const url = buildGuestOrderUrl(ORIGIN, TABLE_A);
    const opts = resolveQrRenderOptions(false);
    expect(opts.width).toBeGreaterThanOrEqual(600);
    const decoded = await encodeThenDecode(url, false);
    expect(decoded).toBe(url);
  });
});
