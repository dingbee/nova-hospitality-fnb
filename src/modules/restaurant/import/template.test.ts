import { describe, it, expect } from "vitest";
import { LEXIBITE_TEMPLATE_SHEETS } from "./template";
import { CANONICAL_FIELDS, suggestFieldMapping, type ImportDomain } from "./domains";

describe("LexiBite template — canonical definition integrity", () => {
  for (const sheet of LEXIBITE_TEMPLATE_SHEETS) {
    it(`${sheet.name}: every field exists on its domain and every header resolves`, () => {
      const headers = sheet.columns.map((c) => c.header);
      for (const col of sheet.columns) {
        if (!col.field) continue;
        const domain = col.domain ?? sheet.domain;
        expect(domain, `${sheet.name}/${col.header} has no domain`).toBeTruthy();
        const fields = CANONICAL_FIELDS[domain!];
        const hit = fields.find((f) => f.field === col.field);
        expect(
          hit,
          `${sheet.name}/${col.header}: field "${col.field}" not found on domain "${domain}"`,
        ).toBeTruthy();
      }
      // Group headers by domain, resolve per-domain (mirrors how the
      // deterministic pipeline will actually read this sheet).
      const domains = new Set(sheet.columns.map((c) => c.domain ?? sheet.domain).filter(Boolean));
      for (const domain of domains) {
        const domainHeaders = sheet.columns
          .filter((c) => (c.domain ?? sheet.domain) === domain)
          .map((c) => c.header);
        const mapping = suggestFieldMapping(domainHeaders, domain as ImportDomain);
        for (const col of sheet.columns) {
          if (!col.field) continue;
          if ((col.domain ?? sheet.domain) !== domain) continue;
          const entry = mapping.find((m) => m.sourceColumn === col.header);
          expect(
            entry?.canonicalField,
            `${sheet.name}/${col.header} did not auto-resolve to "${col.field}" (got "${entry?.canonicalField}")`,
          ).toBe(col.field);
        }
      }
      // Example rows use exactly the sheet's own headers.
      for (const row of sheet.exampleRows) {
        expect(Object.keys(row).sort()).toEqual([...headers].sort());
      }
    });
  }
});
