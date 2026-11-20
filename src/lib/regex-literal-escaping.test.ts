/**
 * Guard: a regex *literal* written as /^\\d{4}$/ matches a backslash followed
 * by "d", not a digit. That mistake (copied from string-escaped RegExp
 * sources) silently broke operational-expense dates, the owner POS PIN
 * validator and LB-02 Bearer-token parsing. This scans every source file's
 * actual regex-literal tokens (TypeScript scanner, so strings and comments are
 * ignored) and fails on a double-escaped character class.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { bootstrapOwnerPosPinSchema } from "@/modules/restaurant/sales/pos-session.contracts";

const ROOTS = ["src", "api"];
const DOUBLE_ESCAPED_CLASS = /\\\\[dDsSwWb]/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".gen.ts"))
      out.push(full);
  }
  return out;
}

function regexLiterals(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) found.push(node.getText(sf));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("regex literals are not double-escaped", () => {
  it("no source regex literal contains \\\\d, \\\\s, \\\\w (or their negations / \\\\b)", () => {
    const offenders: string[] = [];
    for (const root of ROOTS)
      for (const file of sourceFiles(root))
        for (const literal of regexLiterals(file))
          if (DOUBLE_ESCAPED_CLASS.test(literal))
            offenders.push(`${relative(process.cwd(), file)}: ${literal}`);
    expect(offenders).toEqual([]);
  });

  it("the guard itself detects the defect pattern", () => {
    expect(DOUBLE_ESCAPED_CLASS.test(String.raw`/^\\d{4}$/`)).toBe(true);
    expect(DOUBLE_ESCAPED_CLASS.test(String.raw`/^\d{4}$/`)).toBe(false);
  });
});

describe("owner POS PIN validation", () => {
  const base = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    propertyId: "22222222-2222-4222-8222-222222222222",
  };
  it("accepts 4–6 digit PINs", () => {
    for (const pin of ["1234", "12345", "123456"])
      expect(bootstrapOwnerPosPinSchema.safeParse({ ...base, pin }).success).toBe(true);
  });
  it("rejects non-digit, short, long and backslash-literal PINs", () => {
    for (const pin of ["123", "1234567", "12a4", String.raw`\dddd`])
      expect(bootstrapOwnerPosPinSchema.safeParse({ ...base, pin }).success).toBe(false);
  });
});
