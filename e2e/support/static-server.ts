/**
 * Minimal static file server for the P10 real-browser harness — serves the
 * esbuild-built bundle to Playwright. No new HTTP-server dependency: this
 * repo already avoids adding a package where a few lines over Node's own
 * `node:http` solve the requirement (see db.ts's equivalent rationale for
 * not adding idb/Dexie).
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "..", ".generated");
const port = Number(process.env.HARNESS_PORT ?? 4310);

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
};

createServer(async (req, res) => {
  const path = req.url === "/" ? "/harness.html" : (req.url ?? "/harness.html");
  const filePath = join(root, path);
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    await stat(filePath);
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(port, () => {
  console.log(`P10 harness static server listening on :${port}`);
});
