import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Standalone packages carry exactly one environment file: standalone/.env.
// Installer/runtime scripts must inherit it instead of falling back to the
// legacy host-appliance defaults (5432 / nova_local).
function loadEnv(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "nova-env-"));
  mkdirSync(join(root, "local", "scripts"), { recursive: true });
  copyFileSync("local/scripts/lib.sh", join(root, "local", "scripts", "lib.sh"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  const out = execFileSync(
    "bash",
    [
      "-c",
      `source "${root}/local/scripts/lib.sh"; nova_load_env; ` +
        `printf '%s|%s|%s|%s\\n' "$PGPORT" "$PGDATABASE" "$NOVA_POSTGREST_PORT" "$NOVA_ENV_FILE"`,
    ],
    { encoding: "utf8", env: { ...process.env, NOVA_ENV_FILE: undefined } as NodeJS.ProcessEnv },
  ).trim();
  const [port, database, postgrestPort, envFile] = out.split("|");
  return { port, database, postgrestPort, envFile, root };
}

const STANDALONE_ENV = [
  "NOVA_DB_HOST=127.0.0.1",
  "NOVA_DB_PORT=55432",
  "NOVA_DB_NAME=nova_fnb",
  "NOVA_DB_SUPERUSER=nova_superuser",
  "NOVA_DB_AUTHENTICATOR=nova_authenticator",
  "NOVA_POSTGREST_PORT=53000",
  "",
].join("\n");

describe("standalone environment wiring", () => {
  it("repair/install scripts read standalone/.env, not the legacy defaults", () => {
    const env = loadEnv({ "standalone/.env": STANDALONE_ENV });
    expect(env.port).toBe("55432");
    expect(env.database).toBe("nova_fnb");
    expect(env.postgrestPort).toBe("53000");
    expect(env.envFile).toBe(join(env.root, "standalone/.env"));
    expect(env.port).not.toBe("5432");
    expect(env.database).not.toBe("nova_local");
  });

  it("standalone/.env wins over a stray local/.env", () => {
    const env = loadEnv({
      "standalone/.env": STANDALONE_ENV,
      "local/.env": "NOVA_DB_PORT=5432\nNOVA_DB_NAME=nova_local\n",
    });
    expect(env.port).toBe("55432");
    expect(env.database).toBe("nova_fnb");
  });

  it("keeps host-appliance mode working when there is no standalone/.env", () => {
    const env = loadEnv({ "local/.env": "NOVA_DB_PORT=5432\nNOVA_DB_NAME=nova_local\n" });
    expect(env.port).toBe("5432");
    expect(env.database).toBe("nova_local");
    expect(env.envFile).toBe(join(env.root, "local/.env"));
  });
});

// --- PRODUCTIZATION-4G: appliance bundle packaging ---------------------------
describe("appliance bundle packaging (package-bundle.sh)", () => {
  const script = `${process.cwd()}/local/scripts/package-bundle.sh`;
  const run = (root: string) => spawnSync("bash", [script, root], { encoding: "utf8" });

  const makeRoot = (name: string) => {
    const root = `/tmp/nova-pkg-${name}-${Date.now()}`;
    rmSync(root, { recursive: true, force: true });
    return root;
  };

  it("packages .output/public + .output/server into dist/client + dist/server", () => {
    const root = makeRoot("public");
    mkdirSync(`${root}/.output/public/assets`, { recursive: true });
    mkdirSync(`${root}/.output/server/chunks`, { recursive: true });
    writeFileSync(`${root}/.output/public/index.html`, "<html></html>");
    writeFileSync(`${root}/.output/public/assets/app.js`, "app");
    writeFileSync(`${root}/.output/server/index.mjs`, "export default {}");
    writeFileSync(`${root}/.output/server/chunks/a.mjs`, "chunk");
    writeFileSync(`${root}/.output/server/.env`, "SECRET=1");
    mkdirSync(`${root}/dist`, { recursive: true });
    writeFileSync(`${root}/dist/sw.js`, "// pwa");

    const res = run(root);
    expect(res.status).toBe(0);
    expect(existsSync(`${root}/dist/client/index.html`)).toBe(true);
    expect(existsSync(`${root}/dist/client/assets/app.js`)).toBe(true);
    expect(existsSync(`${root}/dist/server/index.mjs`)).toBe(true);
    expect(existsSync(`${root}/dist/server/chunks/a.mjs`)).toBe(true);
    // secrets stripped, PWA artefacts preserved
    expect(existsSync(`${root}/dist/server/.env`)).toBe(false);
    expect(existsSync(`${root}/dist/sw.js`)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("supports the newer .output/client layout", () => {
    const root = makeRoot("client");
    mkdirSync(`${root}/.output/client`, { recursive: true });
    mkdirSync(`${root}/.output/server`, { recursive: true });
    writeFileSync(`${root}/.output/client/index.html`, "<html></html>");
    writeFileSync(`${root}/.output/server/index.mjs`, "export default {}");
    expect(run(root).status).toBe(0);
    expect(existsSync(`${root}/dist/client/index.html`)).toBe(true);
    expect(existsSync(`${root}/dist/server/index.mjs`)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("is idempotent when the build already emitted the appliance layout", () => {
    const root = makeRoot("dist");
    mkdirSync(`${root}/dist/client`, { recursive: true });
    mkdirSync(`${root}/dist/server`, { recursive: true });
    writeFileSync(`${root}/dist/client/index.html`, "<html></html>");
    writeFileSync(`${root}/dist/server/index.mjs`, "export default {}");
    expect(run(root).status).toBe(0);
    expect(existsSync(`${root}/dist/client/index.html`)).toBe(true);
    expect(existsSync(`${root}/dist/server/index.mjs`)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("fails loudly instead of writing a partial bundle", () => {
    const root = makeRoot("empty");
    mkdirSync(`${root}/dist`, { recursive: true });
    const res = run(root);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/expected Nitro output was not found/);
    expect(existsSync(`${root}/dist/client`)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
