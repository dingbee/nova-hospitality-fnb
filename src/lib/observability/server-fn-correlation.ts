/**
 * ME-16 remediation (ME16-02 / ME16-08) — request correlation for the
 * `createServerFn` operational layer.
 *
 * The external `/api/v1/*` pipeline already generates a request ID, logs it
 * server-side on failure, and returns it to the caller
 * (`src/modules/api-platform/router.server.ts`). The `createServerFn` layer
 * — the actual Table→Order→Production→...→Closed operational surface — had
 * no equivalent. Rather than touching each of the ~150 server functions
 * individually, this is registered ONCE as a global `functionMiddleware` in
 * `src/start.ts`, so the framework applies it to every server function call
 * automatically (confirmed via `@tanstack/react-start`'s own
 * `createStart({ functionMiddleware: [...] })` contract).
 *
 * On any thrown error it is logged in full (requestId, which function, at
 * what time) server-side only, then the SAME error is re-thrown unchanged
 * — this only adds correlation and logging, it does not change what any
 * existing caller sees or how it behaves (no weakening of existing error
 * handling, no new error envelope).
 */
import { randomUUID } from "node:crypto";
import { createMiddleware } from "@tanstack/react-start";
import { logServerFailure } from "./log.server";

export const withRequestCorrelation = createMiddleware({ type: "function" }).server(
  async ({ next, serverFnMeta }) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    try {
      return await next({ context: { requestId } });
    } catch (error) {
      logServerFailure(
        "server-fn",
        requestId,
        {
          fn: serverFnMeta?.name ?? null,
          file: serverFnMeta?.filename ?? null,
          durationMs: Date.now() - startedAt,
        },
        error,
      );
      // Attach non-destructively so a caller that wants to surface a
      // reference to the user can (see src/lib/errors/present-error.ts);
      // the error's own message/type/identity is left exactly as thrown.
      if (error instanceof Error && !("requestId" in error)) {
        Object.defineProperty(error, "requestId", { value: requestId, enumerable: false });
      }
      throw error;
    }
  },
);
