import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { serverProgram } from "../../../scripts/marfa-server.js";
import { MarfaClient } from "../../client/api.js";
import { controlRequest } from "../../utils/control-request.js";
import {
  fakeCloud,
  type FakeCloud,
  type FakeCloudOptions,
} from "../../utils/fake-cloud.js";
import { fakeCloudflared } from "../../utils/fake-cloudflared.js";
import {
  bootFreshServer,
  bootRefused,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { issuerOrigin } from "../../utils/signed-in.js";
import type { SseEvent } from "../../utils/sse.js";
import { collectUntil, withStreamAtCursor } from "../../utils/stream.js";
import { TEST_OWNER } from "../../utils/target.js";
import { isRunning, tempFolder } from "../../utils/temp-folder.js";
import { waitFor } from "../../utils/wait.js";

/**
 * The tunnel connector the server runs and supervises while the instance is
 * linked to Marfa Cloud (the cloud chapter), against a fake of Marfa Cloud's
 * link API and a fake connector, both on this machine.
 *
 * **On a server of each test's own.** A link moves what the server believes
 * of its callers' addresses and starts a process, so every test boots a
 * server, a fake Cloud and a fake connector of its own.
 *
 * **Past the target interface.** The fixtures read the server's log and the
 * file the tunnel token is in, which no door shows; the contract is about
 * what is in them.
 */

const clouds: FakeCloud[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(clouds.splice(0).map((cloud) => cloud.close()));
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, FRESH_SERVER_TIMEOUT_MS);

interface Answer {
  status: number;
  body: any;
}

interface Linked {
  cloud: FakeCloud;
  call(method: string, path: string, body?: unknown): Promise<Answer>;
  status(): Promise<any>;
  /** Waits until the link reads as `wanted` says. */
  until(what: string, wanted: (status: any) => boolean): Promise<any>;
  /** Starts a link that keeps the sign-in address, approves it and waits for `linked`. */
  link(): Promise<any>;
  /** Waits for the connector to read as `state`. */
  connector(state: string): Promise<any>;
}

function around(
  cloud: FakeCloud,
  call: Linked["call"],
): Omit<Linked, "cloud" | "call"> {
  const status = async () => {
    const read = await call("GET", "/cloud/link");
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    return read.body;
  };
  const until: Linked["until"] = (what, wanted) =>
    waitFor(
      what,
      async () => {
        const read = await status();
        return wanted(read) ? read : undefined;
      },
      30_000,
      100,
    );
  return {
    status,
    until,
    async link() {
      const started = await call("POST", "/cloud/link", {
        sign_in_address: "keep",
      });
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      cloud.approve();
      return until("the link to be linked", (s) => s.state === "linked");
    },
    connector: (state) =>
      until(
        `the connector to be ${state}`,
        (s) => s.state === "linked" && s.connector.state === state,
      ),
  };
}

/** A server with the connector the fake stands for, linked through a fake Cloud. */
async function boot(
  label: string,
  extraEnv: Record<string, string> = {},
  cloudOptions: FakeCloudOptions = {},
): Promise<Linked & { server: FreshServer }> {
  const cloud = await fakeCloud(cloudOptions);
  clouds.push(cloud);
  const server = await bootFreshServer(label, {
    MARFA_CLOUD_URL: cloud.url,
    ...extraEnv,
  });
  cleanups.push(() => server.stop());
  const call: Linked["call"] = async (method, path, body) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${server.managementKey}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${server.apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { server, cloud, call, ...around(cloud, call) };
}

/** A server started straight from `program`, reached through its private socket. */
async function bootBare(
  program: string,
  env: Record<string, string>,
): Promise<Linked> {
  const cloud = await fakeCloud();
  clouds.push(cloud);
  // Short names: a socket path is bounded at about 100 bytes.
  const root = tempFolder("cc-");
  const socket = join(root, "c.sock");
  const child = spawn(program, [], {
    env: {
      HOME: process.env.HOME,
      MARFA_AUTH_SECRET: randomBytes(32).toString("hex"),
      MARFA_CONTROL_SOCKET: socket,
      MARFA_DATABASE_PATH: join(root, "marfa.db"),
      MARFA_BLOB_PATH: join(root, "blobs"),
      MARFA_ENRICHMENT_ENABLED: "false",
      MARFA_ENRICHMENT_OCR_ENABLED: "false",
      MARFA_PORT: "0",
      MARFA_CLOUD_URL: cloud.url,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = once(child, "exit");
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await exited;
    await rm(root, { recursive: true, force: true });
  });
  await waitFor("the control socket to answer", async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the server ended: ${output}`);
    }
    try {
      return (await controlRequest(socket, "/health")).status === 200
        ? true
        : undefined;
    } catch {
      return undefined;
    }
  });
  const call: Linked["call"] = (method, path, body) =>
    controlRequest(socket, path, { method, body });
  return { cloud, call, ...around(cloud, call) };
}

/**
 * A copy of the server in `libexec`, reached through a link in `bin`, as a
 * package manager installs it, and the connector beside the copy if one is
 * given.
 */
function installed(connector: string | undefined): string {
  const root = tempFolder("ci-");
  mkdirSync(join(root, "libexec"));
  mkdirSync(join(root, "bin"));
  const real = join(root, "libexec", "marfa-server");
  copyFileSync(serverProgram(), real);
  chmodSync(real, 0o755);
  if (connector !== undefined) {
    const beside = join(root, "libexec", "cloudflared");
    copyFileSync(connector, beside);
    chmodSync(beside, 0o755);
  }
  symlinkSync(
    join("..", "libexec", "marfa-server"),
    join(root, "bin", "marfa"),
  );
  return join(root, "bin", "marfa");
}

function logOf(server: FreshServer): string {
  return ["server.log", "server.stderr"]
    .map((name) => join(server.stateDir, name))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

const tokenOf = (linked: Linked) => linked.cloud.latest().tunnelToken;

function gone(pid: number): Promise<true> {
  return waitFor(
    `process ${String(pid)} to end`,
    async () => (isRunning(pid) ? undefined : true),
    15_000,
    100,
  );
}

const ALLOWED_ENVIRONMENT = new Set([
  "HOME",
  "TMPDIR",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // macOS adds this to every process it starts, with an empty environment too.
  "__CF_USER_TEXT_ENCODING",
]);

describe("finding the connector", () => {
  it(
    "refuses to start with a MARFA_CLOUDFLARED that is not an absolute path",
    async () => {
      for (const wrong of ["cloudflared", "./cloudflared", "bin/cloudflared"]) {
        const refused = await bootRefused("connector-path", {
          extraEnv: { MARFA_CLOUDFLARED: wrong },
        });
        cleanups.push(() => refused.stop());
        expect(refused.code, wrong).not.toBe(0);
        expect(refused.output, wrong).toContain("MARFA_CLOUDFLARED");
      }
      // The witness: an absolute path, even of a file that is not there, starts.
      const server = await bootFreshServer("connector-path-absolute", {
        MARFA_CLOUDFLARED: join(tempFolder("cn-"), "cloudflared"),
      });
      cleanups.push(() => server.stop());
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "runs the connector from the file MARFA_CLOUDFLARED names, with the arguments the contract gives",
    async () => {
      const fake = fakeCloudflared();
      fake.plan([{ ready: true }]);
      const linked = await boot("connector-setting", {
        MARFA_CLOUDFLARED: fake.path,
      });
      await linked.link();
      const [start] = await fake.waitForStarts(1);
      const connected = await linked.connector("connected");
      expect(connected.connector.since).toEqual(expect.any(String));
      expect(start!.argv).toEqual([
        "tunnel",
        "--no-autoupdate",
        "--metrics",
        expect.stringMatching(/^127\.0\.0\.1:[1-9]\d*$/),
        "run",
        "--token-file",
        expect.any(String),
      ]);
      const file = start!.tokenFile;
      expect(file).not.toBeNull();
      expect(start!.argv[6]).toBe(file!.path);
      expect(file!.mode).toBe("600");
      expect(file!.text).toBe(tokenOf(linked));
      // The file is in a folder only the server's account reaches.
      expect(statSync(dirname(file!.path)).mode & 0o077).toBe(0);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "runs the connector from beside the server's own executable, found through a link, and never from PATH",
    async () => {
      const fake = fakeCloudflared();
      fake.plan([{ ready: true }]);
      const beside = await bootBare(installed(fake.path), {});
      await beside.link();
      await beside.connector("connected");
      expect(fake.starts()).toHaveLength(1);

      // The witness above is the connector run from beside; now the same
      // program with nothing beside it, and the connector on PATH.
      const alone = fakeCloudflared();
      alone.plan([{ ready: true }]);
      const searching = await bootBare(installed(undefined), {
        PATH: `${dirname(alone.path)}:${process.env.PATH ?? ""}`,
      });
      await searching.link();
      const failed = await searching.connector("failed");
      expect(failed.connector.reason).toBe("missing");
      expect(alone.starts()).toEqual([]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "reports a connector that cannot be run as failed, keeps serving, and runs it once it can be",
    async () => {
      const fake = fakeCloudflared();
      fake.plan([{ ready: true }]);
      fake.uninstall();
      const linked = await boot("connector-missing", {
        MARFA_CLOUDFLARED: fake.path,
      });
      const first = await linked.link();
      expect(["stopped", "starting", "failed"]).toContain(
        first.connector.state,
      );
      const failed = await linked.connector("failed");
      expect(failed.connector.reason).toBe("missing");
      expect(failed.connector.since).toEqual(expect.any(String));
      expect(failed.state).toBe("linked");
      const health = await fetch(`${linked.server.apiUrl}/health`);
      expect(health.status).toBe(200);
      // The witness: once the connector is put in place, the same server runs it.
      fake.install();
      await linked.connector("connected");
      expect(fake.starts()).toHaveLength(1);

      // A file that is there but cannot be run reads the same.
      const plain = join(tempFolder("cn-"), "cloudflared");
      writeFileSync(plain, "#!/bin/sh\n");
      chmodSync(plain, 0o644);
      const unrunnable = await boot("connector-unrunnable", {
        MARFA_CLOUDFLARED: plain,
      });
      await unrunnable.link();
      const refused = await unrunnable.connector("failed");
      expect(refused.connector.reason).toBe("missing");
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("supervising the connector", () => {
  it(
    "runs the connector again after each failure, waiting twice as long each time",
    async () => {
      const fake = fakeCloudflared();
      fake.plan([{ exit: { code: 1, afterMs: 20 } }]);
      const linked = await boot("connector-restart", {
        MARFA_CLOUDFLARED: fake.path,
      });
      await linked.link();
      const starts = await fake.waitForStarts(4);
      const gaps = starts.slice(1).map((start, n) => start.at - starts[n]!.at);
      expect(gaps[0]).toBeGreaterThanOrEqual(950);
      expect(gaps[1]).toBeGreaterThanOrEqual(1950);
      expect(gaps[2]).toBeGreaterThanOrEqual(3950);
      const reconnecting = await linked.until(
        "the connector to read as not running well",
        (s) =>
          s.state === "linked" &&
          ["reconnecting", "starting"].includes(s.connector.state),
      );
      expect(reconnecting.state).toBe("linked");
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps the tunnel token and the server's secrets from the connector's arguments and environment, and out of the log",
    async () => {
      const fake = fakeCloudflared();
      fake.plan([
        { ready: true, echoToken: true, lines: ["INF marker-from-connector"] },
      ]);
      const linked = await boot("connector-hidden", {
        MARFA_CLOUDFLARED: fake.path,
      });
      await linked.link();
      const [start] = await fake.waitForStarts(1);
      await linked.connector("connected");
      const token = tokenOf(linked);
      const sent = JSON.stringify([start!.argv, start!.env]);
      expect(sent).not.toContain(token);
      for (const name of Object.keys(start!.env)) {
        expect(ALLOWED_ENVIRONMENT.has(name), name).toBe(true);
      }
      // The connector's own lines reach the log, the one that carried the
      // token among them, and the token does not.
      const logged = await waitFor(
        "the connector's output in the log",
        async () => {
          const text = logOf(linked.server);
          return text.includes("marker-from-connector") &&
            text.includes("INF token")
            ? text
            : undefined;
        },
      );
      expect(logged).not.toContain(token);
      expect(JSON.stringify(await linked.status())).not.toContain(token);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "stops the connector when the link is unlinked, and removes the file of the token",
    async () => {
      const fake = fakeCloudflared();
      fake.plan([{ ready: true }]);
      const linked = await boot("connector-unlink", {
        MARFA_CLOUDFLARED: fake.path,
      });
      await linked.link();
      const [start] = await fake.waitForStarts(1);
      await linked.connector("connected");
      expect(isRunning(start!.pid)).toBe(true);
      expect(existsSync(start!.tokenFile!.path)).toBe(true);
      const unlinked = await linked.call("DELETE", "/cloud/link");
      expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
      await gone(start!.pid);
      expect(existsSync(start!.tokenFile!.path)).toBe(false);
      expect((await linked.status()).state).toBe("not_linked");
      expect(fake.starts()).toHaveLength(1);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "stops the connector when Marfa Cloud ends the link",
    async () => {
      const fake = fakeCloudflared();
      fake.plan([{ ready: true }]);
      const linked = await boot("connector-ended", {
        MARFA_CLOUDFLARED: fake.path,
      });
      await linked.link();
      const [start] = await fake.waitForStarts(1);
      await linked.connector("connected");
      linked.cloud.forget();
      await linked.server.advanceClock(16 * 60 * 1000);
      const ended = await linked.until(
        "the link to be ended",
        (s) => s.state === "not_linked",
      );
      expect(ended.ended).toMatchObject({ reason: "unlinked_by_service" });
      await gone(start!.pid);
      expect(existsSync(start!.tokenFile!.path)).toBe(false);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "stops the connector when the server stops",
    async () => {
      const fake = fakeCloudflared();
      fake.plan([{ ready: true }]);
      const linked = await boot("connector-shutdown", {
        MARFA_CLOUDFLARED: fake.path,
      });
      await linked.link();
      const [start] = await fake.waitForStarts(1);
      await linked.connector("connected");
      linked.server.signal("SIGTERM");
      await linked.server.exit();
      await gone(start!.pid);
      expect(existsSync(start!.tokenFile!.path)).toBe(false);
      expect(fake.starts()).toHaveLength(1);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("what the connector reports", () => {
  it(
    "reports the connector as starting, connected and reconnecting as it says it is ready, and tells the stream",
    async ({ signal }) => {
      const fake = fakeCloudflared();
      fake.plan([{}]);
      const linked = await boot("connector-state", {
        MARFA_CLOUDFLARED: fake.path,
      });
      const minted = await controlRequest(
        linked.server.controlSocket,
        "/keys",
        {
          method: "POST",
          body: {
            label: "connector state",
            source: `connector-${randomUUID()}`,
            permissions: ["config.manage"],
            type_permissions: { "core.note": "read" },
          },
        },
      );
      expect(minted.status, JSON.stringify(minted.body)).toBe(201);
      const reader = minted.body.key as string;
      const writer = linked.server.workingKey;
      const states = (events: SseEvent[]) =>
        events
          .filter((event) => event.event === "cloud_link.changed")
          .map((event) => (event.data as any).cloud_link)
          .filter((link) => link.state === "linked")
          .map((link) => link.connector.state as string)
          .filter((state, n, all) => state !== all[n - 1]);
      await withStreamAtCursor(
        linked.server.apiUrl,
        reader,
        { signal },
        async (held) => {
          await linked.link();
          // Not ready: the connector runs, and says it is not ready yet.
          const waiting = await linked.connector("starting");
          expect(waiting.connector.since).toEqual(expect.any(String));
          fake.ready(true);
          const up = await linked.connector("connected");
          expect(up.connector.reason).toBeUndefined();
          fake.ready(false);
          await linked.connector("reconnecting");
          fake.ready(true);
          await linked.connector("connected");
          const note = await fetch(`${linked.server.apiUrl}/items`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${writer}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              type: "core.note",
              properties: { title: `sentinel ${randomUUID()}` },
            }),
          });
          expect(note.status).toBe(201);
          const last = ((await note.json()) as { item: { id: string } }).item
            .id;
          const seen = await collectUntil(
            held,
            (events) =>
              events.some(
                (event) =>
                  event.event === "item.created" &&
                  (event.data as { item?: { id?: string } }).item?.id === last,
              ),
            "the sentinel note",
            signal,
          );
          // The connector never read as failed: "no ingress rules" is not a fault.
          expect(states(seen.events).slice(-4)).toEqual([
            "starting",
            "connected",
            "reconnecting",
            "connected",
          ]);
          expect(states(seen.events)).not.toContain("failed");
        },
      );
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("a refused tunnel token", () => {
  it(
    "asks for the current tunnel token when the connector is refused, and runs it with the new one",
    async () => {
      const fake = fakeCloudflared();
      fake.plan([{ ready: true }]);
      const linked = await boot("connector-rotation", {
        MARFA_CLOUDFLARED: fake.path,
      });
      await linked.link();
      const old = tokenOf(linked);
      await linked.connector("connected");
      const credential = linked.cloud.latest().credentials.at(-1)!;
      const fresh = linked.cloud.rotateToken();
      expect(fresh).not.toBe(old);
      fake.refuseNow([old]);
      const starts = await fake.waitForStarts(2);
      expect(starts[0]!.tokenFile!.text).toBe(old);
      expect(starts[1]!.tokenFile!.text).toBe(fresh);
      const asked = linked.cloud.requests.filter(
        (each) => each.path === "/link/token",
      );
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({
        method: "POST",
        authorization: `Bearer ${credential}`,
      });
      await gone(starts[0]!.pid);
      await linked.connector("connected");
      // The new token is the one kept: a restart runs the connector with it.
      await linked.server.restart();
      const again = await fake.waitForStarts(3);
      expect(again[2]!.tokenFile!.text).toBe(fresh);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "asks for the current tunnel token when the edge has no tunnel for the connector's token",
    async () => {
      const fake = fakeCloudflared();
      fake.plan([{ ready: true, refusal: "Failed to get tunnel" }]);
      const linked = await boot("connector-no-tunnel", {
        MARFA_CLOUDFLARED: fake.path,
      });
      await linked.link();
      const old = tokenOf(linked);
      await linked.connector("connected");
      const fresh = linked.cloud.rotateToken();
      fake.refuseNow([old]);
      const starts = await fake.waitForStarts(2);
      expect(starts[1]!.tokenFile!.text).toBe(fresh);
      expect(
        linked.cloud.requests.filter((each) => each.path === "/link/token"),
      ).toHaveLength(1);
      await gone(starts[0]!.pid);
      await linked.connector("connected");
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "reports a connector refused for the token Marfa Cloud still gives as failed, and asks again no faster than it restarts",
    async () => {
      const fake = fakeCloudflared();
      fake.plan([{ ready: true }]);
      // One read of the token a second, so the restart rule is what sets the pace.
      const linked = await boot(
        "connector-refused-same",
        { MARFA_CLOUDFLARED: fake.path },
        { tokenIntervalMs: 1000 },
      );
      await linked.link();
      await linked.connector("connected");
      fake.refuseNow([tokenOf(linked)]);
      const failed = await linked.until(
        "the connector to be failed and refused",
        (s) =>
          s.state === "linked" &&
          s.connector.state === "failed" &&
          s.connector.reason === "refused",
      );
      expect(failed.connector.since).toEqual(expect.any(String));
      await linked.cloud.waitFor("/link/token", 3);
      const at = linked.cloud.requests
        .filter((each) => each.path === "/link/token")
        .map((each) => each.at);
      expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(950);
      expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(1950);
      expect((await linked.status()).state).toBe("linked");
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "ends the link when Marfa Cloud no longer accepts the credential that asks for a new tunnel token",
    async () => {
      const fake = fakeCloudflared();
      fake.plan([{ ready: true }]);
      const linked = await boot("connector-token-gone", {
        MARFA_CLOUDFLARED: fake.path,
      });
      await linked.link();
      const [start] = await fake.waitForStarts(1);
      await linked.connector("connected");
      const old = tokenOf(linked);
      linked.cloud.forget();
      fake.refuseNow([old]);
      const ended = await linked.until(
        "the link to be ended",
        (s) => s.state === "not_linked",
      );
      expect(ended.ended).toMatchObject({ reason: "unlinked_by_service" });
      await gone(start!.pid);
      expect(fake.starts()).toHaveLength(1);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps the link when the answer to the request for a new tunnel token is a 401 that is not Marfa Cloud's own",
    async () => {
      const fake = fakeCloudflared();
      fake.plan([{ ready: true }]);
      const linked = await boot(
        "connector-token-proxy",
        { MARFA_CLOUDFLARED: fake.path },
        { tokenIntervalMs: 1000 },
      );
      await linked.link();
      await linked.connector("connected");
      const old = tokenOf(linked);
      const fresh = linked.cloud.rotateToken();
      // A proxy on the way refuses the request, as it would any other.
      linked.cloud.answerNextUse(401, "proxy_auth_required");
      fake.refuseNow([old]);
      await linked.cloud.waitFor("/link/token", 1);
      const failed = await linked.connector("failed");
      expect(failed.connector.reason).toBe("refused");
      expect(failed.state).toBe("linked");
      // The witness: the next answer is Marfa Cloud's own, and the link goes on with it.
      await linked.connector("connected");
      expect(fake.starts().at(-1)!.tokenFile!.text).toBe(fresh);
      expect((await linked.status()).state).toBe("linked");
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("when Marfa Cloud limits the request for a tunnel token", () => {
  it(
    "keeps a refused connector stopped until Retry-After is over, then asks once and runs the token it gets",
    async () => {
      const fake = fakeCloudflared();
      fake.plan([{ ready: true }]);
      const linked = await boot(
        "connector-token-wait",
        { MARFA_CLOUDFLARED: fake.path },
        { tokenIntervalMs: 4000 },
      );
      await linked.link();
      await linked.connector("connected");
      const old = tokenOf(linked);
      const credential = linked.cloud.latest().credentials.at(-1)!;
      // Another read of the link's token, just now, so the server's is limited.
      const read = await fetch(`${linked.cloud.url}/link/token`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(read.status).toBe(200);
      const fresh = linked.cloud.rotateToken();
      fake.refuseNow([old]);
      await linked.cloud.waitFor("/link/token", 2);
      const [, limited] = linked.cloud.requests.filter(
        (each) => each.path === "/link/token",
      );
      const failed = await linked.connector("failed");
      expect(failed.connector.reason).toBe("refused");
      // Stopped: neither another start nor another request until the wait is over.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(fake.starts()).toHaveLength(1);
      expect(
        linked.cloud.requests.filter((each) => each.path === "/link/token"),
      ).toHaveLength(2);
      const starts = await fake.waitForStarts(2);
      const asked = linked.cloud.requests.filter(
        (each) => each.path === "/link/token",
      );
      expect(asked).toHaveLength(3);
      expect(asked[2]!.at - limited!.at).toBeGreaterThanOrEqual(2900);
      expect(starts[1]!.tokenFile!.text).toBe(fresh);
      await linked.connector("connected");
      expect(
        linked.cloud.requests.filter((each) => each.path === "/link/token"),
      ).toHaveLength(3);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps a refused connector stopped for the 60 seconds Marfa Cloud asks for when it cannot answer",
    async () => {
      const fake = fakeCloudflared();
      fake.plan([{ ready: true }]);
      const linked = await boot("connector-token-unavailable", {
        MARFA_CLOUDFLARED: fake.path,
      });
      await linked.link();
      await linked.connector("connected");
      linked.cloud.failNextTokenRead();
      fake.refuseNow([tokenOf(linked)]);
      await linked.cloud.waitFor("/link/token", 1);
      const failed = await linked.connector("failed");
      expect(failed.connector.reason).toBe("refused");
      // Past the restart rule's first waits, nothing has run or asked.
      await new Promise((resolve) => setTimeout(resolve, 5000));
      expect(fake.starts()).toHaveLength(1);
      expect(
        linked.cloud.requests.filter((each) => each.path === "/link/token"),
      ).toHaveLength(1);
      expect((await linked.status()).state).toBe("linked");
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

type Headers = Record<string, string | string[]>;

/** A write with the headers given, as the audit log recorded its caller. */
async function seenAs(
  server: FreshServer,
  headers: Headers,
): Promise<string | null> {
  const url = new URL(server.apiUrl);
  const body = JSON.stringify({
    type: "core.note",
    properties: { body: randomUUID() },
  });
  const created = await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      const sent = request(
        {
          host: url.hostname,
          port: url.port,
          path: "/items",
          method: "POST",
          headers: {
            ...headers,
            Authorization: `Bearer ${server.workingKey}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (answer) => {
          const chunks: Buffer[] = [];
          answer.on("data", (chunk: Buffer) => chunks.push(chunk));
          answer.on("end", () =>
            resolve({
              status: answer.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      sent.on("error", reject);
      sent.end(body);
    },
  );
  expect(created.status, created.body).toBe(201);
  const id = (JSON.parse(created.body) as { item: { id: string } }).item.id;
  const audit = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
  const page = await audit.listAudit({
    action: "item.create",
    resource_id: id,
  });
  expect(page.status, JSON.stringify(page.error)).toBe(200);
  expect(page.data.data).toHaveLength(1);
  return page.data.data[0]?.client_ip ?? null;
}

const PEER = "127.0.0.1";
const TUNNEL = { "CF-Connecting-IP": "203.0.113.9" };

/** Waits until a request through the tunnel is read as the address it carries. */
function believed(server: FreshServer): Promise<true> {
  return waitFor(
    "the tunnel's header to be believed",
    async () =>
      (await seenAs(server, TUNNEL)) === "203.0.113.9" ? true : undefined,
    10_000,
    100,
  );
}

describe("the caller's address through the tunnel", () => {
  it(
    "believes CF-Connecting-IP from loopback only while a link is linked",
    async () => {
      const fake = fakeCloudflared();
      fake.plan([{ ready: true }]);
      const linked = await boot("connector-address", {
        MARFA_CLOUDFLARED: fake.path,
      });
      // Not linked: the header is any caller's to write.
      expect(await seenAs(linked.server, TUNNEL)).toBe(PEER);
      await linked.link();
      // The witness: linked, the same request is read as the caller it names.
      await believed(linked.server);
      expect(await seenAs(linked.server, {})).toBe(PEER);
      // The connector writes one address, so a list did not come from it.
      expect(
        await seenAs(linked.server, {
          "CF-Connecting-IP": "203.0.113.9, 198.51.100.1",
        }),
      ).toBe(PEER);
      const unlinked = await linked.call("DELETE", "/cloud/link");
      expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
      expect(await seenAs(linked.server, TUNNEL)).toBe(PEER);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps the trusted proxy settings an owner gave over the link's",
    async () => {
      const fake = fakeCloudflared();
      fake.plan([{ ready: true }]);
      const linked = await boot("connector-address-configured", {
        MARFA_CLOUDFLARED: fake.path,
        MARFA_TRUSTED_PROXY_HEADER: "x-client",
        MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
      });
      const named = { "x-client": "203.0.113.5" };
      expect(await seenAs(linked.server, named)).toBe("203.0.113.5");
      await linked.link();
      await linked.connector("connected");
      expect(await seenAs(linked.server, named)).toBe("203.0.113.5");
      expect(await seenAs(linked.server, TUNNEL)).toBe(PEER);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "counts tunnel callers by their own address while a trusted proxy setting names another route",
    async () => {
      const fake = fakeCloudflared();
      fake.plan([{ ready: true }]);
      const linked = await boot("connector-address-other-route", {
        MARFA_CLOUDFLARED: fake.path,
        MARFA_TRUSTED_PROXY_HEADER: "x-client",
        MARFA_TRUSTED_PROXY_CIDRS: "192.0.2.0/24",
      });
      const named = { "x-client": "203.0.113.5" };
      // Not linked: nothing believes a header from loopback.
      expect(await seenAs(linked.server, TUNNEL)).toBe(PEER);
      await linked.link();
      // The witness: linked, the tunnel's header is believed from loopback.
      await believed(linked.server);
      // The configured header is still not believed from a peer outside its ranges.
      expect(await seenAs(linked.server, named)).toBe(PEER);
      expect(await seenAs(linked.server, {})).toBe(PEER);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps reading the tunnel's header until the connector has stopped when the link ends",
    async () => {
      const fake = fakeCloudflared();
      const linked = await boot("connector-address-ending", {
        MARFA_CLOUDFLARED: fake.path,
      });
      // The connector's last request, sent as it is asked to stop.
      fake.plan([
        {
          ready: true,
          onTerminate: {
            url: `${linked.server.apiUrl}/items`,
            headers: {
              ...TUNNEL,
              Authorization: `Bearer ${linked.server.workingKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              type: "core.note",
              properties: { body: randomUUID() },
            }),
          },
        },
      ]);
      await linked.link();
      const [start] = await fake.waitForStarts(1);
      await linked.connector("connected");
      const unlinked = await linked.call("DELETE", "/cloud/link");
      expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
      await gone(start!.pid);
      const audit = new MarfaClient({
        baseUrl: linked.server.apiUrl,
        apiKey: linked.server.managementKey,
      });
      const page = await audit.listAudit({ action: "item.create" });
      expect(page.status, JSON.stringify(page.error)).toBe(200);
      expect(page.data.data.map((entry) => entry.client_ip)).toEqual([
        "203.0.113.9",
      ]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "counts a stranger's wrong passwords through the tunnel against the stranger's address, not loopback",
    async () => {
      const fake = fakeCloudflared();
      fake.plan([{ ready: true }]);
      const linked = await boot("connector-address-limits", {
        MARFA_CLOUDFLARED: fake.path,
        MARFA_RATE_LIMIT_ENABLED: "true",
      });
      const origin = await issuerOrigin(linked.server);
      const signIn = (username: string, password: string, address?: string) =>
        fetch(`${linked.server.apiUrl}/auth/sign-in`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin,
            ...(address === undefined ? {} : { "CF-Connecting-IP": address }),
          },
          body: JSON.stringify({ username, password }),
        });
      await linked.link();
      await believed(linked.server);
      // The stranger guesses until the limit refuses them.
      let refused = false;
      for (let n = 0; n < 80 && !refused; n++) {
        const answer = await signIn(
          `stranger-${String(n)}`,
          "wrong",
          "198.51.100.50",
        );
        refused = answer.status === 429;
        await answer.body?.cancel();
      }
      expect(refused).toBe(true);
      // The witness: the stranger's own address is refused now.
      const stranger = await signIn(
        TEST_OWNER.username,
        TEST_OWNER.password,
        "198.51.100.50",
      );
      expect(stranger.status).toBe(429);
      await stranger.body?.cancel();
      // The owner, from another address through the tunnel, and from loopback itself, is not.
      for (const address of ["198.51.100.51", undefined]) {
        const owner = await signIn(
          TEST_OWNER.username,
          TEST_OWNER.password,
          address,
        );
        expect(owner.status, String(address)).toBe(200);
        await owner.body?.cancel();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
