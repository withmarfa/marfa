import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptedServer, type Answer } from "../../device/scripted-server.js";
import { keychainEnv } from "../../utils/keychain.js";
import {
  folderItem,
  hydratedHarness,
  requireBinary,
  scriptHydration,
} from "./harness.js";
import {
  answers,
  SCRIPTED_INSTANCE,
  SCRIPTED_TYPES,
} from "../../device/marfa-answers.js";

const run = promisify(execFile);

/**
 * The lock the binary takes for `origin` under the keychain file `keychain`
 * names, which it keeps beside that file.
 */
function lockFor(keychain: string, origin: string): string {
  return join(
    `${keychain}.locks`,
    `${createHash("sha256").update(origin).digest("hex")}.lock`,
  );
}

it("refuses an unsafe credential lock across environment overrides before contacting the server", async () => {
  const server = await ScriptedServer.start();
  const prefix = `/credential-${randomUUID()}`;
  const origin = `${server.url}${prefix}`;
  const folder = mkdtempSync(join(tmpdir(), "marfa-credential-environment-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("MARFA_")),
  );
  Object.assign(env, keychainEnv());
  const lock = lockFor(env.MARFA_KEYCHAIN!, origin);
  let madeLock = false;
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
    mkdirSync(dirname(lock), { mode: 0o700, recursive: true });
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
  const environment = mkdtempSync(join(tmpdir(), "marfa-credential-unsafe-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("MARFA_")),
  );
  Object.assign(env, keychainEnv());
  const lock = lockFor(env.MARFA_KEYCHAIN!, origin);
  mkdirSync(dirname(lock), { mode: 0o700, recursive: true });
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

/**
 * A keychain file of the test's own: `keys keep`, a sign-in and a refresh
 * each make their origin the current one, which the run's shared keychain
 * must not be left holding while other files run.
 */
function ownKeychain(): { path: string; remove: () => void } {
  const folder = mkdtempSync(join(tmpdir(), "marfa-credential-keychain-"));
  const path = join(folder, "credentials.keychain-db");
  const password = randomUUID();
  execFileSync("security", ["create-keychain", "-p", password, path]);
  // Unlocked, and never locking itself under the run: a locked keychain is
  // one `security` would ask a person to unlock.
  execFileSync("security", ["unlock-keychain", "-p", password, path]);
  execFileSync("security", ["set-keychain-settings", path]);
  return {
    path,
    remove: () => {
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

/**
 * Keeps `kept` for `origin` as a sign-in or `keys keep` would, readable by
 * any process. What the keychain holds is read back only through the
 * binary, which never asks a person: `security` reading the secret of an
 * item the binary wrote would.
 */
function keepInKeychain(
  keychain: string,
  origin: string,
  kept: Record<string, unknown>,
): void {
  execFileSync("security", [
    "add-generic-password",
    "-U",
    "-A",
    "-s",
    "marfa",
    "-a",
    origin,
    "-w",
    JSON.stringify(kept),
    keychain,
  ]);
}

interface Running {
  exited: () => boolean;
  done: Promise<{ code: number; stdout: string; stderr: string }>;
  stdout: () => string;
}

/** Starts the binary against `origin` under `keychain`, with a home of its own. */
function marfaAt(keychain: string, origin: string, args: string[]): Running {
  const home = mkdtempSync(
    join(realpathSync(tmpdir()), "marfa-credential-home-"),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("MARFA_")),
  );
  const child = execFile(
    requireBinary(),
    ["--json", "--url", origin, ...args],
    {
      env: { ...env, MARFA_KEYCHAIN: keychain, HOME: home },
      timeout: 30_000,
    },
  );
  child.stdin?.end();
  let stdout = "";
  let stderr = "";
  let exited = false;
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const done = new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve) => {
      child.on("close", (code) => {
        exited = true;
        rmSync(home, { recursive: true, force: true });
        resolve({ code: code ?? -1, stdout, stderr });
      });
    },
  );
  return { exited: () => exited, done, stdout: () => stdout };
}

/**
 * Holds the credential lock for `origin` from another process, as a refresh,
 * `logout` or `keys forget` holds it while it changes the kept credential.
 */
async function holdCredentialLock(
  keychain: string,
  origin: string,
): Promise<{ release: () => Promise<void> }> {
  const lock = lockFor(keychain, origin);
  mkdirSync(dirname(lock), { mode: 0o700, recursive: true });
  const holder = spawn(
    "python3",
    [
      "-c",
      [
        "import fcntl, os, sys",
        "fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)",
        "fcntl.flock(fd, fcntl.LOCK_EX)",
        "print('held', flush=True)",
        "sys.stdin.read()",
      ].join("\n"),
      lock,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  await new Promise<void>((resolve, reject) => {
    holder.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("held")) resolve();
    });
    holder.on("error", reject);
    holder.on("close", () => {
      reject(new Error("the lock holder ended before it held the lock"));
    });
  });
  return {
    release: async () => {
      const closed = new Promise((resolve) => holder.on("close", resolve));
      holder.stdin.end();
      await closed;
    },
  };
}

/** Long enough for a command that is not waiting to have run to its end. */
const SETTLE_MS = 1_500;
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

const signIn = (
  server: ScriptedServer,
  prefix: string,
  revocation: string | null,
  expiresAt: number | null = null,
) => ({
  kind: "token",
  access_token: "marfa_at_fixture",
  refresh_token: "marfa_rt_fixture",
  expires_at: expiresAt,
  client_id: "fixture",
  scope: "*:read",
  token_endpoint: `${server.url}${prefix}/token`,
  revocation_endpoint: revocation,
});

const ROOT: Answer = {
  kind: "json",
  status: 200,
  body: {
    name: "marfa",
    version: "fixture",
    instance_id: "credential-fixture",
  },
};

describe.runIf(process.platform === "darwin")("a kept credential", () => {
  let keychain: { path: string; remove: () => void };
  let server: ScriptedServer;
  beforeEach(async () => {
    keychain = ownKeychain();
    server = await ScriptedServer.start();
  });
  afterEach(async () => {
    await server.stop();
    keychain.remove();
  });
  it("renews an expired stored token before folder binding completes", async () => {
    const dir = mkdtempSync(
      join(realpathSync(tmpdir()), "marfa-folder-renewal-"),
    );
    const folder = {
      id: randomUUID(),
      version: 1,
      settings: { search: { types: ["core.note"] } },
    };
    scriptHydration(server, { head: "1", edges: {} });
    server.copyAnswer(
      "GET",
      `/items/${folder.id}`,
      {
        kind: "json",
        status: 401,
        body: { error: { code: "unauthorized", message: "expired" } },
      },
      answers.updated(folderItem(folder)),
    );
    keepInKeychain(keychain.path, server.url, signIn(server, "", null, 1));
    server.answer("POST", "/token", {
      kind: "json",
      status: 200,
      body: {
        access_token: "folder-renewed-fixture",
        refresh_token: "folder-next-fixture",
        expires_in: 3600,
        scope: "*:read",
      },
    });
    try {
      const added = await marfaAt(keychain.path, server.url, [
        "folders",
        "add",
        dir,
        "--folder",
        folder.id,
        "--yes",
      ]).done;
      expect(added.code, added.stdout + added.stderr).toBe(0);
      const rows = server.requests.filter(
        (request) => request.pathname === `/items/${folder.id}`,
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]!.headers.authorization).toBe("Bearer marfa_at_fixture");
      expect(rows[1]!.headers.authorization).toBe(
        "Bearer folder-renewed-fixture",
      );
      expect(
        server.requests.filter((request) => request.pathname === "/token"),
      ).toHaveLength(1);
      const hydrated = await marfaAt(keychain.path, server.url, [
        "folders",
        "hydrate",
        dir,
      ]).done;
      expect(hydrated.code, hydrated.stdout + hydrated.stderr).toBe(0);
      const before = await marfaAt(keychain.path, server.url, [
        "folders",
        "status",
        dir,
      ]).done;
      const wrong = await ScriptedServer.start();
      try {
        wrong.answer("GET", "/", ROOT);
        keepInKeychain(keychain.path, wrong.url, signIn(wrong, "", null, 1));
        const refused = await marfaAt(keychain.path, wrong.url, [
          "folders",
          "add",
          dir,
          "--folder",
          folder.id,
          "--yes",
        ]).done;
        expect(refused.code).toBe(4);
        expect(JSON.parse(refused.stderr)).toMatchObject({
          error: { code: "wrong_server" },
        });
        expect(
          wrong.requests.map(
            (request) => `${request.method} ${request.pathname}`,
          ),
        ).toEqual(["GET /"]);
        expect(wrong.requests[0]!.headers.authorization).toBeUndefined();
        const after = await marfaAt(keychain.path, server.url, [
          "folders",
          "status",
          dir,
        ]).done;
        expect(after).toEqual(before);
      } finally {
        await wrong.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defers working-copy token renewal until the new origin confirms its identity", async () => {
    const copy = await hydratedHarness("relocation-stale-credential");
    const prefix = `/relocation-${randomUUID()}`;
    const origin = `${server.url}${prefix}`;
    keepInKeychain(keychain.path, origin, signIn(server, prefix, null, 1));
    let instance = "credential-fixture";
    let badRoot: Answer | undefined;
    const root = (): Answer =>
      badRoot ?? {
        kind: "json",
        status: 200,
        body: { name: "marfa", version: "fixture", instance_id: instance },
      };
    server.answer("GET", prefix, root);
    server.answer("GET", `${prefix}/`, root);
    server.copyAnswer("POST", `${prefix}/token`, {
      kind: "json",
      status: 200,
      body: {
        access_token: "renewed-fixture",
        refresh_token: "next-fixture",
        token_type: "Bearer",
        expires_in: 3600,
      },
    });
    try {
      const queued = await copy.device.create({
        type: "core.note",
        properties: { title: "Unsent relocation", body: "kept" },
      });
      expect(queued.ok).toBe(true);
      const before = await copy.device.queue();
      const statusBefore = await copy.device.status();
      const local = await marfaAt(keychain.path, origin, [
        "device",
        "--db",
        copy.device.store,
        "items",
        "list",
      ]).done;
      expect(local.code, local.stderr).toBe(0);
      expect(server.requests).toHaveLength(0);
      const wrong = await marfaAt(keychain.path, origin, [
        "device",
        "--db",
        copy.device.store,
        "types",
        "served",
      ]).done;
      expect(
        server.requests.map(
          (request) => `${request.method} ${request.pathname}`,
        ),
      ).toEqual([`GET ${prefix}`]);
      expect(wrong.code, wrong.stdout + wrong.stderr).toBe(4);
      expect(JSON.parse(wrong.stderr)).toMatchObject({
        error: { code: "wrong_server" },
      });
      expect(server.requests.map((request) => request.pathname)).toEqual([
        prefix,
      ]);
      expect(server.requests[0]!.headers.authorization).toBeUndefined();
      expect(await copy.device.queue()).toEqual(before);

      const refusedRoots: Answer[] = [
        { kind: "json", status: 200, body: {} },
        {
          kind: "json",
          status: 401,
          body: { error: { code: "unauthorized", message: "refused" } },
        },
        { kind: "json", status: 503, body: {} },
        {
          kind: "json",
          status: 302,
          body: {},
          headers: { location: `${origin}/token` },
        },
      ];
      for (const answer of refusedRoots) {
        badRoot = answer;
        const count = server.requests.length;
        const refused = await marfaAt(keychain.path, origin, [
          "device",
          "--db",
          copy.device.store,
          "types",
          "served",
        ]).done;
        expect(refused.code).not.toBe(0);
        expect(
          server.requests
            .slice(count)
            .map((request) => `${request.method} ${request.pathname}`),
        ).toEqual([`GET ${prefix}`]);
        expect(server.requests.at(-1)!.headers.authorization).toBeUndefined();
        expect(await copy.device.queue()).toEqual(before);
        expect(await copy.device.status()).toEqual(statusBefore);
      }
      badRoot = undefined;
      instance = SCRIPTED_INSTANCE;
      server.copyAnswer(
        "GET",
        `${prefix}/types`,
        {
          kind: "json",
          status: 401,
          body: { error: { code: "unauthorized", message: "expired" } },
        },
        {
          kind: "json",
          status: 200,
          body: { data: SCRIPTED_TYPES, next_cursor: null },
        },
      );
      server.copyAnswer("GET", `${prefix}/edge-types`, {
        kind: "json",
        status: 200,
        body: { data: [], next_cursor: null },
      });
      const same = await marfaAt(keychain.path, origin, [
        "device",
        "--db",
        copy.device.store,
        "types",
        "served",
      ]).done;
      expect(same.code, same.stderr).toBe(0);
      expect(server.requests.map((request) => request.pathname)).toEqual([
        ...Array(2 + refusedRoots.length).fill(prefix),
        `${prefix}/types`,
        `${prefix}/`,
        `${prefix}/token`,
        `${prefix}/types`,
        `${prefix}/edge-types`,
      ]);
      expect(
        server.requests[1 + refusedRoots.length]!.headers.authorization,
      ).toBeUndefined();
      expect(server.requests.at(-2)!.headers.authorization).toBe(
        "Bearer renewed-fixture",
      );
      expect(await copy.device.queue()).toEqual(before);
      const after = await copy.device.status();
      expect(statusBefore.ok && after.ok && after.value).toEqual(
        statusBefore.ok
          ? { ...statusBefore.value, server_origin: origin }
          : null,
      );
    } finally {
      await copy.stop();
    }
  });

  const sentTo = (prefix: string) =>
    server.requests
      .filter((request) => request.pathname.startsWith(prefix))
      .map((request) => request.pathname.slice(prefix.length));
  /** The keychain file's bytes, which change when anything is kept. */
  const keychainFile = () =>
    createHash("sha256").update(readFileSync(keychain.path)).digest("hex");
  /** The credential the binary finds kept for `origin`, as `whoami` reports it. */
  async function keptFor(
    origin: string,
  ): Promise<{ kind: string; from: string } | null> {
    server.answer("GET", `${new URL(origin).pathname}/`, ROOT);
    const out = await marfaAt(keychain.path, origin, ["whoami"]).done;
    expect(out.code, out.stderr).toBe(0);
    return (
      JSON.parse(out.stdout) as {
        credential: { kind: string; from: string } | null;
      }
    ).credential;
  }

  it("reports a sign-out the server did not revoke as revoked: false, and forgets the token either way", async () => {
    const gone = await ScriptedServer.start();
    const unreachable = `${gone.url}/revoke`;
    await gone.stop();
    const cases: Array<{
      name: string;
      endpoint: (prefix: string) => string | null;
      answer?: Answer;
      revoked: boolean;
    }> = [
      { name: "no endpoint", endpoint: () => null, revoked: false },
      {
        name: "refused",
        endpoint: (prefix) => `${server.url}${prefix}/revoke`,
        answer: {
          kind: "json",
          status: 400,
          body: { error: "invalid_request" },
        },
        revoked: false,
      },
      { name: "unreachable", endpoint: () => unreachable, revoked: false },
      // The witness: a revocation the server takes reads as one.
      {
        name: "taken",
        endpoint: (prefix) => `${server.url}${prefix}/revoke`,
        answer: { kind: "json", status: 200, body: {} },
        revoked: true,
      },
    ];
    for (const { name, endpoint, answer, revoked } of cases) {
      const prefix = `/credential-${randomUUID()}`;
      const origin = `${server.url}${prefix}`;
      if (answer !== undefined)
        server.answer("POST", `${prefix}/revoke`, answer);
      keepInKeychain(
        keychain.path,
        origin,
        signIn(server, prefix, endpoint(prefix)),
      );
      const out = await marfaAt(keychain.path, origin, ["logout"]).done;
      expect(out.code, `${name}: ${out.stderr}`).toBe(0);
      expect(JSON.parse(out.stdout), name).toEqual({
        server: origin,
        signed_out: true,
        revoked,
      });
      expect(sentTo(prefix), name).toEqual(
        answer === undefined ? [] : ["/revoke"],
      );
      expect(await keptFor(origin), `${name}: still kept`).toBeNull();
    }
  });

  it("forgets a kept key without sending anything", async () => {
    const prefix = `/credential-${randomUUID()}`;
    const origin = `${server.url}${prefix}`;
    keepInKeychain(keychain.path, origin, { kind: "key", key: "fixture-key" });
    const forgot = await marfaAt(keychain.path, origin, ["keys", "forget"])
      .done;
    expect(forgot.code, forgot.stderr).toBe(0);
    expect(JSON.parse(forgot.stdout)).toEqual({ origin, forgotten: true });
    const again = await marfaAt(keychain.path, origin, ["keys", "forget"]).done;
    expect(JSON.parse(again.stdout)).toEqual({ origin, forgotten: false });
    expect(server.requests).toEqual([]);
    expect(await keptFor(origin)).toBeNull();
  });

  it("keeps a key only once another process has finished changing the kept credential", async () => {
    const prefix = `/credential-${randomUUID()}`;
    const origin = `${server.url}${prefix}`;
    server.answer("GET", `${prefix}/items/stats`, {
      kind: "json",
      status: 200,
      body: { total: 0, by_type: {}, by_state: {}, by_tier: {} },
    });
    const before = keychainFile();
    const lock = await holdCredentialLock(keychain.path, origin);
    const keep = marfaAt(keychain.path, origin, [
      "--key",
      "fixture-key",
      "keys",
      "keep",
    ]);
    try {
      await settle();
      expect(keep.exited(), "keys keep did not wait").toBe(false);
      expect(keychainFile(), "the key was kept while the lock was held").toBe(
        before,
      );
    } finally {
      await lock.release();
    }
    const kept = await keep.done;
    expect(kept.code, kept.stderr).toBe(0);
    // The witness: once the change ends, the key is kept.
    expect(keychainFile()).not.toBe(before);
    expect(await keptFor(origin)).toMatchObject({ from: "keychain" });
  });

  it("keeps a sign-in's token only once another process has finished changing the kept credential", async () => {
    const prefix = `/credential-${randomUUID()}`;
    const origin = `${server.url}${prefix}`;
    const at = (path: string) => `${server.url}${prefix}${path}`;
    server.answer(
      "GET",
      `${prefix}/auth/.well-known/oauth-authorization-server`,
      {
        kind: "json",
        status: 200,
        body: {
          issuer: at("/auth"),
          token_endpoint: at("/token"),
          device_authorization_endpoint: at("/device"),
          registration_endpoint: at("/register"),
          revocation_endpoint: at("/revoke"),
        },
      },
    );
    server.answer("POST", `${prefix}/device`, {
      kind: "json",
      status: 200,
      body: {
        device_code: "fixture-device-code",
        user_code: "FIXTURE1",
        verification_uri: at("/device"),
        expires_in: 60,
        interval: 1,
      },
    });
    let approve = () => undefined as void;
    const approved = new Promise<void>((resolve) => {
      approve = resolve;
    });
    server.answer("POST", `${prefix}/token`, {
      kind: "gated",
      until: approved,
      then: {
        kind: "json",
        status: 200,
        body: {
          access_token: "marfa_at_signed_in",
          refresh_token: "marfa_rt_signed_in",
          expires_in: 3600,
          scope: "*:read",
        },
      },
    });
    const login = marfaAt(keychain.path, origin, [
      "login",
      "--no-browser",
      "--client-id",
      "fixture",
    ]);
    await vi.waitFor(
      () => {
        expect(login.stdout()).toContain("\n");
      },
      { timeout: 10_000, interval: 25 },
    );
    const before = keychainFile();
    const lock = await holdCredentialLock(keychain.path, origin);
    try {
      approve();
      await vi.waitFor(
        () => {
          expect(sentTo(prefix)).toContain("/token");
        },
        { timeout: 10_000, interval: 25 },
      );
      await settle();
      expect(login.exited(), "the sign-in did not wait").toBe(false);
      expect(keychainFile(), "the token was kept while the lock was held").toBe(
        before,
      );
    } finally {
      await lock.release();
    }
    const signedIn = await login.done;
    expect(signedIn.code, signedIn.stderr).toBe(0);
    expect(keychainFile()).not.toBe(before);
    expect(await keptFor(origin)).toMatchObject({
      kind: "token",
      from: "keychain",
    });
  });

  it("revokes the token a refresh under way keeps, when a sign-out waits on it", async () => {
    const prefix = `/credential-${randomUUID()}`;
    const origin = `${server.url}${prefix}`;
    server.answer("GET", `${prefix}/`, ROOT);
    let answer = () => undefined as void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    server.answer("POST", `${prefix}/token`, {
      kind: "gated",
      until: answered,
      then: {
        kind: "json",
        status: 200,
        body: {
          access_token: "marfa_at_refreshed",
          refresh_token: "marfa_rt_refreshed",
          expires_in: 3600,
          scope: "*:read",
        },
      },
    });
    server.answer("POST", `${prefix}/revoke`, {
      kind: "json",
      status: 200,
      body: {},
    });
    keepInKeychain(
      keychain.path,
      origin,
      signIn(server, prefix, `${server.url}${prefix}/revoke`, 1),
    );
    const refreshing = marfaAt(keychain.path, origin, ["whoami"]);
    await vi.waitFor(
      () => {
        expect(sentTo(prefix)).toContain("/token");
      },
      { timeout: 10_000, interval: 25 },
    );
    const logout = marfaAt(keychain.path, origin, ["logout"]);
    await settle();
    expect(logout.exited(), "the sign-out did not wait on the refresh").toBe(
      false,
    );
    answer();
    await refreshing.done;
    const out = await logout.done;
    expect(out.code, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ revoked: true });
    const revoked = server.requests.find(
      (request) => request.pathname === `${prefix}/revoke`,
    );
    expect(revoked?.body).toContain("token=marfa_rt_refreshed");
    expect(await keptFor(origin)).toBeNull();
  });

  it("brings back no sign-in a sign-out under way forgets, when a refresh waits on it", async () => {
    const prefix = `/credential-${randomUUID()}`;
    const origin = `${server.url}${prefix}`;
    server.answer("GET", `${prefix}/`, ROOT);
    server.answer("POST", `${prefix}/token`, {
      kind: "json",
      status: 200,
      body: {
        access_token: "marfa_at_refreshed",
        refresh_token: "marfa_rt_refreshed",
        expires_in: 3600,
      },
    });
    let answer = () => undefined as void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    server.answer("POST", `${prefix}/revoke`, {
      kind: "gated",
      until: answered,
      then: { kind: "json", status: 200, body: {} },
    });
    keepInKeychain(
      keychain.path,
      origin,
      signIn(server, prefix, `${server.url}${prefix}/revoke`, 1),
    );
    const logout = marfaAt(keychain.path, origin, ["logout"]);
    await vi.waitFor(
      () => {
        expect(sentTo(prefix)).toContain("/revoke");
      },
      { timeout: 10_000, interval: 25 },
    );
    const refreshing = marfaAt(keychain.path, origin, ["whoami"]);
    await settle();
    expect(
      refreshing.exited(),
      "the refresh did not wait on the sign-out",
    ).toBe(false);
    answer();
    expect((await logout.done).code).toBe(0);
    await refreshing.done;
    expect(sentTo(prefix)).not.toContain("/token");
    expect(await keptFor(origin)).toBeNull();
  });
});
