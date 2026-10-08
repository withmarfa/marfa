import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { ScriptedServer } from "../../device/scripted-server.js";
import { keychainEnv } from "../../utils/keychain.js";
import { requireBinary } from "./harness.js";

const run = promisify(execFile);

it("refuses an unsafe credential lock across environment overrides before contacting the server", async () => {
  const server = await ScriptedServer.start();
  const prefix = `/credential-${randomUUID()}`;
  const origin = `${server.url}${prefix}`;
  const folder = mkdtempSync(join(tmpdir(), "marfa-credential-environment-"));
  const directory = join(userInfo().homedir, ".marfa-credential-locks");
  const lock = join(
    directory,
    `${createHash("sha256").update(origin).digest("hex")}.lock`,
  );
  let madeLock = false;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("MARFA_")),
  );
  Object.assign(env, keychainEnv());
  const read = async (name: string) => {
    const environment = join(folder, name);
    mkdirSync(environment);
    try {
      const { stdout, stderr } = await run(
        requireBinary(),
        ["--json", "--url", origin, "whoami"],
        {
          env: {
            ...env,
            HOME: environment,
            TMPDIR: environment,
            XDG_RUNTIME_DIR: environment,
          },
          timeout: 30_000,
        },
      );
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as {
        code?: unknown;
        stdout?: string;
        stderr?: string;
      };
      if (typeof failed.code !== "number") throw error;
      return {
        code: failed.code,
        stdout: failed.stdout ?? "",
        stderr: failed.stderr ?? "",
      };
    }
  };
  const answer = () =>
    server.copyAnswer("GET", `${prefix}/`, {
      kind: "json",
      status: 200,
      body: {
        name: "marfa",
        version: "fixture",
        instance_id: "credential-fixture",
      },
    });
  try {
    mkdirSync(directory, { mode: 0o700, recursive: true });
    writeFileSync(lock, "", { flag: "wx", mode: 0o600 });
    madeLock = true;
    answer();
    const first = await read("safe");
    expect(first.code, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ credential: null });
    expect(server.requests).toHaveLength(1);

    chmodSync(lock, 0o644);
    const refused = await read("unsafe");
    expect(refused.code, refused.stderr).toBe(1);
    expect(JSON.parse(refused.stderr)).toMatchObject({
      error: { code: "invalid" },
    });
    expect(refused.stderr).toContain("credential lock");
    expect(server.requests).toHaveLength(1);

    chmodSync(lock, 0o600);
    answer();
    const restored = await read("restored");
    expect(restored.code, restored.stderr).toBe(0);
    expect(server.requests).toHaveLength(2);
  } finally {
    // Retain the inode because another process may already be waiting on it.
    if (madeLock) chmodSync(lock, 0o600);
    await server.stop();
    rmSync(folder, { recursive: true, force: true });
  }
});

/**
 * Runs the binary as the user it is, against `origin`, with the lock file for
 * that origin made readable by others, which is a lock no command may use.
 */
async function withUnsafeLock(
  origin: string,
  args: string[],
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const directory = join(userInfo().homedir, ".marfa-credential-locks");
  const lock = join(
    directory,
    `${createHash("sha256").update(origin).digest("hex")}.lock`,
  );
  const environment = mkdtempSync(join(tmpdir(), "marfa-credential-unsafe-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("MARFA_")),
  );
  Object.assign(env, keychainEnv());
  mkdirSync(directory, { mode: 0o700, recursive: true });
  writeFileSync(lock, "", { flag: "wx", mode: 0o644 });
  chmodSync(lock, 0o644);
  try {
    const child = execFile(
      requireBinary(),
      ["--json", "--url", origin, ...args],
      {
        env: { ...env, HOME: environment },
        timeout: 30_000,
      },
    );
    child.stdin?.end(input ?? "");
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number>((resolve) => {
      child.on("close", (exit) => {
        resolve(exit ?? -1);
      });
    });
    return { code, stdout, stderr };
  } finally {
    // Retain the inode because another process may already be waiting on it.
    chmodSync(lock, 0o600);
    rmSync(environment, { recursive: true, force: true });
  }
}

it("refuses to keep a key under an unsafe credential lock, keeping nothing and sending nothing", async () => {
  const server = await ScriptedServer.start();
  const prefix = `/credential-${randomUUID()}`;
  const origin = `${server.url}${prefix}`;
  server.copyAnswer("GET", `${prefix}/items/stats`, {
    kind: "json",
    status: 200,
    body: { total: 0, by_type: {}, by_state: {}, by_tier: {} },
  });
  try {
    const refused = await withUnsafeLock(origin, [
      "--key",
      "fixture-key",
      "keys",
      "keep",
    ]);
    expect(refused.code, refused.stdout + refused.stderr).toBe(1);
    expect(JSON.parse(refused.stderr)).toMatchObject({
      error: { code: "invalid" },
    });
    expect(refused.stderr).toContain("credential lock");
    expect(
      server.requests,
      "the key was checked against the server before the lock was taken",
    ).toHaveLength(0);
  } finally {
    await server.stop();
  }
});

it("refuses a sign-in under an unsafe credential lock before asking for a code", async () => {
  const server = await ScriptedServer.start();
  const prefix = `/credential-${randomUUID()}`;
  const origin = `${server.url}${prefix}`;
  try {
    const refused = await withUnsafeLock(origin, ["login", "--no-browser"]);
    expect(refused.code, refused.stdout + refused.stderr).toBe(1);
    expect(refused.stderr).toContain("credential lock");
    expect(
      server.requests,
      "the sign-in reached the server before it found it could not keep what it is given",
    ).toHaveLength(0);
  } finally {
    await server.stop();
  }
});
