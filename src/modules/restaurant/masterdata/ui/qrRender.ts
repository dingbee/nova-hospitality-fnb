/**
 * GEP6 — browser-only QR/PDF rendering. Everything here is DOM/canvas
 * dependent (Image, canvas 2d context, Blob download) and is deliberately
 * NOT unit-tested via a simulated DOM — jsdom/happy-dom canvas support is
 * unreliable for real pixel output. Correctness of what actually gets
 * ENCODED is proven deterministically in qr.decode.test.ts (real encode,
 * independent decode); this module only composes that same encoded QR
 * with text/branding for a human to look at or print. See the GEP6 final
 * report for the manual verification performed against this exact code
 * path (Node-equivalent rendering, since no browser is available in this
 * sandbox — the identical `qrcode` calls and identical LOGO_MAX_QR_FRACTION
 * constant are exercised there too).
 */
import QRCode from "qrcode";
import { jsPDF } from "jspdf";
import { LOGO_MAX_QR_FRACTION, resolveQrRenderOptions, type TableQrCard } from "../qr";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // the tenant logo is served from GEP4's public-read storage bucket
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("logo unavailable"));
    img.src = src;
  });
}

function makeCanvas(
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas rendering is not available in this browser.");
  return { canvas, ctx };
}

/**
 * The QR itself, with the business logo composited on top when one is
 * configured — nothing else. Native resolution, never upscaled (spec
 * section 6). Logo capped at LOGO_MAX_QR_FRACTION and backed by a white
 * plate so it never blends into adjacent QR modules; a logo that fails to
 * load (network hiccup, deleted asset) is silently skipped — QR
 * generation must never fail because the logo is unavailable (spec
 * section 10).
 */
async function renderQrOnly(card: TableQrCard, widthOverride?: number): Promise<HTMLCanvasElement> {
  const hasLogo = Boolean(card.businessLogoUrl);
  const opts = resolveQrRenderOptions(hasLogo);
  const dataUrl = await QRCode.toDataURL(card.guestUrl, {
    errorCorrectionLevel: opts.errorCorrectionLevel,
    margin: opts.margin,
    width: widthOverride ?? opts.width,
  });
  const qrImage = await loadImage(dataUrl);
  const { canvas, ctx } = makeCanvas(qrImage.width, qrImage.height);
  ctx.drawImage(qrImage, 0, 0);

  if (card.businessLogoUrl) {
    try {
      const logo = await loadImage(card.businessLogoUrl);
      const size = canvas.width * LOGO_MAX_QR_FRACTION;
      const x = (canvas.width - size) / 2;
      const y = (canvas.height - size) / 2;
      const pad = size * 0.12;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x - pad, y - pad, size + pad * 2, size + pad * 2);
      ctx.drawImage(logo, x, y, size, size);
    } catch {
      // Logo failed to load — the plain QR (already rendered above) stands on its own.
    }
  }

  return canvas;
}

export interface RenderedQrCard {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * The full printable card (spec section 3): business name, TABLE label,
 * the QR (with logo composited per renderQrOnly), and a "Scan to order"
 * caption. What the "View QR" dialog previews is exactly this image, and
 * "Download QR" saves this exact PNG — no separate preview/download
 * rendering paths to drift apart.
 */
export async function renderTableQrCard(card: TableQrCard): Promise<RenderedQrCard> {
  const qrCanvas = await renderQrOnly(card);
  const width = 1200;
  const height = 1600;
  const { canvas, ctx } = makeCanvas(width, height);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.textAlign = "center";
  ctx.fillStyle = "#111111";

  ctx.font = "600 44px system-ui, -apple-system, sans-serif";
  wrapText(ctx, card.businessName.toUpperCase(), width / 2, 110, width - 160, 52);

  ctx.font = "700 76px system-ui, -apple-system, sans-serif";
  ctx.fillText(card.tableLabel.toUpperCase(), width / 2, 230, width - 120);

  const qrDrawSize = Math.min(qrCanvas.width, width - 220);
  const qrX = (width - qrDrawSize) / 2;
  const qrY = 300;
  ctx.drawImage(qrCanvas, qrX, qrY, qrDrawSize, qrDrawSize);

  ctx.font = "600 42px system-ui, -apple-system, sans-serif";
  ctx.fillText("SCAN TO ORDER", width / 2, qrY + qrDrawSize + 80, width - 120);
  ctx.font = "400 26px system-ui, -apple-system, sans-serif";
  ctx.fillStyle = "#555555";
  ctx.fillText(
    "Scan with your phone to view the menu and order",
    width / 2,
    qrY + qrDrawSize + 128,
    width - 160,
  );

  return { dataUrl: canvas.toDataURL("image/png"), width, height };
}

/** Minimal manual line-wrap for canvas text — canvas has no native wrapping. Only used for the business-name line, which is the one field with unbounded operator-entered length. */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
) {
  const words = text.split(" ");
  let line = "";
  let curY = y;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, curY);
      line = word;
      curY += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, curY);
}

export function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

const PAGE_WIDTH_MM = 210;
const PAGE_HEIGHT_MM = 297;
const COLS = 2;
const ROWS = 3;
const MARGIN_MM = 10;

/**
 * Each pack card draws its QR at roughly 45mm (~1.8in). 600px comfortably
 * clears 300dpi at that size (≈330dpi) without paying for the full
 * individual-card resolution (900px) six times per page — smaller native
 * resolution here, never a scaled-down large one (still "generate at an
 * appropriate native resolution", just sized to how it will actually
 * print in this specific layout).
 */
const PACK_QR_WIDTH = 600;

/**
 * "Download All QR Codes" (spec section 7): an A4, print-ready PDF, 6
 * self-identifying cards per page (business name + TABLE label + QR +
 * "Scan to order"), so a printed and cut-out card still identifies its
 * own table. `cards` is expected to already be the tenant-scoped,
 * active-only set from qr.ts's buildTableQrCards — this function performs
 * no further filtering, so it can never leak beyond whatever it's given.
 */
export async function buildQrPackPdf(cards: TableQrCard[]): Promise<jsPDF> {
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  const cellW = (PAGE_WIDTH_MM - MARGIN_MM * 2) / COLS;
  const cellH = (PAGE_HEIGHT_MM - MARGIN_MM * 2) / ROWS;
  const perPage = COLS * ROWS;

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const posInPage = i % perPage;
    if (i > 0 && posInPage === 0) doc.addPage();
    const col = posInPage % COLS;
    const row = Math.floor(posInPage / COLS);
    const cellX = MARGIN_MM + col * cellW;
    const cellY = MARGIN_MM + row * cellH;

    const qrCanvas = await renderQrOnly(card, PACK_QR_WIDTH);
    const qrDataUrl = qrCanvas.toDataURL("image/png");

    doc.setDrawColor(210);
    doc.rect(cellX + 3, cellY + 3, cellW - 6, cellH - 6);

    const centerX = cellX + cellW / 2;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text(card.businessName.toUpperCase(), centerX, cellY + 12, {
      align: "center",
      maxWidth: cellW - 12,
    });
    doc.setFontSize(14);
    doc.text(card.tableLabel.toUpperCase(), centerX, cellY + 20, { align: "center" });

    const qrDim = Math.min(cellW, cellH) * 0.52;
    const qrX = centerX - qrDim / 2;
    const qrY = cellY + 26;
    doc.addImage(qrDataUrl, "PNG", qrX, qrY, qrDim, qrDim, undefined, "MEDIUM");

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.text("SCAN TO ORDER", centerX, qrY + qrDim + 6, { align: "center" });
  }

  return doc;
}
