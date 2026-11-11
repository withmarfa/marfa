import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { controlRequest } from "../../utils/control-request.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
} from "../../utils/fresh-server.js";

// The regular harness requires hooks, so release behavior needs a separate process.

const STARTED_BUDGET_MS = 60_000;
const EXIT_BUDGET_MS = 30_000;
const PLAIN_SECRET = /^[0-9a-f]{64}$/;

function releaseProgram(): string {
  const program = process.env.MARFA_SERVER_RELEASE_BIN;
  if (program === undefined || program === "") {
    throw new Error(
      "MARFA_SERVER_RELEASE_BIN is not set; point it at the server built " +
        "without the test-hooks feature (cargo build --release -p marfa-server)",
    );
  }
  const path = resolve(program);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(
      `MARFA_SERVER_RELEASE_BIN names ${path}, which is not a file`,
    );
  }
  return path;
}

interface Run {
  child: ChildProcess;
  socket: string;
  output(): string;
  exit: Promise<number | null>;
}

const folders: string[] = [];
const running: Run[] = [];

function folder(prefix: string): string {
  const made = realpathSync(mkdtempSync(resolve(tmpdir(), prefix)));
  chmodSync(made, 0o700);
  folders.push(made);
  return made;
}

function start(
  data: string,
  settings: Record<string, string> = {},
  socket = resolve(folder("marfa-hf-socket-"), "control.sock"),
): Run {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const own =
      name.startsWith("MARFA_") && name !== "MARFA_SERVER_RELEASE_BIN";
    const reporting = /^(OTEL_|MARFA_OTEL_|MARFA_POSTHOG_)/.test(name);
    if (!own && !reporting) env[name] = value;
  }
  env.OTEL_SDK_DISABLED = "true";
  Object.assign(env, {
    MARFA_PORT: "0",
    MARFA_LISTEN_HOST: "127.0.0.1",
    MARFA_CONTROL_SOCKET: socket,
    MARFA_DATABASE_PATH: resolve(data, "marfa.db"),
    MARFA_BLOB_PATH: resolve(data, "blobs"),
    MARFA_ENRICHMENT_ENABLED: "false",
    MARFA_ENRICHMENT_OCR_ENABLED: "false",
    ...settings,
  });
  const child = spawn(releaseProgram(), [], {
    cwd: data,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  child.stdout?.on("data", (part: Buffer) => (text += part.toString("utf8")));
  child.stderr?.on("data", (part: Buffer) => (text += part.toString("utf8")));
  const exit = new Promise<number | null>((done) =>
    child.once("exit", (code) => done(code)),
  );
  const run = { child, socket, output: () => text, exit };
  running.push(run);
  return run;
}

async function within<T>(ms: number, what: string, waiting: Promise<T>) {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([waiting, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves once the server says it listens, and fails if it exits first. */
async function listening(run: Run): Promise<void> {
  const polled = (async () => {
    for (;;) {
      if (run.output().includes("Marfa server listening")) return;
      if (run.child.exitCode !== null) {
        throw new Error(
          `the server exited before it listened:\n${run.output()}`,
        );
      }
      await new Promise((again) => setTimeout(again, 100));
    }
  })();
  await within(STARTED_BUDGET_MS, "the server listened", polled);
}

/** Stops a server this file started, by the pid it holds. */
async function stop(run: Run): Promise<void> {
  if (run.child.exitCode === null) run.child.kill("SIGTERM");
  await within(EXIT_BUDGET_MS, "the server stopped", run.exit);
}

afterAll(async () => {
  for (const run of running) {
    if (run.child.exitCode === null) run.child.kill("SIGKILL");
  }
  for (const made of folders) rmSync(made, { recursive: true, force: true });
  await stopFreshServers();
}, FRESH_SERVER_TIMEOUT_MS);

describe("a server built without test hooks", () => {
  it("refuses to start with MARFA_TEST_HOOKS true and names the setting", async () => {
    const data = folder("marfa-hf-data-");
    const refused = start(data, { MARFA_TEST_HOOKS: "true" });
    const code = await within(
      EXIT_BUDGET_MS,
      "the server exited",
      refused.exit,
    );
    expect(code).not.toBe(0);
    expect(refused.output()).toContain("MARFA_TEST_HOOKS");
    expect(refused.output()).not.toContain("Marfa server listening");

    // The witness: the same program, with the setting off, starts.
    const off = start(folder("marfa-hf-data-"), { MARFA_TEST_HOOKS: "false" });
    await listening(off);
    await stop(off);
  });

  it("refuses a tuning and names the setting, where a hooked server takes it", async () => {
    const refused = start(folder("marfa-hf-data-"), {
      MARFA_TEST_TUNING: "interval.audit-cleanup=5",
    });
    const code = await within(
      EXIT_BUDGET_MS,
      "the server exited",
      refused.exit,
    );
    expect(code).not.toBe(0);
    expect(refused.output()).toContain("MARFA_TEST_TUNING");
    expect(refused.output()).not.toContain("Marfa server listening");

    const hooked = await bootFreshServer("hook-free-tuning-witness", {
      MARFA_TEST_TUNING: "interval.audit-cleanup=5",
    });
    expect((await fetch(`${hooked.apiUrl}/health`)).status).toBe(200);
  });

  it("serves no clock or fault route on its private socket, where a hooked server serves them", async () => {
    const hooked = await bootFreshServer("hook-free-witness");
    const routes = [
      ["GET", "/_control/test/clock"],
      ["GET", "/_control/test/faults"],
    ] as const;
    for (const [method, path] of routes) {
      const served = await controlRequest(hooked.controlSocket, path, {
        method,
      });
      expect(served.status, path).toBe(200);
    }

    const free = start(folder("marfa-hf-data-"));
    await listening(free);
    try {
      for (const [method, path] of routes) {
        const answer = await controlRequest(free.socket, path, { method });
        expect(answer.status, path).toBe(404);
      }
      // The socket itself answers, so the 404 is the route's.
      expect((await controlRequest(free.socket, "/health")).status).toBe(200);
    } finally {
      await stop(free);
    }
  });
});

describe("a server whose test hooks are off", () => {
  it("takes no default of a stored setting from the environment", async () => {
    const free = start(folder("marfa-hf-data-"), {
      MARFA_TRASH_RETENTION_DAYS: "5",
    });
    await listening(free);
    try {
      const listed = await controlRequest(free.socket, "/config/settings");
      expect(listed.status).toBe(200);
      const entry = (
        listed.body.data as { key: string; value: unknown; default: unknown }[]
      ).find((row) => row.key === "trash_retention_days");
      expect(entry).toMatchObject({ value: 60, default: 60 });
    } finally {
      await stop(free);
    }
  });
});

describe("the secrets of a server that was not configured by hand", () => {
  const secretsOf = (data: string) => resolve(data, "marfa.secrets");

  function lines(data: string): Record<string, string> {
    return Object.fromEntries(
      readFileSync(secretsOf(data), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split("=") as [string, string]),
    );
  }

  it("generates both into a file only its owner can read, and keeps them across a restart", async () => {
    const data = folder("marfa-hf-data-");
    const first = start(data);
    await listening(first);
    await stop(first);
    const generated = lines(data);
    expect(Object.keys(generated).sort()).toEqual(["auth_secret", "key_salt"]);
    expect(generated.key_salt).toMatch(PLAIN_SECRET);
    expect(generated.auth_secret).toMatch(PLAIN_SECRET);
    expect(generated.key_salt).not.toBe(generated.auth_secret);
    expect(statSync(secretsOf(data)).mode & 0o777).toBe(0o600);

    const written = readFileSync(secretsOf(data));
    const second = start(data);
    await listening(second);
    await stop(second);
    expect(readFileSync(secretsOf(data)).equals(written)).toBe(true);
  });

  it("writes only the secret the environment does not give, and none when it gives both", async () => {
    const given = randomBytes(32).toString("hex");
    const half = folder("marfa-hf-data-");
    const partial = start(half, { MARFA_KEY_SALT: given });
    await listening(partial);
    await stop(partial);
    const kept = lines(half);
    expect(Object.keys(kept)).toEqual(["auth_secret"]);
    expect(Object.values(kept).join()).not.toContain(given);

    const whole = folder("marfa-hf-data-");
    const both = start(whole, {
      MARFA_KEY_SALT: given,
      MARFA_AUTH_SECRET: randomBytes(32).toString("hex"),
    });
    await listening(both);
    await stop(both);
    expect(existsSync(secretsOf(whole))).toBe(false);
  });

  it("uses the secret in the file, and refuses to replace a file that was lost", async () => {
    const data = folder("marfa-hf-data-");
    const first = start(data);
    await listening(first);
    await stop(first);
    expect(existsSync(resolve(data, "marfa.db"))).toBe(true);

    const salt = randomBytes(32).toString("hex");
    const auth = randomBytes(32).toString("hex");
    writeFileSync(secretsOf(data), `key_salt=${salt}\nauth_secret=${auth}\n`, {
      mode: 0o600,
    });
    const second = start(data);
    await listening(second);
    await stop(second);
    expect(lines(data)).toEqual({ key_salt: salt, auth_secret: auth });

    // The database is there and the file is not: not a first start.
    rmSync(secretsOf(data));
    const refused = start(data);
    const code = await within(
      EXIT_BUDGET_MS,
      "the server exited",
      refused.exit,
    );
    expect(code).not.toBe(0);
    expect(refused.output()).toContain("MARFA_KEY_SALT");
    expect(refused.output()).not.toContain("Marfa server listening");
    expect(existsSync(secretsOf(data))).toBe(false);

    // The witness: the owner who gives the salt is let in.
    const restored = start(data, { MARFA_KEY_SALT: salt });
    await listening(restored);
    await stop(restored);
  });
});
