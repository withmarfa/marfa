import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("No probe port");
  await new Promise<void>((resolve) =>
    probe.close(() => {
      resolve();
    }),
  );
  return address.port;
}

it("starts the production bundle and serves health, instance and OpenAPI", async () => {
  // Keep resolution under the package's node_modules, with no shared dist output.
  const scratch = join(SERVER_ROOT, "_tmp");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "production-bundle-"));
  const state = mkdtempSync(join(realpathSync("/tmp"), "marfa-bundle-"));
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<void> | undefined;
  try {
    await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { build } from "tsup";
         import { copyFileSync } from "node:fs";
         import { join } from "node:path";
         import config from "./tsup.config.ts";
         const outDir = process.env.MARFA_TEST_BUNDLE_DIR;
         await build({ ...config, outDir, onSuccess: async () => {
           copyFileSync("src/storage/sqlite/schema.sql", join(outDir, "schema.sql"));
         }});`,
      ],
      {
        cwd: SERVER_ROOT,
        env: { ...process.env, MARFA_TEST_BUNDLE_DIR: dir },
      },
    );
    const port = await freePort();
    const url = `http://127.0.0.1:${String(port)}`;
    child = spawn(
      process.execPath,
      ["--import", join(dir, "instrumentation.js"), join(dir, "index.js")],
      {
        cwd: SERVER_ROOT,
        env: {
          ...process.env,
          NODE_ENV: "production",
          PORT: String(port),
          SQLITE_PATH: join(state, "marfa.db"),
          BLOB_PATH: join(state, "blobs"),
          MARFA_CONTROL_SOCKET: join(state, "control", "marfa.sock"),
          MARFA_CONTROL_ONLY: "false",
          MARFA_AUTH_BASE_URL: url,
          MARFA_AUTH_SECRET: randomBytes(32).toString("hex"),
          API_KEY_SALT: randomBytes(32).toString("hex"),
          RATE_LIMIT_ENABLED: "false",
          MARFA_ENRICHMENT_ENABLED: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout
      ?.setEncoding("utf8")
      .on("data", (data: string) => (output += data));
    child.stderr
      ?.setEncoding("utf8")
      .on("data", (data: string) => (output += data));
    closed = new Promise((resolve) =>
      child!.once("close", () => {
        resolve();
      }),
    );
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) {
        await closed;
        throw new Error(`Bundle exited before health:\n${output}`);
      }
      if (Date.now() > deadline)
        throw new Error(`Bundle did not start:\n${output}`);
      try {
        if ((await fetch(`${url}/health`)).status === 200) break;
      } catch {
        // The child has not started listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const root = await fetch(`${url}/`);
    expect(root.status).toBe(200);
    expect(await root.json()).toMatchObject({ name: "Marfa" });
    const response = await fetch(`${url}/openapi.json`);
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      paths: Record<
        string,
        Record<
          string,
          {
            operationId: string;
            responses?: Record<
              string,
              { content?: Record<string, { schema?: unknown }> }
            >;
          }
        >
      >;
      components: { schemas: Record<string, unknown> };
    };
    expect(document.paths["/"]?.get?.operationId).toBe("getInstance");
    expect(document.paths["/events"]?.get?.operationId).toBe("streamEvents");
    expect(document.paths["/auth/oauth2/register"]?.post?.operationId).toBe(
      "registerOAuthClient",
    );
    expect(document.components.schemas.UnauthorizedRefusal).toBeDefined();
    expect(
      document.paths["/items"]?.get?.responses?.["401"]?.content?.[
        "application/json"
      ]?.schema,
    ).toEqual({
      $ref: "#/components/schemas/UnauthorizedRefusal",
    });
    expect(document.components.schemas.UnauthorizedRefusal).toMatchObject({
      properties: {
        error: { properties: { code: { enum: ["unauthorized"] } } },
      },
    });
    const refused = await fetch(`${url}/items`);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
  } finally {
    if (child && closed) {
      child.kill("SIGKILL");
      await closed;
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
}, 60_000);
