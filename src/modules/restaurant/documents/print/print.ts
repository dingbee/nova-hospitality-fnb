/**
 * Printing uses an off-screen iframe with the document's own stylesheet, so
 * the app chrome, navigation and dark theme never reach the paper.
 */
import { documentToHtml } from "../rendering/toHtml";
import type { RestaurantDocument } from "../core/types";

export function printDocument(doc: RestaurantDocument) {
  const html = documentToHtml(doc);
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(frame);
  const win = frame.contentWindow;
  if (!win) {
    frame.remove();
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  const run = () => {
    win.focus();
    win.print();
    setTimeout(() => frame.remove(), 1000);
  };
  if (win.document.readyState === "complete") setTimeout(run, 60);
  else win.addEventListener("load", () => setTimeout(run, 60));
}

/** "Save as PDF" is the browser print dialog — no second rendering engine. */
export const downloadDocumentPdf = printDocument;

export function downloadDocumentHtml(doc: RestaurantDocument) {
  const blob = new Blob([documentToHtml(doc)], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${doc.number ?? doc.type}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}