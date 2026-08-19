/**
 * NOVA Hospitality F&B — database type contract.
 *
 * The standalone product owns its own schema (standalone/db/migrations). This
 * file is intentionally permissive: no table shape from any other product is
 * carried over. Regenerate strict types from THIS database when a typed
 * client is wanted.
 */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Database = {
  public: {
    Tables: Record<string, { Row: Record<string, any>; Insert: Record<string, any>; Update: Record<string, any>; Relationships: [] }>;
    Views: Record<string, { Row: Record<string, any>; Relationships: [] }>;
    Functions: Record<string, { Args: Record<string, any>; Returns: any }>;
    Enums: Record<string, string>;
    CompositeTypes: Record<string, Record<string, any>>;
  };
};
/* eslint-enable @typescript-eslint/no-explicit-any */
