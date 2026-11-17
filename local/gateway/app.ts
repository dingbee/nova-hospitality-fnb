/**
 * NOVA Hospitality — local application UI serving (PRODUCTIZATION-4D).
 *
 * The appliance serves the SAME artefact the hosted runtime deploys: the
 * Nitro fetch-handler bundle (`dist/server/index.mjs`) plus its client assets
 * (`dist/client`). No second runtime, no forked application source — the
 * gateway simply hosts the handler in-process and answers static asset
 * requests directly.
 *
 *   Android/HTTPS -> gateway -> [ /auth /rest /nova /health ] -> APIs
 *                            -> [ everything else ]           -> this module
 *
 * Everything is same-origin, so the terminal never needs an Internet route.
 */
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";

export interface AppBundle {
  dir: string;
  clientDir: string;
  serverEntry: string;
}

export type AppStatus = "ok" | "down";

export interface AppState {
  status: AppStatus;
  detail: string;
}

// The appliance runs on Bun; the hosted typecheck does not ship Bun types.
declare const Bun: { file(path: string): Blob & { exists(): Promise<boolean> } };

const IMMUTABLE = /^\/assets\//;
const NEVER_CACHE = new Set(["/sw.js", "/site.webmanifest", "/nova-terminal.webmanifest"]);

export function resolveBundle(root: string, env: Record<string, string | undefined>): AppBundle {
  const dir = env["NOVA_APP_BUNDLE_DIR"] ?? join(root, "dist");
  return { dir, clientDir: join(dir, "client"), serverEntry: join(dir, "server", "index.mjs") };
}

/** Cheap structural validation — a missing or truncated bundle must not look healthy. */
export function inspectBundle(bundle: AppBundle): AppState {
  if (!existsSync(bundle.clientDir)) {
    return { status: "down", detail: "application bundle missing — reinstall the UI bundle" };
  }
  if (!existsSync(bundle.serverEntry)) {
    return { status: "down", detail: "application server bundle missing — reinstall the UI bundle" };
  }
  try {
    if (statSync(bundle.serverEntry).size < 1024) {
      return { status: "down", detail: "application bundle incomplete — reinstall the UI bundle" };
    }
  } catch {
    return { status: "down", detail: "application bundle unreadable — reinstall the UI bundle" };
  }
  return { status: "ok", detail: "application UI available" };
}

type FetchHandler = (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;

/**
 * The application host. Load failures are captured, never thrown: the gateway
 * keeps serving APIs and health reports the UI as down.
 */
export class LocalAppHost {
  private handler: FetchHandler | null = null;
  private loadError: string | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly bundle: AppBundle) {}

  state(): AppState {
    const structural = inspectBundle(this.bundle);
    if (structural.status === "down") return structural;
    if (this.loadError) return { status: "down", detail: "application UI failed to start" };
    return structural;
  }

  private async load(): Promise<void> {
    if (this.handler || this.loadError) return;
    this.loading ??= (async () => {
      try {
        const mod = (await import(this.bundle.serverEntry)) as {
          default?: { fetch?: FetchHandler };
        };
        const fetchFn = mod.default?.fetch;
        if (typeof fetchFn !== "function") throw new Error("bundle exposes no fetch handler");
        this.handler = fetchFn.bind(mod.default);
      } catch (error) {
        // Detail stays in the local log; callers get a neutral message.
        console.error("[app]", error instanceof Error ? error.message : String(error));
        this.loadError = "load-failed";
      }
    })();
    await this.loading;
    this.loading = null;
  }

  /** Static assets first (cheap, no JS execution), then server-rendered routes. */
  async serve(request: Request): Promise<Response> {
    const structural = inspectBundle(this.bundle);
    if (structural.status === "down") return unavailable(structural.detail);

    const path = decodeURIComponent(new URL(request.url).pathname);

    // A terminal that opens the appliance origin wants the OS, not the
    // public marketing site that shares this source tree.
    if (path === "/") {
      const entry = process.env["NOVA_APP_ENTRY"] ?? "/admin";
      return new Response(null, { status: 302, headers: { location: entry, "cache-control": "no-store" } });
    }
    const asset = await this.staticAsset(path);
    if (asset) return asset;

    await this.load();
    if (!this.handler) return unavailable("application UI is not available");

    try {
      return await this.handler(request, process.env, {
        waitUntil() {},
        passThroughOnException() {},
      });
    } catch (error) {
      console.error("[app]", error);
      return unavailable("application UI error");
    }
  }

  private async staticAsset(path: string): Promise<Response | null> {
    if (path === "/" || path.endsWith("/")) return null;
    // Contain the lookup inside the client directory — no traversal.
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
    if (safe.includes("..")) return null;
    let file = Bun.file(join(this.bundle.clientDir, safe));
    if (!(await file.exists())) {
      // The service worker and its workbox runtime are emitted beside the
      // client directory, not inside it — serve them from the bundle root so
      // the PWA can register at scope "/".
      if (!/^\/(sw\.js|workbox-[\w-]+\.js)$/.test(path)) return null;
      file = Bun.file(join(this.bundle.dir, safe));
      if (!(await file.exists())) return null;
    }

    const headers: Record<string, string> = {
      // Hashed asset URLs are immutable; control files must always revalidate
      // so a new appliance version can never be masked by a stale worker.
      "cache-control": IMMUTABLE.test(path)
        ? "public, max-age=31536000, immutable"
        : NEVER_CACHE.has(path)
          ? "no-cache, must-revalidate"
          : "public, max-age=3600",
    };
    if (path === "/sw.js") headers["service-worker-allowed"] = "/";
    return new Response(file, { headers });
  }
}

function unavailable(detail: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>NOVA Hospitality</title>` +
      `<body style="font-family:system-ui;padding:2rem"><h1>Application unavailable</h1>` +
      `<p>${escapeHtml(detail)}</p><p>Contact your system administrator.</p></body>`,
    { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}
