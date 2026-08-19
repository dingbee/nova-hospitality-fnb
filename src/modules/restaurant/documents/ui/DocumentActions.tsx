/* eslint-disable @typescript-eslint/no-explicit-any -- server function payloads are untyped at this boundary. */
/**
 * The single action group every document surface uses. Because it is shared,
 * a purchase order printed from the Document Centre and one printed from the
 * purchasing screen are byte-identical, and both are audited the same way.
 */
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Download, FileJson, FileSpreadsheet, Printer } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { documentToWorkbook } from "../exports/fromDocument";
import { downloadWorkbook } from "../exports/download";
import { printDocument } from "../print/print";
import { recordRestaurantDocumentEventFn, renderRestaurantDocumentFn } from "../documents.functions";
import type { DocumentTypeId } from "../core/registry";
import type { RestaurantDocument } from "../core/types";

interface Props {
  tenantId: string;
  type: DocumentTypeId;
  recordId: string;
  documentNumber?: string | null;
  /** Already-rendered document; when omitted it is fetched on demand. */
  doc?: RestaurantDocument | null;
  size?: "sm" | "default";
}

export function DocumentActions({ tenantId, type, recordId, documentNumber, doc, size = "sm" }: Props) {
  const render = useServerFn(renderRestaurantDocumentFn);
  const audit = useServerFn(recordRestaurantDocumentEventFn);
  const [busy, setBusy] = useState<string | null>(null);

  async function withDoc(action: string, format: string, run: (d: RestaurantDocument) => Promise<void> | void) {
    setBusy(action);
    try {
      const resolved = doc ?? ((await render({ data: { tenantId, type, recordId } })) as any as RestaurantDocument);
      await run(resolved);
      await audit({
        data: {
          tenantId,
          type,
          documentId: recordId,
          documentNumber: documentNumber ?? resolved.number ?? undefined,
          action: action as any,
          format: format as any,
          metadata: {},
        },
      }).catch(() => undefined);
    } catch (e: any) {
      toast.error(e?.message ?? "The document could not be produced.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button size={size} variant="outline" disabled={busy !== null} onClick={() => withDoc("printed", "print", printDocument)}>
        <Printer className="mr-1 size-4" /> Print
      </Button>
      <Button size={size} variant="outline" disabled={busy !== null} onClick={() => withDoc("downloaded", "pdf", printDocument)}>
        <Download className="mr-1 size-4" /> PDF
      </Button>
      <Button
        size={size}
        variant="outline"
        disabled={busy !== null}
        onClick={() => withDoc("exported", "xlsx", (d) => downloadWorkbook(documentToWorkbook(d), "xlsx"))}
      >
        <FileSpreadsheet className="mr-1 size-4" /> Excel
      </Button>
      <Button
        size={size}
        variant="outline"
        disabled={busy !== null}
        onClick={() => withDoc("exported", "csv", (d) => downloadWorkbook(documentToWorkbook(d), "csv"))}
      >
        <Download className="mr-1 size-4" /> CSV
      </Button>
      <Button
        size={size}
        variant="ghost"
        disabled={busy !== null}
        onClick={() => withDoc("exported", "json", (d) => downloadWorkbook(documentToWorkbook(d), "json"))}
      >
        <FileJson className="mr-1 size-4" /> JSON
      </Button>
    </div>
  );
}