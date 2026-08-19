/**
 * Document-specific HTML. This is deliberately NOT the application UI: print
 * output is its own A4 layout with its own stylesheet, so what leaves the
 * printer looks like a business document rather than a screenshot of an admin
 * screen (§24).
 */
import { displayValue } from "../core/format";
import type { DocumentTable, RestaurantDocument } from "../core/types";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tableHtml(table: DocumentTable, currency: string | null): string {
  const head = table.columns
    .map((c) => `<th class="${c.align === "right" ? "r" : ""}">${esc(c.label)}</th>`)
    .join("");
  const body = table.rows
    .map((row) => {
      const depth = table.depthKey ? Number(row[table.depthKey] ?? 0) : 0;
      const cells = table.columns
        .map((c, idx) => {
          const align = c.align === "right" || c.format === "money" || c.format === "number" ? "r" : "";
          const indent = idx === 0 && depth > 0 ? `padding-left:${8 + depth * 14}px` : "";
          return `<td class="${align}" style="${indent}">${esc(
            displayValue(row[c.key] ?? null, c.format ?? "text", c.currency ?? currency),
          )}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  const totals = table.totalsRow
    ? `<tr class="total">${table.columns
        .map(
          (c) =>
            `<td class="${c.align === "right" || c.format === "money" ? "r" : ""}">${esc(
              table.totalsRow![c.key] == null
                ? ""
                : displayValue(table.totalsRow![c.key], c.format ?? "text", c.currency ?? currency),
            )}</td>`,
        )
        .join("")}</tr>`
    : "";
  return `
  <section class="block">
    ${table.title ? `<h2>${esc(table.title)}</h2>` : ""}
    <table><thead><tr>${head}</tr></thead><tbody>${body}${totals}</tbody></table>
    ${table.note ? `<p class="note">${esc(table.note)}</p>` : ""}
  </section>`;
}

export const DOCUMENT_PRINT_CSS = `
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; color:#111; font-size: 11px; margin:0; }
  .doc { max-width: 190mm; margin: 0 auto; padding: 8px; }
  header.doc-head { display:flex; justify-content:space-between; gap:24px; border-bottom:2px solid #111; padding-bottom:10px; }
  header.doc-head h1 { font-size:18px; margin:0 0 4px; letter-spacing:.04em; text-transform:uppercase; }
  .muted { color:#555; }
  .cols { display:flex; gap:24px; margin-top:14px; }
  .cols > div { flex:1; }
  .kv { display:flex; justify-content:space-between; gap:12px; padding:2px 0; border-bottom:1px dotted #ddd; }
  .kv .k { color:#555; }
  .kv.em .v { font-weight:700; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; margin:16px 0 6px; }
  table { width:100%; border-collapse:collapse; }
  th, td { border-bottom:1px solid #e2e2e2; padding:5px 6px; text-align:left; vertical-align:top; }
  th { background:#f4f4f4; font-size:10px; text-transform:uppercase; letter-spacing:.06em; }
  td.r, th.r { text-align:right; }
  tr.total td { font-weight:700; border-top:2px solid #111; background:#fafafa; }
  .totals { margin-top:14px; margin-left:auto; width:60mm; }
  .totals .kv.grand { border-top:2px solid #111; font-weight:700; font-size:13px; }
  .sign { display:flex; gap:24px; margin-top:28px; }
  .sign div { flex:1; border-top:1px solid #999; padding-top:6px; color:#555; }
  footer.doc-foot { margin-top:20px; padding-top:8px; border-top:1px solid #ddd; color:#666; font-size:9px; }
  .note { color:#666; font-size:10px; margin-top:4px; }
  .chip { display:inline-block; border:1px solid #111; border-radius:3px; padding:1px 6px; font-size:10px; text-transform:uppercase; letter-spacing:.08em; }
  .block { break-inside: avoid; }
  .receipt .doc { max-width:72mm; }
`;

export function documentToHtml(doc: RestaurantDocument): string {
  const fields = (list: { label: string; value: unknown; emphasis?: boolean }[]) =>
    list
      .map(
        (f) =>
          `<div class="kv ${f.emphasis ? "em" : ""}"><span class="k">${esc(f.label)}</span><span class="v">${esc(
            f.value ?? "—",
          )}</span></div>`,
      )
      .join("");

  const totals = doc.totals
    .map(
      (t) =>
        `<div class="kv ${t.emphasis ? "grand" : ""}"><span class="k">${esc(t.label)}</span><span class="v">${
          t.unavailable ? "Not available" : esc(displayValue(t.value, "money", t.currency ?? doc.currency))
        }</span></div>`,
    )
    .join("");

  const trace = doc.traceability.length
    ? `<section class="block"><h2>Traceability</h2>${fields(
        doc.traceability.map((t) => ({
          label: t.label,
          value: t.recordNumber ?? t.recordId ?? "—",
        })),
      )}</section>`
    : "";

  const audit = doc.audit.length
    ? `<section class="block"><h2>Audit trail</h2>${fields(
        doc.audit.map((a) => ({
          label: `${a.action}${a.format ? ` (${a.format})` : ""}`,
          value: `${a.at}${a.actorName ? ` — ${a.actorName}` : ""}`,
        })),
      )}</section>`
    : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<title>${esc(doc.number ?? doc.title)}</title>
<style>${DOCUMENT_PRINT_CSS}</style></head>
<body class="${doc.type === "customer_receipt" ? "receipt" : ""}">
<div class="doc">
  <header class="doc-head">
    <div>
      <h1>${esc(doc.title)}</h1>
      <div class="muted">${esc(doc.header.business)}</div>
      ${doc.header.property ? `<div class="muted">${esc(doc.header.property)}</div>` : ""}
      ${doc.header.outlet ? `<div class="muted">${esc(doc.header.outlet)}</div>` : ""}
      ${doc.header.address ? `<div class="muted">${esc(doc.header.address)}</div>` : ""}
      ${doc.header.contact ? `<div class="muted">${esc(doc.header.contact)}</div>` : ""}
    </div>
    <div style="text-align:right">
      <div style="font-size:15px;font-weight:700">${esc(doc.number ?? "—")}</div>
      ${doc.status ? `<div class="chip">${esc(doc.status)}</div>` : ""}
      ${doc.issuedAt ? `<div class="muted">Issued ${esc(doc.issuedAt)}</div>` : ""}
      ${doc.currency ? `<div class="muted">Currency ${esc(doc.currency)}</div>` : ""}
    </div>
  </header>

  <div class="cols">
    <div>${doc.parties.length ? `<h2>Counterparty</h2>${fields(doc.parties)}` : ""}</div>
    <div>${doc.meta.length ? `<h2>Details</h2>${fields(doc.meta)}` : ""}</div>
  </div>

  ${doc.tables.map((t) => tableHtml(t, doc.currency)).join("")}

  ${totals ? `<div class="totals">${totals}</div>` : ""}

  ${doc.notes ? `<section class="block"><h2>Notes</h2><p>${esc(doc.notes)}</p></section>` : ""}

  ${trace}
  ${audit}

  ${
    doc.signatures.length
      ? `<div class="sign">${doc.signatures.map((s) => `<div>${esc(s)}</div>`).join("")}</div>`
      : ""
  }

  <footer class="doc-foot">
    Generated ${esc(doc.generatedAt)} · ${
      doc.snapshot
        ? "Reproduced from the stored snapshot taken at issuance — later price, tax or naming changes do not alter it."
        : "Rendered from current operational data."
    }${doc.snapshotNote ? ` ${esc(doc.snapshotNote)}` : ""}
  </footer>
</div>
</body></html>`;
}