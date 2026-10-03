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
    server.answer("GET", `${prefix}/`, {
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
