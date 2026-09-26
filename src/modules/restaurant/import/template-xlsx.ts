/**
 * LexiBite Import Template — workbook generator.
 *
 * The downloadable workbook is intentionally shaped like the customer-facing
 * LexiBite template: START HERE guidance, worked examples at the top of each
 * operational sheet, a large clean entry area, filters, and stable column
 * widths. The import definition remains canonical in template.ts.
 *
 * SheetJS CE does not serialize native cell styling/data validation/freeze
 * panes. We therefore implement the supported workbook structure here and
 * keep validation guidance in header comments. The import semantics do not
 * depend on presentation metadata.
 */
import * as XLSX from "xlsx";
import {
  LEXIBITE_START_HERE,
  LEXIBITE_TEMPLATE_FILENAME,
  LEXIBITE_TEMPLATE_MARKER,
  LEXIBITE_TEMPLATE_SHEETS,
  LEXIBITE_TEMPLATE_VERSION,
  LEXIBITE_UNIT_GUIDE,
  type TemplateSheetDef,
} from "./template";

const META_SHEET_NAME = "_lexibite_meta";
const TEMPLATE_ENTRY_ROWS = 1000;

function columnWidth(header: string, values: readonly string[]): number {
  const longest = values.reduce((max, v) => Math.max(max, v.length), 0);
  return Math.min(40, Math.max(10, header.length + 2, longest + 2));
}

function buildStartHereSheet(): XLSX.WorkSheet {
  // Match the customer-facing template layout rather than the older compact
  // generated workbook. Column B carries the long guidance text.
  const rows: string[][] = [
    ["LEXIBITE  |  OFFICIAL IMPORT TEMPLATE v1.0"],
    [],
    ["Template marker", LEXIBITE_TEMPLATE_MARKER],
    ["Template version", LEXIBITE_TEMPLATE_VERSION],
    ["Purpose", "Official LexiBite Restaurant & Bar OS master-data import workbook for Import Studio."],
    [
      "Before upload",
      "DELETE ALL WORKED EXAMPLE ROWS (the shaded rows) and replace them with your own data.",
    ],
    ["Required sheets", "INVENTORY and MENU ITEMS."],
    [
      "Optional sheets",
      "All other operational sheets. Leave them with only the header row if you do not use them.",
    ],
    ["Stable codes", "Use short, unique, stable codes. Cross-sheet references must match exactly."],
    ["Numbers", "Enter quantities/prices as numbers. Do not add currency symbols to numeric cells."],
    ["Units", "Use only the LexiBite unit codes listed below: KG, G, L, ML, PC, BTL, CTN."],
    ["Pack Size", "For an item bought and stocked in the same unit, use 1. Do not leave a deliberate zero."],
    [
      "Bottle contents",
      "For a 750ml bottle: Stock Unit = BTL, Purchase Unit = CTN, Pack Size = 12, Content per Stock Unit = 750, Content Unit = ML.",
    ],
    [
      "Content pair",
      "Content per Stock Unit and Content Unit must either both be supplied or both be blank.",
    ],
    [
      "Relationships",
      "MENU ITEMS Item Code is referenced by VARIANTS, ITEM MODIFIERS and RECIPES. Inventory SKU is referenced by RECIPES and SUPPLIER PRODUCTS.",
    ],
    ["Stations", "Do not create a separate station sheet. MENU ITEMS → Station is the canonical input."],
    ["Modifiers", "If Effect = Inventory, provide Inventory SKU, Quantity and Unit."],
    [
      "Upload",
      "Upload this workbook to LexiBite Import Studio, review staging/mapping, then commit only after all blocking errors are resolved.",
    ],
    [],
    ["LEXIBITE UNIT GUIDE  |  RESTAURANT & BAR OS"],
    ...LEXIBITE_UNIT_GUIDE.map((u) => [u.code, u.meaning]),
  ];

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [
    { wch: 28 },
    { wch: 88 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 },
  ];

  // Merge the title, guidance values and unit-guide heading exactly across
  // the presentation width used by the customer-facing template.
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 7 } },
    ...Array.from({ length: 16 }, (_, i) => ({
      s: { r: i + 2, c: 1 },
      e: { r: i + 2, c: 7 },
    })),
    { s: { r: 19, c: 0 }, e: { r: 19, c: 2 } },
  ];

  return ws;
}

function buildMetaSheet(): XLSX.WorkSheet {
  return XLSX.utils.aoa_to_sheet([
    [LEXIBITE_TEMPLATE_MARKER],
    [`Template Version: ${LEXIBITE_TEMPLATE_VERSION}`],
  ]);
}

function addComment(ws: XLSX.WorkSheet, cellRef: string, text: string): void {
  const cell = ws[cellRef];
  if (!cell) return;
  cell.c = cell.c ?? [];
  cell.c.push({ a: "LexiBite", t: text });
}

function buildOperationalSheet(sheet: TemplateSheetDef): XLSX.WorkSheet {
  const headers = sheet.columns.map((c) => c.header);

  // Row 1 = canonical headers. Worked examples immediately follow. The
  // remaining rows are deliberately materialised as an entry area so the
  // downloaded workbook opens as a real template, not a tiny example sheet.
  const aoa: string[][] = [headers];

  for (const row of sheet.exampleRows) {
    aoa.push(headers.map((h) => row[h] ?? ""));
  }

  const blankRows = Math.max(0, TEMPLATE_ENTRY_ROWS - sheet.exampleRows.length);
  for (let i = 0; i < blankRows; i += 1) {
    aoa.push(new Array(headers.length).fill(""));
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  ws["!cols"] = sheet.columns.map((c) => ({
    wch: columnWidth(
      c.header,
      sheet.exampleRows.map((r) => r[c.header] ?? ""),
    ),
  }));

  // Filter the complete template entry area, not just the example rows.
  ws["!autofilter"] = {
    ref: XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: TEMPLATE_ENTRY_ROWS, c: headers.length - 1 },
    }),
  };

  sheet.columns.forEach((col, i) => {
    const cellRef = XLSX.utils.encode_cell({ r: 0, c: i });
    const parts: string[] = [];
    if (col.required) parts.push("Required.");
    if (col.comment) parts.push(col.comment);
    if (col.choices && col.choices.length > 0) {
      parts.push(`Valid values: ${col.choices.join(", ")}.`);
    }
    if (parts.length > 0) addComment(ws, cellRef, parts.join(" "));
  });

  if (sheet.exampleRows.length > 0) {
    addComment(
      ws,
      XLSX.utils.encode_cell({ r: 1, c: 0 }),
      `Worked example row${sheet.exampleRows.length > 1 ? "s" : ""} — delete before entering your own data.`,
    );
  }

  return ws;
}

/** Builds the full LexiBite Import Template workbook from the canonical definition. */
export function buildLexibiteTemplateWorkbook(): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildStartHereSheet(), "START HERE");

  for (const sheet of LEXIBITE_TEMPLATE_SHEETS) {
    XLSX.utils.book_append_sheet(wb, buildOperationalSheet(sheet), sheet.name);
  }

  XLSX.utils.book_append_sheet(wb, buildMetaSheet(), META_SHEET_NAME);
  const metaIndex = wb.SheetNames.indexOf(META_SHEET_NAME);
  wb.Workbook = wb.Workbook ?? {};
  wb.Workbook.Sheets = wb.Workbook.Sheets ?? [];
  wb.Workbook.Sheets[metaIndex] = { Hidden: 1 };
  return wb;
}

function xmlEscape(value: unknown): string {
  return String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&apos;");
}
function colName(index: number): string {
  let n=index+1,s=""; while(n>0){const r=(n-1)%26;s=String.fromCharCode(65+r)+s;n=Math.floor((n-1)/26);} return s;
}
function cellValue(cell: XLSX.CellObject | undefined): string | number | null {
  if(!cell || cell.v===undefined || cell.v===null || cell.v==="") return null;
  return typeof cell.v==="number" ? cell.v : String(cell.v);
}
function styledCell(cell: XLSX.CellObject | undefined, ref: string, style: number): string {
  const value=cellValue(cell); if(value===null) return "";
  if(typeof value==="number") return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
}
function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="0"/><fonts count="4"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FF0F172A"/><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FF0F172A"/><sz val="16"/><name val="Aptos Display"/></font></fonts>
<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0F2620"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EFEA"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF7F8F5"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFCBD5E1"/></left><right style="thin"><color rgb="FFCBD5E1"/></right><top style="thin"><color rgb="FFCBD5E1"/></top><bottom style="thin"><color rgb="FFCBD5E1"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="2" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="4" borderId="0" applyFont="1" applyFill="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}
function styledSheetXml(ws: XLSX.WorkSheet, definition: TemplateSheetDef | undefined): string {
  const cols=definition?.columns.length ?? 3, maxRows=definition ? 1000 : 32;
  const widths=definition ? definition.columns.map(c=>columnWidth(c.header,definition.exampleRows.map(r=>r[c.header]??""))) : [46,30,40];
  let x=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${colName(cols-1)}${maxRows}"/><sheetViews><sheetView workbookViewId="0">`;
  if(definition)x+=`<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>`;
  x+="</sheetView></sheetViews><sheetFormatPr defaultRowHeight=\"18\"/><cols>";
  widths.forEach((w,i)=>{x+=`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`;});
  x+="</cols><sheetData>";
  const rows=definition ? Math.min(maxRows,definition.exampleRows.length+1) : 32;
  for(let r=0;r<rows;r++){let cells="";for(let c=0;c<cols;c++){const ref=`${colName(c)}${r+1}`;const style=definition?(r===0?1:(r<=definition.exampleRows.length?2:0)):(r===0?3:(r===19?4:0));cells+=styledCell(ws[ref],ref,style);}if(cells)x+=`<row r="${r+1}">${cells}</row>`;}
  x+="</sheetData>";
  if(definition){
    x+=`<autoFilter ref="A1:${colName(cols-1)}${maxRows}"/>`;
    const validations=definition.columns.map((c,i)=>({c,i})).filter(v=>v.c.choices?.length);
    if(validations.length){x+=`<dataValidations count="${validations.length}">`;for(const {c,i} of validations){const formula=`"${c.choices!.join(",")}"`,letter=colName(i);x+=`<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${letter}2:${letter}${maxRows}"><formula1>${xmlEscape(formula)}</formula1></dataValidation>`;}x+="</dataValidations>";}
  }
  const merges=ws["!merges"] as XLSX.Range[] | undefined;
  if(merges?.length){x+=`<mergeCells count="${merges.length}">`;for(const m of merges)x+=`<mergeCell ref="${XLSX.utils.encode_range(m)}"/>`;x+="</mergeCells>";}
  return x+"</worksheet>";
}
function crc32(bytes: Uint8Array): number {
  let crc=0xffffffff;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;
}
function u16(n:number):Uint8Array{return new Uint8Array([n&255,(n>>>8)&255]);}
function u32(n:number):Uint8Array{return new Uint8Array([n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255]);}
function joinBytes(parts:readonly Uint8Array[]):Uint8Array{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let o=0;for(const p of parts){out.set(p,o);o+=p.length;}return out;}
function zipStore(entries:readonly {name:string;data:string}[]):Uint8Array {
  const enc=new TextEncoder(),local:Uint8Array[]=[],central:Uint8Array[]=[];let offset=0;
  for(const e of entries){const name=enc.encode(e.name),data=enc.encode(e.data),crc=crc32(data);
    const h=joinBytes([u32(0x04034b50),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),name]);local.push(h,data);
    central.push(joinBytes([u32(0x02014b50),u16(20),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),name]));offset+=h.length+data.length;}
  const body=joinBytes(local),cd=joinBytes(central);return joinBytes([body,cd,u32(0x06054b50),u16(0),u16(0),u16(entries.length),u16(entries.length),u32(cd.length),u32(body.length),u16(0)]);
}
function styledWorkbookBytes(wb:XLSX.WorkBook):Uint8Array {
  const names=wb.SheetNames,entries:{name:string;data:string}[]=[];
  const workbook=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n,i)=>`<sheet name="${xmlEscape(n)}" sheetId="${i+1}" state="${n===META_SHEET_NAME?"hidden":"visible"}" r:id="rId${i+1}"/>`).join("")}</sheets></workbook>`;
  const rels=names.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join("");
  const workbookRels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}<Relationship Id="rId${names.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const overrides=`<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${names.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}`;
  entries.push({name:"[Content_Types].xml",data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`});
  entries.push({name:"_rels/.rels",data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`});
  entries.push({name:"xl/workbook.xml",data:workbook},{name:"xl/_rels/workbook.xml.rels",data:workbookRels},{name:"xl/styles.xml",data:stylesXml()});
  names.forEach((name,i)=>entries.push({name:`xl/worksheets/sheet${i+1}.xml`,data:styledSheetXml(wb.Sheets[name]!,LEXIBITE_TEMPLATE_SHEETS.find(s=>s.name===name))}));
  return zipStore(entries);
}
function bytesToBase64(bytes:Uint8Array):string{let binary="";for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+0x8000,bytes.length)));return btoa(binary);}

/** Base64-encoded feature-complete XLSX package. */
export function lexibiteTemplateBase64(): string {
  return bytesToBase64(styledWorkbookBytes(buildLexibiteTemplateWorkbook()));
}

/** Browser-only: builds the feature-complete workbook and triggers a download. */
export function downloadLexibiteTemplate(filename: string = LEXIBITE_TEMPLATE_FILENAME): void {
  const bytes=styledWorkbookBytes(buildLexibiteTemplateWorkbook());
  const blob=new Blob([bytes],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
  const url=URL.createObjectURL(blob);const anchor=document.createElement("a");
  anchor.href=url;anchor.download=filename;document.body.appendChild(anchor);anchor.click();anchor.remove();URL.revokeObjectURL(url);
}
