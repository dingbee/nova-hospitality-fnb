/**
 * On-screen preview of a document. It reuses the exact print stylesheet so
 * what the user sees is what comes out of the printer.
 */
import { useMemo } from "react";
import { documentToHtml } from "./toHtml";
import type { RestaurantDocument } from "../core/types";

export function DocumentView({ doc }: { doc: RestaurantDocument }) {
  const html = useMemo(() => documentToHtml(doc), [doc]);
  return (
    <iframe
      title={doc.number ?? doc.title}
      srcDoc={html}
      className="h-[70vh] w-full rounded-lg border bg-white"
    />
  );
}