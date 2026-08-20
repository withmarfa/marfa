/**
 * Post-build boot smoke for the real server entrypoint against a real
 * Postgres.
 *
 * Exists because boot-time failures live in the composition, not the
 * units: the scheduled-job specs, event replication, the consent-lock
 * backend, and the local integrations substrate are each tested in
 * isolation, and the first deployment to run the real spec list against
 * a real pg-boss still crash-looped — a queue-config assert rejected a
 * value every unit test's short intervals stayed under. Nothing short of
 * booting `dist/index.js` exercises what boot actually runs.
 *
 * The shape mirrors the deploy: migrate first (`dist/migrate.js` — the
 * server never migrates on boot), then boot the same build once per
 * process role. Each boot must reach a 200 from `/health`, log the
 * role's scheduled-jobs line (registered for `both` and `worker`,
 * deferred for `web` — the line that pins the role gating in the real
 * binary), and exit 0 on SIGTERM so the graceful-shutdown path is
 * smoked too.
 *
 * Runs under `scripts/with-temp-pg.sh`, which provides DATABASE_URL
 * against a throwaway postgres:17 and owns the container's lifecycle;
 * this script owns every child process it spawns, on every exit path.
 * NODE_ENV=production so the boot takes the deployment's own guard
 * paths; the SMTP transport constructs without connecting, so a
 * placeholder host satisfies the hosted email guard with no network.
 *
 * Wired into `pnpm test:full` after `test:pg` and into the `ci-pg` job,
 * the same placement `smoke:worker-entry` has on the SQLite side.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, "..");
const SERVER_ENTRY = resolve(SERVER_ROOT, "dist/index.js");
const MIGRATE_ENTRY = resolve(SERVER_ROOT, "dist/migrate.js");

const ROLES = ["both", "web", "worker"] as const;
const READY_BUDGET_MS = 90_000;
const SHUTDOWN_BUDGET_MS = 20_000;

/** The log line that proves the role gating held in the real binary. */
const ROLE_MARKER: Record<(typeof ROLES)[number], string> = {
  both: "Scheduled jobs running on pg-boss",
  worker: "Scheduled jobs running on pg-boss",
  web: "Scheduled jobs deferred to the worker role",
};

const blobDir = mkdtempSync(join(tmpdir(), "smoke-boot-"));
let liveChild: ChildProcess | null = null;

function cleanup(): void {
  if (liveChild?.exitCode === null) {
    liveChild.kill("SIGKILL");
  }
  rmSync(blobDir, { recursive: true, force: true });
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

function fail(msg: string, output?: string): never {
  console.error(`[smoke-boot] FAIL: ${msg}`);
  if (output) {
    console.error("[smoke-boot] last output:");
    console.error(
      output
        .split("\n")
        .slice(-40)
        .map((l) => `  ${l}`)
        .join("\n"),
    );
  }
  process.exit(1);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function childEnv(role: (typeof ROLES)[number]): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "production",
    DB_DIALECT: "pg",
    MARFA_PROCESS_ROLE: role,
    AUTH_MODE: "hosted",
    // The SMTP transport constructs without connecting, so a placeholder
    // host passes the hosted email guard with no network traffic.
    MARFA_EMAIL_BACKEND: "smtp",
    MARFA_SMTP_HOST: "smoke.invalid",
    API_KEY_SALT: "smoke-boot-salt-0123456789abcdef0123456789abcdef",
    MARFA_AUTH_SECRET: "smoke-boot-secret-0123456789abcdef0123456789abcdef",
    BLOB_BACKEND: "filesystem",
    BLOB_PATH: join(blobDir, role),
    // Ephemeral port; the listen log line reports the one the OS picked.
    PORT: "0",
  };
}

async function runMigrations(): Promise<void> {
  console.log("[smoke-boot] applying migrations (dist/migrate.js)...");
  const code = await new Promise<number>((resolveExit) => {
    const child = spawn("node", [MIGRATE_ENTRY], {
      env: { ...process.env, DB_DIALECT: "pg" },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("exit", (c) => {
      resolveExit(c ?? 1);
    });
  });
  if (code !== 0) fail(`migrate exited ${String(code)}`);
}

async function bootRole(role: (typeof ROLES)[number]): Promise<void> {
  console.log(`[smoke-boot] booting role=${role}...`);
  let output = "";
  const child = spawn("node", [SERVER_ENTRY], {
    env: childEnv(role),
    stdio: ["ignore", "pipe", "pipe"],
  });
  liveChild = child;
  const capture = (chunk: Buffer): void => {
    output += chunk.toString();
    if (output.length > 200_000) output = output.slice(-100_000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const exited = new Promise<number>((resolveExit) => {
    child.on("exit", (c) => {
      resolveExit(c ?? 1);
    });
  });

  // The listen line carries the OS-assigned port.
  const deadline = Date.now() + READY_BUDGET_MS;
  let port: number | null = null;
  while (port === null && Date.now() < deadline) {
    if (child.exitCode !== null) {
      fail(`role=${role} exited ${String(child.exitCode)} during boot`, output);
    }
    const match = /listening on port (\d+)/.exec(output);
    if (match) port = Number(match[1]);
    else await sleep(250);
  }
  if (port === null) {
    fail(`role=${role} never logged its listen line`, output);
  }

  // Health must answer 200 — and for the worker role this is the same
  // endpoint the container image's HEALTHCHECK polls.
  let healthy = false;
  while (!healthy && Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) healthy = true;
      else await sleep(250);
    } catch {
      await sleep(250);
    }
  }
  if (!healthy) fail(`role=${role} /health never answered 200`, output);

  if (!output.includes(ROLE_MARKER[role])) {
    fail(
      `role=${role} health passed but the boot log lacks "${ROLE_MARKER[role]}"`,
      output,
    );
  }

  child.kill("SIGTERM");
  const code = await Promise.race([
    exited,
    sleep(SHUTDOWN_BUDGET_MS).then(() => -1),
  ]);
  if (code === -1) {
    child.kill("SIGKILL");
    fail(
      `role=${role} did not exit within ${String(SHUTDOWN_BUDGET_MS)}ms of SIGTERM`,
      output,
    );
  }
  if (code !== 0) {
    fail(
      `role=${role} exited ${String(code)} on SIGTERM (graceful path broken)`,
      output,
    );
  }
  liveChild = null;
  console.log(`[smoke-boot] role=${role} ok (port ${String(port)})`);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    fail("DATABASE_URL is required (run via scripts/with-temp-pg.sh)");
  }
  for (const artifact of [SERVER_ENTRY, MIGRATE_ENTRY]) {
    if (!existsSync(artifact)) {
      fail(`${artifact} missing — run pnpm build first`);
    }
  }
  await runMigrations();
  for (const role of ROLES) {
    await bootRole(role);
  }
  console.log("[smoke-boot] SMOKE PASSED");
}

void main().then(
  () => process.exit(0),
  (err: unknown) => {
    fail(err instanceof Error ? err.message : String(err));
  },
);
