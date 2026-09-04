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
 *
 * It also owns the one catalog claim nothing else can make: that the
 * manifests this build ships, rather than installs, reach the catalog on a
 * real boot. See FIRST_BOOT_REGISTERS.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { waitForHealth, attemptTimeoutMs } from "./wait-for-health.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, "..");
const SERVER_ENTRY = resolve(SERVER_ROOT, "dist/index.js");
const MIGRATE_ENTRY = resolve(SERVER_ROOT, "dist/migrate.js");

const ROLES = ["both", "web", "worker"] as const;
const READY_BUDGET_MS = 90_000;
const SHUTDOWN_BUDGET_MS = 20_000;

/**
 * Manifests the first boot must be seen registering.
 *
 * A client's manifest is not installed into the integrations root: it
 * ships with the build. So `marfa/sync@` appearing in the catalog
 * reconcile's registered list can only have come from the build, which is
 * the whole proposition, and boot is the only place it is provable. A unit
 * test can call the reconcile directly and stay green through a boot
 * rewired to build the catalog from discovery alone, which is the
 * regression that matters and the one that reports nothing: the reconcile
 * logs what it did, the server starts, and the catalog is short an entry
 * nobody looks for until an install fails weeks later.
 *
 * First role only. The reconcile registers an absent (name, version) pair
 * and leaves an existing row exactly as it is, so the second and third
 * roles boot against a catalog the first already filled and register
 * nothing. The database is a throwaway per run, so the first role always
 * has the work to do.
 */
const FIRST_BOOT_REGISTERS = ["marfa/sync@"];

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
// Each of these calls `process.exit`, which is what runs the `exit`
// handler above — node's own default action for these signals terminates
// without running it, so the spawned server and its blob directory would
// survive. `SIGHUP` is on the list for the same reason as everywhere else
// in this repository: a runner tearing its session down sends it, and it
// is the one whose default was still being taken.
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
process.on("SIGHUP", () => process.exit(129));

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
    liveChild = child;
    child.on("exit", (c) => {
      resolveExit(c ?? 1);
    });
  });
  liveChild = null;
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
  const exited = new Promise<number | string>((resolveExit) => {
    child.on("exit", (c, signal) => {
      // A signal death has no exit code; naming the signal keeps a
      // KILLed child from reporting as an ordinary exit 1.
      resolveExit(c ?? signal ?? 1);
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
  const health = await waitForHealth({
    url: `http://127.0.0.1:${String(port)}/health`,
    budgetMs: Math.max(0, deadline - Date.now()),
    // From the whole readiness budget, not from what the listen-line wait
    // left of it. The two share one deadline, so a slow boot shrinks the
    // remainder — and deriving the per-attempt ceiling from that remainder
    // narrows it exactly when the machine is loaded enough for a healthy
    // endpoint to be slow. A boot that spent eighty of ninety seconds
    // reaching its listen line would give each health attempt a third of a
    // second to answer in.
    attemptTimeoutMs: attemptTimeoutMs(READY_BUDGET_MS),
    shouldStop: () =>
      child.exitCode === null
        ? null
        : `the process exited ${String(child.exitCode)} after its listen line`,
  });
  if (health.stoppedEarly) {
    // A process that died is a different failure from an endpoint that
    // never answered, and reporting it as the latter is what sent a
    // previous diagnosis to the wrong place.
    fail(`role=${role} ${health.lastOutcome}`, output);
  }
  if (!health.ok) {
    fail(
      `role=${role} /health never answered 200 ` +
        `(${String(health.attempts)} attempts; last: ${health.lastOutcome})`,
      output,
    );
  }

  if (!output.includes(ROLE_MARKER[role])) {
    fail(
      `role=${role} health passed but the boot log lacks "${ROLE_MARKER[role]}"`,
      output,
    );
  }

  if (role === ROLES[0]) {
    for (const tag of FIRST_BOOT_REGISTERS) {
      if (!output.includes(tag)) {
        fail(
          `role=${role} booted against an empty catalog without registering ` +
            `${tag}. Its manifest ships with the build rather than being ` +
            `installed, so this is what a boot that reconciles only the ` +
            `integrations directory looks like.`,
          output,
        );
      }
    }
  }

  child.kill("SIGTERM");
  const code = await Promise.race([
    exited,
    sleep(SHUTDOWN_BUDGET_MS).then(() => -1 as const),
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
