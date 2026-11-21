import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { serverProgram } from "../../../scripts/marfa-server.js";
import { listEntries } from "../../utils/archive.js";
import { controlRequest } from "../../utils/control-request.js";
import { fakeCloud, type FakeCloud } from "../../utils/fake-cloud.js";
import {
  bootFreshServer,
  bootRefused,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { everythingClient } from "../../utils/own-blob-server.js";
import { signIn } from "../../utils/signed-in.js";
import type { SseEvent } from "../../utils/sse.js";
import { collectUntil, withStreamAtCursor } from "../../utils/stream.js";
import { tempFolder } from "../../utils/temp-folder.js";
import { waitFor } from "../../utils/wait.js";

/**
 * Linking an instance to Marfa Cloud (the cloud chapter), against a fake of
 * Marfa Cloud's link API on loopback.
 *
 * **On a server of each test's own.** An instance holds one link, and a
 * link moves the sign-in address and ends the sessions of the server it is
 * on, so every test boots a server and a fake Cloud of its own.
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

/** A credential: the management key, the private socket, or a key's text. */
type Authority = "key" | "socket" | { key: string };

interface Linkable {
  server: FreshServer;
  cloud: FakeCloud;
  call(
    authority: Authority,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Answer>;
  status(): Promise<any>;
  /** Waits until the link reads as `wanted` says. */
  until(what: string, wanted: (status: any) => boolean): Promise<any>;
}

async function boot(
  label: string,
  options: { interval?: number; lifetimeMs?: number } = {},
): Promise<Linkable> {
  const cloud = await fakeCloud(options);
  clouds.push(cloud);
  const server = await bootFreshServer(label, { MARFA_CLOUD_URL: cloud.url });
  cleanups.push(() => server.stop());
  const call = async (
    authority: Authority,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Answer> => {
    if (authority === "socket") {
      return controlRequest(server.controlSocket, path, { method, body });
    }
    const key = authority === "key" ? server.managementKey : authority.key;
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${server.apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const status = async () => {
    const read = await call("key", "GET", "/cloud/link");
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    return read.body;
  };
  return {
    server,
    cloud,
    call,
    status,
    until: (what, wanted) =>
      waitFor(
        what,
        async () => {
          const read = await status();
          return wanted(read) ? read : undefined;
        },
        30_000,
        200,
      ),
  };
}

async function mint(
  linkable: Linkable,
  body: Record<string, unknown>,
): Promise<string> {
  const answer = await linkable.call("socket", "POST", "/keys", {
    label: "cloud link",
    source: `cloud-link-${randomUUID()}`,
    ...body,
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body.key as string;
}

async function start(
  linkable: Linkable,
  authority: Authority,
  body: unknown,
): Promise<any> {
  const answer = await linkable.call(authority, "POST", "/cloud/link", body);
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body;
}

/** A link started to keep the sign-in address, approved and linked. */
async function linkedKeeping(linkable: Linkable): Promise<any> {
  await start(linkable, "key", { sign_in_address: "keep" });
  linkable.cloud.approve();
  return linkable.until("the link to be linked", (s) => s.state === "linked");
}

async function signInAddress(linkable: Linkable): Promise<string | undefined> {
  const read = await linkable.call("key", "GET", "/config");
  expect(read.status).toBe(200);
  return read.body.sign_in_address;
}

async function audited(linkable: Linkable, action: string): Promise<any[]> {
  const read = await linkable.call(
    "socket",
    "GET",
    `/audit?action=${encodeURIComponent(action)}`,
  );
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return read.body.data;
}

/** A server started straight from its program, reached through its private socket. */
async function bootBare(env: Record<string, string>): Promise<{
  cloud: FakeCloud;
  socket: string;
  output: () => string;
}> {
  const cloud = await fakeCloud();
  clouds.push(cloud);
  // Short names: a socket path is bounded at about 100 bytes.
  const root = tempFolder("cl-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const socket = join(root, "c.sock");
  const child = spawn(serverProgram(), [], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MARFA_AUTH_SECRET: randomBytes(32).toString("hex"),
      MARFA_CONTROL_SOCKET: socket,
      MARFA_DATABASE_PATH: join(root, "marfa.db"),
      MARFA_BLOB_PATH: join(root, "blobs"),
      MARFA_ENRICHMENT_ENABLED: "false",
      MARFA_ENRICHMENT_OCR_ENABLED: "false",
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
  return { cloud, socket, output: () => output };
}

const polls = (cloud: FakeCloud) =>
  cloud.requests.filter((request) => request.path === "/link/poll");

describe("who may link", () => {
  it(
    "refuses each door to a key that does not hold config.manage",
    async () => {
      const linkable = await boot("cloud-permission");
      const reader = await mint(linkable, { permissions: ["instance.read"] });
      for (const [method, body] of [
        ["POST", { sign_in_address: "keep" }],
        ["GET", undefined],
        ["DELETE", undefined],
      ] as const) {
        const answer = await linkable.call(
          { key: reader },
          method,
          "/cloud/link",
          body,
        );
        expect(answer.status, method).toBe(403);
        expect(answer.body.error.code, method).toBe("forbidden");
      }
      // The witness: a key holding config.manage reads the link.
      expect((await linkable.status()).state).toBe("not_linked");
      expect(linkable.cloud.requests).toEqual([]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("what the server sends", () => {
  it(
    "sends nothing to Marfa Cloud until a link is started, across a restart, and then sends the start",
    async () => {
      const linkable = await boot("cloud-nothing-sent");
      expect(await linkable.status()).toEqual({ state: "not_linked" });
      await linkable.server.restart();
      expect(await linkable.status()).toEqual({ state: "not_linked" });
      expect(linkable.cloud.requests).toEqual([]);
      // The witness: the same server sends to the same Cloud once asked.
      await start(linkable, "key", { sign_in_address: "keep" });
      expect(linkable.cloud.requests[0]).toMatchObject({
        method: "POST",
        path: "/link/start",
      });
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses to start with a MARFA_CLOUD_URL that is not an origin, or is plain http beyond loopback",
    async () => {
      for (const wrong of [
        "https://cloud.example/link",
        "cloud.example",
        "http://cloud.example",
      ]) {
        const refused = await bootRefused("cloud-url", {
          extraEnv: { MARFA_CLOUD_URL: wrong },
        });
        cleanups.push(() => refused.stop());
        expect(refused.code, wrong).not.toBe(0);
        expect(refused.output, wrong).toContain("MARFA_CLOUD_URL");
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("starting a link", () => {
  it(
    "answers a start with the code and the address to approve it at, and sends the instance's id, name and public port",
    async () => {
      const linkable = await boot("cloud-start");
      const named = await linkable.call("key", "PATCH", "/config", {
        name: "Cloud fixture",
      });
      expect(named.status, JSON.stringify(named.body)).toBe(200);
      const started = await start(linkable, "key", { sign_in_address: "keep" });
      await expectMatchesSchema("POST", "/cloud/link", 201, started);
      const link = linkable.cloud.latest();
      expect(started.state).toBe("linking");
      expect(started.linking).toEqual({
        user_code: link.userCode,
        approval_url: link.approvalUrl,
        expires_at: expect.any(String),
      });
      const root = (await (
        await fetch(`${linkable.server.apiUrl}/`)
      ).json()) as {
        instance_id: string;
      };
      expect(linkable.cloud.requests[0]?.body).toEqual({
        instance_id: root.instance_id,
        instance_name: "Cloud fixture",
        origin_port: Number(new URL(linkable.server.apiUrl).port),
      });
      await expectMatchesSchema(
        "GET",
        "/cloud/link",
        200,
        await linkable.status(),
      );
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "times a link on its own clock from the expires_in Marfa Cloud gave",
    async () => {
      const linkable = await boot("cloud-own-clock", { lifetimeMs: 900_000 });
      // The server's clock runs a day ahead of the fake Cloud's.
      await linkable.server.advanceClock(86_400_000);
      const sent = Date.now() + linkable.server.clockOffsetMs;
      const started = await start(linkable, "key", { sign_in_address: "keep" });
      const answered = Date.now() + linkable.server.clockOffsetMs;
      const expires = Date.parse(started.linking.expires_at);
      expect(expires).toBeGreaterThanOrEqual(sent + 900_000 - 1_000);
      expect(expires).toBeLessThanOrEqual(answered + 900_000 + 1_000);
      expect(linkable.cloud.requests[0]?.path).toBe("/link/start");
      expect((await linkable.status()).linking.expires_at).toBe(
        started.linking.expires_at,
      );
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a second start while a link is linking, and while it is linked",
    async () => {
      const linkable = await boot("cloud-start-exists");
      await start(linkable, "key", { sign_in_address: "keep" });
      const linking = await linkable.call("key", "POST", "/cloud/link", {
        sign_in_address: "keep",
      });
      expect(linking.status).toBe(409);
      expect(linking.body.error.code).toBe("cloud_link_exists");
      linkable.cloud.approve();
      await linkable.until(
        "the link to be linked",
        (s) => s.state === "linked",
      );
      const linked = await linkable.call("key", "POST", "/cloud/link", {
        sign_in_address: "keep",
      });
      expect(linked.status).toBe(409);
      expect(linked.body.error.code).toBe("cloud_link_exists");
      expect(
        linkable.cloud.requests.filter((r) => r.path === "/link/start"),
      ).toHaveLength(1);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "answers 503 cloud_unavailable and keeps no link when Marfa Cloud cannot be reached",
    async () => {
      const linkable = await boot("cloud-start-unavailable");
      linkable.cloud.down();
      const refused = await linkable.call("key", "POST", "/cloud/link", {
        sign_in_address: "keep",
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(503);
      expect(refused.body.error.code).toBe("cloud_unavailable");
      expect(refused.body.error.details.reason).toEqual(expect.any(String));
      expect(await linkable.status()).toEqual({ state: "not_linked" });
      // The witness: the same start goes through once Cloud answers.
      linkable.cloud.up();
      expect(
        (await start(linkable, "key", { sign_in_address: "keep" })).state,
      ).toBe("linking");
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a start where the server has no public listener",
    async () => {
      const bare = await bootBare({ MARFA_CONTROL_ONLY: "true" });
      const refused = await controlRequest(bare.socket, "/cloud/link", {
        method: "POST",
        body: { sign_in_address: "keep" },
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect((refused.body as any).error.code).toBe("no_public_listener");
      // The witness: the same socket reads the link.
      const read = await controlRequest(bare.socket, "/cloud/link");
      expect(read.status).toBe(200);
      expect(bare.cloud.requests).toEqual([]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a start where the public listener is not reached at 127.0.0.1, which Marfa Cloud's connector sends to",
    async () => {
      const bare = await bootBare({
        MARFA_LISTEN_HOST: "::1",
        MARFA_PORT: "0",
      });
      const port = await waitFor(
        "the public listener's port",
        async () => /listening on port (\d+)/.exec(bare.output())?.[1],
      );
      // The witness: the public listener answers, on ::1.
      const health = await fetch(`http://[::1]:${port}/health`);
      await health.body?.cancel();
      expect(health.status).toBe(200);
      const refused = await controlRequest(bare.socket, "/cloud/link", {
        method: "POST",
        body: { sign_in_address: "keep" },
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect((refused.body as any).error.code).toBe("no_public_listener");
      expect(bare.cloud.requests).toEqual([]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a start that moves the sign-in address without confirming it, names the consequences, and sends nothing",
    async () => {
      const linkable = await boot("cloud-start-unconfirmed");
      await signIn(linkable.server, new URL(linkable.server.apiUrl).origin);
      for (const body of [{}, { sign_in_address: "move" }]) {
        const refused = await linkable.call(
          "socket",
          "POST",
          "/cloud/link",
          body,
        );
        expect(refused.status, JSON.stringify(refused.body)).toBe(409);
        expect(refused.body.error.code).toBe(
          "sign_in_address_change_unconfirmed",
        );
        expect(
          refused.body.error.details.consequences.map(
            (consequence: { code: string }) => consequence.code,
          ),
        ).toContain("browser_sessions_end");
      }
      expect(linkable.cloud.requests).toEqual([]);
      expect(await linkable.status()).toEqual({ state: "not_linked" });
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "links on a start by a key, which cannot move the sign-in address, and leaves the move waiting with the next step",
    async () => {
      const linkable = await boot("cloud-start-waiting");
      const before = await signInAddress(linkable);
      const started = await start(linkable, "key", {});
      expect(started.sign_in_address.state).toBe("waiting");
      linkable.cloud.approve();
      const linked = await linkable.until(
        "the link to be linked",
        (s) => s.state === "linked",
      );
      expect(linked.sign_in_address).toMatchObject({
        state: "waiting",
        next_step: {
          request: {
            method: "PATCH",
            path: "/config",
            body: {
              sign_in_address: linked.address,
              confirm_sign_in_address_change: true,
            },
          },
          command: `marfa config set sign_in_address ${String(linked.address)} --confirm-address-change`,
        },
      });
      expect(await signInAddress(linkable)).toBe(before);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("while a link is linking", () => {
  it(
    "asks no sooner than the interval Marfa Cloud gives, and no sooner than a slow_down asks",
    async () => {
      const linkable = await boot("cloud-interval", { interval: 1 });
      await start(linkable, "key", { sign_in_address: "keep" });
      await linkable.cloud.waitFor("/link/poll", 2);
      linkable.cloud.slowDown(3);
      const before = polls(linkable.cloud).length;
      await linkable.cloud.waitFor("/link/poll", before + 3, 60_000);
      const link = linkable.cloud.latest();
      expect(link.tooSoon).toBe(0);
      const slowed = link.slowedAt;
      expect(slowed).not.toBeNull();
      const times = polls(linkable.cloud).map((poll) => poll.at);
      const answered = times.filter((at) => at <= slowed!).at(-1)!;
      const after = times.filter((at) => at >= answered);
      expect(after.length).toBeGreaterThanOrEqual(2);
      for (let index = 1; index < after.length; index += 1) {
        expect(after[index]! - after[index - 1]!).toBeGreaterThanOrEqual(2_750);
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps a poll's answer when the write after it fails, and polls again no sooner than the interval it gave",
    async () => {
      const linkable = await boot("cloud-poll-write-fails", { interval: 1 });
      await start(linkable, "key", { sign_in_address: "keep" });
      await linkable.cloud.waitFor("/link/poll", 1);
      await linkable.server.setFault("fail:commit=cloud.link_poll");
      linkable.cloud.slowDown(5);
      // The witness: the write of the slowed interval failed.
      await waitFor("the write of the interval to fail", async () => {
        const fault = (await linkable.server.faults()).find(
          (each) => each.name === "fail:commit",
        );
        return (fault?.fired ?? 0) >= 1 ? true : undefined;
      });
      const link = linkable.cloud.latest();
      const slowed = link.slowedAt!;
      const before = polls(linkable.cloud).length;
      await linkable.cloud.waitFor("/link/poll", before + 1, 30_000);
      const next = polls(linkable.cloud).find((poll) => poll.at > slowed)!;
      expect(next.at - slowed).toBeGreaterThanOrEqual(4_750);
      expect(link.tooSoon).toBe(0);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "polls again no sooner than the interval when Marfa Cloud refuses the credential just after approving",
    async () => {
      const linkable = await boot("cloud-fresh-refused", { interval: 2 });
      await start(linkable, "key", { sign_in_address: "keep" });
      await linkable.cloud.waitFor("/link/poll", 1);
      linkable.cloud.answerNextUse(401, "unauthorized");
      linkable.cloud.approve();
      await linkable.until(
        "the link to be linked",
        (s) => s.state === "linked",
      );
      const link = linkable.cloud.latest();
      expect(link.tooSoon).toBe(0);
      expect(link.slowedAt).toBeNull();
      // The witness: the first credential was refused, and a later one used.
      expect(link.credentials.length).toBeGreaterThanOrEqual(2);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps following a link after a write of it fails, and links soon after",
    async () => {
      const linkable = await boot("cloud-write-fails");
      await start(linkable, "key", { sign_in_address: "keep" });
      await linkable.server.setFault("fail:commit=cloud.linked");
      linkable.cloud.approve();
      await waitFor("the write that links to fail", async () => {
        const fault = (await linkable.server.faults()).find(
          (each) => each.name === "fail:commit",
        );
        return (fault?.fired ?? 0) >= 1 ? true : undefined;
      });
      const linked = await linkable.until(
        "the link to be linked",
        (s) => s.state === "linked",
      );
      expect(linked.name).toEqual(expect.any(String));
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "links once Marfa Cloud approves, with the name and address it gave, and keeps the sign-in address the start keeps",
    async () => {
      const linkable = await boot("cloud-linked");
      const before = await signInAddress(linkable);
      await start(linkable, "key", { sign_in_address: "keep" });
      linkable.cloud.approve({ name: "kept-name" });
      const linked = await linkable.until(
        "the link to be linked",
        (s) => s.state === "linked",
      );
      await expectMatchesSchema("GET", "/cloud/link", 200, linked);
      const link = linkable.cloud.latest();
      expect(linked).toMatchObject({
        state: "linked",
        name: "kept-name",
        address: link.address,
        linked_at: expect.any(String),
        connector: { state: expect.any(String), since: expect.any(String) },
        sign_in_address: { state: "kept" },
      });
      expect(linked).not.toHaveProperty("linking");
      expect(linked).not.toHaveProperty("failure");
      expect(await signInAddress(linkable)).toBe(before);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "uses the credential of the latest approved answer when an earlier one is lost on the way",
    async () => {
      const linkable = await boot("cloud-latest-credential");
      await start(linkable, "key", { sign_in_address: "keep" });
      linkable.cloud.loseNextApproved();
      linkable.cloud.approve();
      await linkable.until(
        "the link to be linked",
        (s) => s.state === "linked",
      );
      const link = linkable.cloud.latest();
      await waitFor("the link credential to be used", async () =>
        link.used ? true : undefined,
      );
      expect(link.credentials.length).toBeGreaterThanOrEqual(2);
      const [lost] = link.credentials;
      const latest = link.credentials.at(-1)!;
      expect(linkable.cloud.answers(lost!)).toBe(401);
      expect(linkable.cloud.answers(latest)).toBe(200);
      const used = linkable.cloud.requests.filter(
        (request) => request.authorization !== null,
      );
      expect(used.length).toBeGreaterThan(0);
      for (const request of used) {
        expect(request.authorization).toBe(`Bearer ${latest}`);
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "fails a link Marfa Cloud denies, lets expire or refuses, and says why",
    async () => {
      const linkable = await boot("cloud-failed");
      const cases: [string, () => void, Record<string, unknown>][] = [
        ["denied", () => linkable.cloud.deny(), { reason: "denied" }],
        ["expired", () => linkable.cloud.expire(), { reason: "expired" }],
        [
          "refused",
          () =>
            linkable.cloud.refuse("This account already links one instance."),
          {
            reason: "refused",
            message: "This account already links one instance.",
          },
        ],
      ];
      for (const [word, decide, failure] of cases) {
        await start(linkable, "key", { sign_in_address: "keep" });
        decide();
        const failed = await linkable.until(
          `the link to fail as ${word}`,
          (s) => s.state === "failed",
        );
        expect(failed.failure, word).toMatchObject(failure);
        expect(failed, word).not.toHaveProperty("linking");
        await expectMatchesSchema("GET", "/cloud/link", 200, failed);
      }
      expect(await audited(linkable, "cloud.link_failed")).toHaveLength(3);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "lets a link expire ten minutes past its time though Marfa Cloud cannot be reached",
    async () => {
      const linkable = await boot("cloud-expires", { lifetimeMs: 600_000 });
      await start(linkable, "key", { sign_in_address: "keep" });
      linkable.cloud.down();
      expect((await linkable.status()).state).toBe("linking");
      // The witness: past its time, a link Marfa Cloud may still approve is linking.
      await linkable.server.advanceClock(601_000);
      expect((await linkable.status()).state).toBe("linking");
      await linkable.server.advanceClock(600_000);
      const failed = await linkable.until(
        "the link to expire",
        (s) => s.state === "failed",
      );
      expect(failed.failure.reason).toBe("expired");
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps asking past a link's time while Marfa Cloud answers pending, and links on the late approval",
    async () => {
      const linkable = await boot("cloud-late", { lifetimeMs: 600_000 });
      await start(linkable, "key", { sign_in_address: "keep" });
      linkable.cloud.approve({ name: "late", ready: false });
      await linkable.server.advanceClock(601_000);
      const before = polls(linkable.cloud).length;
      await linkable.cloud.waitFor("/link/poll", before + 1);
      expect((await linkable.status()).state).toBe("linking");
      linkable.cloud.ready();
      const linked = await linkable.until(
        "the late link to be linked",
        (s) => s.state === "linked",
      );
      expect(linked.name).toBe("late");
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "asks about a link again after a restart while it is linking, and stays linked after a restart while it is linked",
    async () => {
      const linkable = await boot("cloud-restart");
      await start(linkable, "key", { sign_in_address: "keep" });
      await linkable.server.restart();
      const before = polls(linkable.cloud).length;
      await linkable.cloud.waitFor("/link/poll", before + 1);
      linkable.cloud.approve({ name: "restarted" });
      const linked = await linkable.until(
        "the link to be linked",
        (s) => s.state === "linked",
      );
      await linkable.server.restart();
      expect(await linkable.status()).toMatchObject({
        state: "linked",
        name: "restarted",
        address: linked.address,
      });
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "reports a link whose secrets no longer open as failed and unreadable",
    async () => {
      const linkable = await boot("cloud-unreadable");
      await linkedKeeping(linkable);
      const key = join(
        dirname(linkable.server.sqlitePath),
        "marfa.settings.key",
      );
      await linkable.server.restart(() => rmSync(key));
      const read = await linkable.status();
      expect(read.state).toBe("failed");
      expect(read.failure.reason).toBe("unreadable");
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("the secrets of a link", () => {
  it(
    "puts no secret of a link in an answer, an event, the audit log or an archive",
    async ({ signal }) => {
      const linkable = await boot("cloud-secrets");
      const reader = await mint(linkable, {
        permissions: ["config.manage"],
        type_permissions: { "core.note": "read" },
      });
      const answers: unknown[] = [];
      const raw = await withStreamAtCursor(
        linkable.server.apiUrl,
        reader,
        { signal },
        async (stream) => {
          answers.push(
            await start(linkable, "key", { sign_in_address: "keep" }),
          );
          linkable.cloud.approve({ name: "secret-keeper" });
          answers.push(
            await linkable.until(
              "the link to be linked",
              (s) => s.state === "linked",
            ),
          );
          const seen = await collectUntil(
            stream,
            (events) =>
              events.some(
                (event) =>
                  event.event === "cloud_link.changed" &&
                  (event.data as any).cloud_link?.state === "linked",
              ),
            "the link's change to linked",
            signal,
          );
          return seen.raw;
        },
      );
      const link = linkable.cloud.latest();
      // The witnesses: the server was given each secret, and used two of them.
      await waitFor("the link credential to be used", async () =>
        link.used ? true : undefined,
      );
      expect(
        linkable.cloud.requests.some(
          (request) => request.body?.poll_secret === link.pollSecret,
        ),
      ).toBe(true);
      expect(link.tunnelToken.length).toBeGreaterThan(0);
      const secrets = [link.pollSecret, link.tunnelToken, ...link.credentials];
      const audit = await linkable.call("socket", "GET", "/audit?limit=200");
      expect(audit.status).toBe(200);
      const archive = await (
        await everythingClient(linkable.server)
      ).exportArchive();
      expect(archive.status).toBe(200);
      const entries = listEntries(archive.data).map((entry) => [
        entry.name,
        entry.body.toString("utf8"),
      ]);
      expect(entries.length).toBeGreaterThan(0);
      const seen = [
        ["answers", JSON.stringify(answers)],
        ["stream", raw],
        ["audit", JSON.stringify(audit.body)],
        ...entries,
      ];
      for (const [where, text] of seen) {
        for (const secret of secrets) {
          expect(text!.includes(secret), where).toBe(false);
        }
        if (where !== "answers" && where !== "stream" && where !== "audit") {
          expect(text!.includes("secret-keeper"), where).toBe(false);
        }
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

/** A link started by the private socket to move the sign-in address, with a session to end. */
async function movedLink(label: string): Promise<{
  linkable: Linkable;
  before: string | undefined;
  cookie: string;
  linked: any;
}> {
  const linkable = await boot(label);
  const before = await signInAddress(linkable);
  const cookie = await signIn(
    linkable.server,
    new URL(linkable.server.apiUrl).origin,
  );
  const started = await start(linkable, "socket", {
    sign_in_address: "move",
    confirm_sign_in_address_change: true,
  });
  expect(started.sign_in_address.state).toBe("pending");
  // The witness: the session opens until the move.
  expect(await opens(linkable, cookie)).toBe(200);
  linkable.cloud.approve();
  const linked = await linkable.until(
    "the sign-in address to move",
    (s) => s.sign_in_address?.state === "moved",
  );
  return { linkable, before, cookie, linked };
}

async function setSignIn(linkable: Linkable, address: string): Promise<void> {
  const answer = await linkable.call("socket", "PATCH", "/config", {
    sign_in_address: address,
    confirm_sign_in_address_change: true,
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
}

/**
 * A link that finds the sign-in address already at its Cloud address: the
 * sign-in address moves to another address, then to the Cloud address
 * before any link starts, and a link that moves it is approved there.
 */
async function linkedOnCloudFirst(label: string): Promise<{
  linkable: Linkable;
  other: string;
  linked: any;
}> {
  const linkable = await boot(label);
  const gated = await gate(linkable.server.apiUrl);
  cleanups.push(() => gated.close());
  gated.open();
  const cloudAddress = `http://127.0.0.1:${new URL(linkable.server.apiUrl).port}`;
  await setSignIn(linkable, gated.address);
  await setSignIn(linkable, cloudAddress);
  await start(linkable, "socket", {
    sign_in_address: "move",
    confirm_sign_in_address_change: true,
  });
  linkable.cloud.approve({ address: cloudAddress });
  const linked = await linkable.until(
    "the link to be linked on the sign-in address",
    (s) => s.state === "linked" && s.sign_in_address?.state === "moved",
  );
  expect(linked.address).toBe(cloudAddress);
  return { linkable, other: gated.address, linked };
}

/** Waits for the server to notice that Marfa Cloud ended the link. */
async function endedByCloud(linkable: Linkable): Promise<any> {
  linkable.cloud.forget();
  await linkable.server.advanceClock(61 * 60_000);
  return linkable.until(
    "the link to be ended",
    (s) => s.state === "not_linked",
  );
}

async function opens(linkable: Linkable, cookie: string): Promise<number> {
  const answer = await fetch(`${linkable.server.apiUrl}/owner/passkeys`, {
    headers: { cookie },
  });
  await answer.body?.cancel();
  return answer.status;
}

describe("the sign-in address", () => {
  it(
    "moves the sign-in address to the Cloud address once linked, as the start confirmed, and ends the sessions",
    async () => {
      const { linkable, linked, cookie } = await movedLink("cloud-move");
      expect(linked.state).toBe("linked");
      expect(linked.sign_in_address.address).toBe(linked.address);
      expect(await signInAddress(linkable)).toBe(linked.address);
      expect(await opens(linkable, cookie)).toBe(401);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "holds a move pending while the Cloud address does not answer as this instance",
    async () => {
      const linkable = await boot("cloud-move-pending");
      const before = await signInAddress(linkable);
      await start(linkable, "socket", {
        sign_in_address: "move",
        confirm_sign_in_address_change: true,
      });
      linkable.cloud.approve({ address: "http://127.0.0.1:1" });
      const linked = await linkable.until(
        "the link to be linked",
        (s) => s.state === "linked",
      );
      expect(linked.sign_in_address.state).toBe("pending");
      expect(await signInAddress(linkable)).toBe(before);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "lets a confirmed move wait for a person fifteen minutes after approval while the Cloud address does not answer",
    async () => {
      const linkable = await boot("cloud-move-lapses");
      const before = await signInAddress(linkable);
      await start(linkable, "socket", {
        sign_in_address: "move",
        confirm_sign_in_address_change: true,
      });
      linkable.cloud.approve({ address: "http://127.0.0.1:1" });
      await linkable.until(
        "the link to be linked",
        (s) => s.state === "linked",
      );
      // The witness: within fifteen minutes the server still holds the move.
      await linkable.server.advanceClock(14 * 60_000);
      expect((await linkable.status()).sign_in_address.state).toBe("pending");
      await linkable.server.advanceClock(2 * 60_000);
      const lapsed = await linkable.until(
        "the move to wait for a person",
        (s) => s.sign_in_address?.state === "waiting",
      );
      expect(lapsed.sign_in_address.next_step.request.body).toEqual({
        sign_in_address: "http://127.0.0.1:1",
        confirm_sign_in_address_change: true,
      });
      expect(await signInAddress(linkable)).toBe(before);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "does not move the sign-in address once fifteen minutes have passed since approval, though the Cloud address answers while the move is checked",
    async () => {
      const linkable = await boot("cloud-move-lapses-checking");
      const before = await signInAddress(linkable);
      const target = await gate(linkable.server.apiUrl, true);
      cleanups.push(() => target.close());
      await start(linkable, "socket", {
        sign_in_address: "move",
        confirm_sign_in_address_change: true,
      });
      linkable.cloud.approve({ address: target.address });
      await target.asked;
      const checks = linkable.cloud.requests.filter(
        (request) => request.method === "GET" && request.path === "/link",
      ).length;
      await linkable.server.advanceClock(16 * 60_000);
      target.open();
      // Settled by the step after the move's: the check of the linked link.
      await linkable.cloud.waitFor("/link", checks + 1);
      expect(await signInAddress(linkable)).toBe(before);
      const settled = await linkable.until(
        "the move to wait for a person",
        (s) => s.sign_in_address?.state !== "pending",
      );
      expect(settled.sign_in_address.state).toBe("waiting");
      expect(
        await audited(linkable, "cloud.sign_in_address_move"),
      ).toHaveLength(0);
      // The witness: the address answers as this instance, so a person can move to it.
      const moved = await linkable.call("socket", "PATCH", "/config", {
        sign_in_address: target.address,
        confirm_sign_in_address_change: true,
      });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "takes a confirmed move as done where the sign-in address is already the Cloud address, and writes and records nothing for it",
    async () => {
      const { linkable, linked } = await movedLink("cloud-move-already");
      // The witness: a move from another address is recorded.
      const moves = await audited(linkable, "cloud.sign_in_address_move");
      expect(moves).toHaveLength(1);
      const unlinked = await linkable.call(
        "socket",
        "DELETE",
        "/cloud/link?confirm_sign_in_address_change=true",
      );
      expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
      const set = await linkable.call("socket", "PATCH", "/config", {
        sign_in_address: linked.address,
        confirm_sign_in_address_change: true,
      });
      expect(set.status, JSON.stringify(set.body)).toBe(200);
      const recorded = (await audited(linkable, "cloud.sign_in_address_move"))
        .length;
      const configs = (await audited(linkable, "config.update")).length;
      await start(linkable, "socket", {
        sign_in_address: "move",
        confirm_sign_in_address_change: true,
      });
      linkable.cloud.approve({ address: linked.address });
      const again = await linkable.until(
        "the second link to be linked",
        (s) => s.state === "linked",
      );
      expect(again.sign_in_address.state).toBe("moved");
      // Settled by a later step: the check of the linked link.
      const checks = linkable.cloud.requests.filter(
        (request) => request.method === "GET" && request.path === "/link",
      ).length;
      await linkable.server.advanceClock(16 * 60_000);
      await linkable.cloud.waitFor("/link", checks + 1);
      expect(
        await audited(linkable, "cloud.sign_in_address_move"),
      ).toHaveLength(recorded);
      expect(await audited(linkable, "config.update")).toHaveLength(configs);
      expect(await signInAddress(linkable)).toBe(linked.address);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

/**
 * A stand-in for the Cloud address that answers as the server only once
 * opened. Before that it answers 503, or, `held`, holds each request open.
 */
async function gate(
  apiUrl: string,
  held = false,
): Promise<{
  address: string;
  /** Settles when the first request arrives. */
  asked: Promise<void>;
  open(): void;
  close(): Promise<void>;
}> {
  let opened = false;
  let arrived: () => void = () => {};
  const asked = new Promise<void>((resolve) => (arrived = resolve));
  const waiting: (() => void)[] = [];
  const server = createServer((incoming, response) => {
    arrived();
    const answer = () =>
      void fetch(`${apiUrl}${incoming.url ?? "/"}`).then(async (answer) => {
        response
          .writeHead(answer.status, { "content-type": "application/json" })
          .end(await answer.text());
      });
    if (opened) answer();
    else if (held) waiting.push(answer);
    else response.writeHead(503).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bound = server.address();
  if (typeof bound !== "object" || bound === null) {
    throw new Error("the gate did not bind to a port");
  }
  return {
    address: `http://127.0.0.1:${String(bound.port)}`,
    asked,
    open: () => {
      opened = true;
      for (const answer of waiting.splice(0)) answer();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("unlinking", () => {
  it(
    "tells Marfa Cloud as it unlinks, and answers not_linked",
    async () => {
      const linkable = await boot("cloud-unlink");
      await linkedKeeping(linkable);
      const link = linkable.cloud.latest();
      const unlinked = await linkable.call("key", "DELETE", "/cloud/link");
      expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
      expect(unlinked.body).toEqual({
        state: "not_linked",
        service_told: true,
      });
      await expectMatchesSchema("DELETE", "/cloud/link", 200, unlinked.body);
      const told = linkable.cloud.requests.find(
        (request) => request.path === "/link/unlink",
      );
      expect(told?.authorization).toBe(`Bearer ${link.credentials.at(-1)!}`);
      expect(link.unlinked).toBe(true);
      expect(await linkable.status()).toEqual({ state: "not_linked" });
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "unlinks while Marfa Cloud cannot be reached, says it was not told, and tells it once it can be",
    async () => {
      const linkable = await boot("cloud-unlink-untold");
      await linkedKeeping(linkable);
      linkable.cloud.down();
      const unlinked = await linkable.call("key", "DELETE", "/cloud/link");
      expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
      expect(unlinked.body).toEqual({
        state: "not_linked",
        service_told: false,
      });
      expect(await linkable.status()).toEqual({
        state: "not_linked",
        service_told: false,
      });
      linkable.cloud.up();
      await linkable.cloud.waitFor("/link/unlink", 1, 60_000);
      expect(linkable.cloud.latest().unlinked).toBe(true);
      await linkable.until(
        "the unlink to read as told",
        (s) => s.service_told === undefined,
      );
      expect(await linkable.status()).toEqual({ state: "not_linked" });
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps an untold unlink past a day and a restart, and tells Marfa Cloud soon after the start",
    async () => {
      const linkable = await boot("cloud-unlink-kept");
      await linkedKeeping(linkable);
      linkable.cloud.down();
      const unlinked = await linkable.call("key", "DELETE", "/cloud/link");
      expect(unlinked.body.service_told).toBe(false);
      await linkable.server.advanceClock(25 * 60 * 60_000);
      await linkable.server.restart();
      expect(await linkable.status()).toEqual({
        state: "not_linked",
        service_told: false,
      });
      linkable.cloud.up();
      await linkable.cloud.waitFor("/link/unlink", 1, 60_000);
      expect(linkable.cloud.latest().unlinked).toBe(true);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "decides an unlink on the sign-in address its write finds, after a move commits first",
    async () => {
      const linkable = await boot("cloud-unlink-race");
      const before = await signInAddress(linkable);
      const target = await gate(linkable.server.apiUrl);
      cleanups.push(() => target.close());
      await start(linkable, "socket", {
        sign_in_address: "move",
        confirm_sign_in_address_change: true,
      });
      linkable.cloud.approve({ address: target.address });
      await linkable.until(
        "the link to be linked with the move held",
        (s) => s.state === "linked" && s.sign_in_address.state === "pending",
      );
      await linkable.server.setFault("hold:write=cloud.unlink");
      const unlinking = linkable.call("socket", "DELETE", "/cloud/link");
      await linkable.server.waitForHold("hold:write");
      target.open();
      await linkable.until(
        "the sign-in address to move",
        (s) => s.sign_in_address?.state === "moved",
      );
      await linkable.server.clearFault("hold:write");
      const refused = await unlinking;
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.error.code).toBe(
        "sign_in_address_change_unconfirmed",
      );
      expect((await linkable.status()).state).toBe("linked");
      expect(await signInAddress(linkable)).toBe(target.address);
      expect(linkable.cloud.latest().unlinked).toBe(false);
      // The witness: confirmed, the same unlink puts the address back.
      const confirmed = await linkable.call(
        "socket",
        "DELETE",
        "/cloud/link?confirm_sign_in_address_change=true",
      );
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      expect(await signInAddress(linkable)).toBe(before);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "puts back the sign-in address the link moved only with a recent sign-in and confirmation, and otherwise unlinks nothing",
    async () => {
      const { linkable, before, linked } = await movedLink("cloud-put-back");
      const unconfirmed = await linkable.call(
        "socket",
        "DELETE",
        "/cloud/link",
      );
      expect(unconfirmed.status, JSON.stringify(unconfirmed.body)).toBe(409);
      expect(unconfirmed.body.error.code).toBe(
        "sign_in_address_change_unconfirmed",
      );
      expect(Array.isArray(unconfirmed.body.error.details.consequences)).toBe(
        true,
      );
      const byKey = await linkable.call(
        "key",
        "DELETE",
        "/cloud/link?confirm_sign_in_address_change=true",
      );
      expect(byKey.status, JSON.stringify(byKey.body)).toBe(403);
      expect(byKey.body.error.code).toBe("app_sign_in_required");
      expect((await linkable.status()).state).toBe("linked");
      expect(await signInAddress(linkable)).toBe(linked.address);
      expect(linkable.cloud.latest().unlinked).toBe(false);

      const confirmed = await linkable.call(
        "socket",
        "DELETE",
        "/cloud/link?confirm_sign_in_address_change=true",
      );
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      expect(confirmed.body).toEqual({
        state: "not_linked",
        service_told: true,
      });
      expect(await signInAddress(linkable)).toBe(before);
      expect(linkable.cloud.latest().unlinked).toBe(true);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "puts back the sign-in address in force just before the sign-in address last became the Cloud address",
    async () => {
      const { linkable, before, linked } = await movedLink(
        "cloud-put-back-latest",
      );
      const other = await gate(linkable.server.apiUrl);
      cleanups.push(() => other.close());
      other.open();
      const set = async (address: string) => {
        const answer = await linkable.call("socket", "PATCH", "/config", {
          sign_in_address: address,
          confirm_sign_in_address_change: true,
        });
        expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      };
      await set(other.address);
      await set(linked.address);
      // The witness: the address before the first move is another one.
      expect(other.address).not.toBe(before);
      const unlinked = await linkable.call(
        "socket",
        "DELETE",
        "/cloud/link?confirm_sign_in_address_change=true",
      );
      expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
      expect(await signInAddress(linkable)).toBe(other.address);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "puts back an address left in addresses on an unlink where the link found the sign-in address already at its Cloud address",
    async () => {
      const { linkable, other, linked } = await linkedOnCloudFirst(
        "cloud-put-back-found",
      );
      const unlinked = await linkable.call(
        "socket",
        "DELETE",
        "/cloud/link?confirm_sign_in_address_change=true",
      );
      expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
      expect(unlinked.body).toEqual({
        state: "not_linked",
        service_told: true,
      });
      expect(await signInAddress(linkable)).toBe(other);
      const config = await linkable.call("key", "GET", "/config");
      expect(config.body.addresses).toEqual([other]);
      expect(config.body.addresses).not.toContain(linked.address);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "puts back an address left in addresses on an unlink where the owner removed the one in force before the move",
    async () => {
      const linkable = await boot("cloud-put-back-removed");
      const [first, other] = [
        await gate(linkable.server.apiUrl),
        await gate(linkable.server.apiUrl),
      ];
      cleanups.push(
        () => first.close(),
        () => other.close(),
      );
      first.open();
      other.open();
      await setSignIn(linkable, first.address);
      await start(linkable, "socket", {
        sign_in_address: "move",
        confirm_sign_in_address_change: true,
      });
      linkable.cloud.approve();
      const linked = await linkable.until(
        "the sign-in address to move",
        (s) => s.sign_in_address?.state === "moved",
      );
      const listed = await linkable.call("socket", "PATCH", "/config", {
        addresses: [linked.address, other.address],
      });
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      const unlinked = await linkable.call(
        "socket",
        "DELETE",
        "/cloud/link?confirm_sign_in_address_change=true",
      );
      expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
      expect(await signInAddress(linkable)).toBe(other.address);
      const config = await linkable.call("key", "GET", "/config");
      expect(config.body.addresses).toEqual([other.address]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "answers not_linked to an unlink when nothing is linked",
    async () => {
      const linkable = await boot("cloud-unlink-none");
      for (let time = 0; time < 2; time += 1) {
        const unlinked = await linkable.call("key", "DELETE", "/cloud/link");
        expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
        expect(unlinked.body.state).toBe("not_linked");
      }
      expect(linkable.cloud.requests).toEqual([]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "cancels a link waiting for approval on Marfa Cloud",
    async () => {
      const linkable = await boot("cloud-cancel");
      await start(linkable, "key", { sign_in_address: "keep" });
      const link = linkable.cloud.latest();
      const canceled = await linkable.call("key", "DELETE", "/cloud/link");
      expect(canceled.status, JSON.stringify(canceled.body)).toBe(200);
      expect(canceled.body).toEqual({
        state: "not_linked",
        service_told: true,
      });
      await expectMatchesSchema("DELETE", "/cloud/link", 200, canceled.body);
      const sent = linkable.cloud.requests.find(
        (request) => request.path === "/link/cancel",
      );
      expect(sent?.body).toEqual({
        link_id: link.linkId,
        poll_secret: link.pollSecret,
      });
      expect(link.canceled).toBe(true);
      expect(await linkable.status()).toEqual({ state: "not_linked" });
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "watches a link whose cancel Marfa Cloud did not take, and unlinks it if Marfa Cloud approves it later",
    async () => {
      const linkable = await boot("cloud-cancel-fallback", { interval: 2 });
      await start(linkable, "key", { sign_in_address: "keep" });
      linkable.cloud.failCancels();
      const canceled = await linkable.call("key", "DELETE", "/cloud/link");
      expect(canceled.status, JSON.stringify(canceled.body)).toBe(200);
      expect(canceled.body).toEqual({
        state: "not_linked",
        service_told: false,
      });
      const link = linkable.cloud.latest();
      expect(link.canceled).toBe(false);
      expect(await linkable.status()).toEqual({
        state: "not_linked",
        service_told: false,
      });
      linkable.cloud.answerNextUse(401, "unauthorized");
      linkable.cloud.approve();
      await linkable.cloud.waitFor("/link/unlink", 2, 60_000);
      expect(link.unlinked).toBe(true);
      // The witness: the first credential was refused, and the poll after it waited.
      expect(link.credentials.length).toBeGreaterThanOrEqual(2);
      expect(link.tooSoon).toBe(0);
      await linkable.until(
        "the unlink to read as told",
        (s) => s.service_told === undefined,
      );
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("a link ended on Marfa Cloud", () => {
  it(
    "notices a link ended on Marfa Cloud, puts back the sign-in address the link moved, and says why",
    async () => {
      const { linkable, before } = await movedLink("cloud-ended");
      const checks = () =>
        linkable.cloud.requests.filter(
          (request) => request.method === "GET" && request.path === "/link",
        ).length;
      // The witness: the server checks a linked link, and it stays linked.
      const first = checks();
      await linkable.server.advanceClock(61 * 60_000);
      await linkable.cloud.waitFor("/link", first + 1);
      expect((await linkable.status()).state).toBe("linked");

      linkable.cloud.forget();
      await linkable.server.advanceClock(61 * 60_000);
      const ended = await linkable.until(
        "the link to be ended",
        (s) => s.state === "not_linked",
      );
      expect(ended.ended).toMatchObject({ reason: "unlinked_by_service" });
      await expectMatchesSchema("GET", "/cloud/link", 200, ended);
      expect(await signInAddress(linkable)).toBe(before);
      expect(
        (await audited(linkable, "cloud.unlink"))[0]?.details,
      ).toMatchObject({ reason: "unlinked_by_service" });
      expect(
        await audited(linkable, "cloud.sign_in_address_move"),
      ).toHaveLength(2);
      // A new link can start once the last one ended.
      await start(linkable, "key", { sign_in_address: "keep" });
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "puts back an address left in addresses on an end by Marfa Cloud where the link found the sign-in address already at its Cloud address",
    async () => {
      const { linkable, other, linked } =
        await linkedOnCloudFirst("cloud-ended-found");
      const ended = await endedByCloud(linkable);
      expect(ended.ended).toMatchObject({ reason: "unlinked_by_service" });
      expect(ended).not.toHaveProperty("sign_in_address");
      expect(await signInAddress(linkable)).toBe(other);
      const config = await linkable.call("key", "GET", "/config");
      expect(config.body.addresses).toEqual([other]);
      expect(config.body.addresses).not.toContain(linked.address);
      expect(
        (await audited(linkable, "cloud.sign_in_address_move"))[0]?.details,
      ).toMatchObject({ reason: "unlinked_by_service" });
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "puts back the first https address left in addresses on an end by Marfa Cloud where the address in force before the move is not among them",
    async () => {
      const { linkable, linked } = await movedLink("cloud-ended-https");
      const other = await gate(linkable.server.apiUrl);
      cleanups.push(() => other.close());
      const secure = "https://elsewhere.example";
      const listed = await linkable.call("socket", "PATCH", "/config", {
        addresses: [linked.address, other.address, secure],
      });
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      await endedByCloud(linkable);
      expect(await signInAddress(linkable)).toBe(secure);
      const config = await linkable.call("key", "GET", "/config");
      expect(config.body.addresses).toEqual([other.address, secure]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "ends a link Marfa Cloud ended though the sign-in address cannot be put back, keeps the sign-in address, and says how to move it",
    async () => {
      const { linkable, linked } = await movedLink("cloud-ended-stranded");
      const own = `http://localhost:${new URL(linkable.server.apiUrl).port}`;
      await linkable.server.setFault("fail:commit=config.update@always");
      const ended = await endedByCloud(linkable);
      // The witness: the put-back was tried and its write failed each time.
      const fault = (await linkable.server.faults()).find(
        (each) => each.name === "fail:commit",
      );
      expect(fault?.fired ?? 0).toBeGreaterThanOrEqual(3);
      expect(ended.ended).toMatchObject({ reason: "unlinked_by_service" });
      expect(ended.sign_in_address).toMatchObject({
        state: "not_put_back",
        address: linked.address,
        failure: { reason: "internal_error" },
      });
      expect(ended.sign_in_address.next_step).toEqual({
        request: {
          method: "PATCH",
          path: "/config",
          body: { sign_in_address: own, confirm_sign_in_address_change: true },
        },
        command: `marfa config set sign_in_address ${own} --confirm-address-change`,
      });
      await expectMatchesSchema("GET", "/cloud/link", 200, ended);
      expect(await signInAddress(linkable)).toBe(linked.address);
      expect(
        (await audited(linkable, "cloud.unlink"))[0]?.details,
      ).toMatchObject({
        reason: "unlinked_by_service",
        sign_in_address: "not_put_back",
        put_back_failure: "internal_error",
      });
      await linkable.server.clearFault("fail:commit");
      const moved = await linkable.call(
        "socket",
        ended.sign_in_address.next_step.request.method,
        ended.sign_in_address.next_step.request.path,
        ended.sign_in_address.next_step.request.body,
      );
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      const after = await linkable.status();
      expect(after.state).toBe("not_linked");
      expect(after).not.toHaveProperty("sign_in_address");
      await start(linkable, "key", { sign_in_address: "keep" });
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps a link whose check Marfa Cloud answers 401 with a code other than unauthorized",
    async () => {
      const linkable = await boot("cloud-other-401");
      await linkedKeeping(linkable);
      const checks = () =>
        linkable.cloud.requests.filter(
          (request) => request.method === "GET" && request.path === "/link",
        ).length;
      const first = checks();
      linkable.cloud.answerNextUse(401, "token_expired");
      await linkable.server.advanceClock(61 * 60_000);
      // The server tries again soon, which it does only for a link it kept.
      await linkable.cloud.waitFor("/link", first + 2);
      expect((await linkable.status()).state).toBe("linked");
      linkable.cloud.forget();
      await linkable.server.advanceClock(61 * 60_000);
      const ended = await linkable.until(
        "the link to be ended",
        (s) => s.state === "not_linked",
      );
      expect(ended.ended).toMatchObject({ reason: "unlinked_by_service" });
      expect(await audited(linkable, "cloud.unlink")).toHaveLength(1);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "checks a linked link as it starts again, and notices it was ended on Marfa Cloud while it was stopped",
    async () => {
      const linkable = await boot("cloud-ended-restart");
      await linkedKeeping(linkable);
      linkable.cloud.forget();
      await linkable.server.restart();
      const ended = await linkable.until(
        "the link to be ended",
        (s) => s.state === "not_linked",
      );
      expect(ended.ended).toMatchObject({ reason: "unlinked_by_service" });
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("events and the audit log", () => {
  it(
    "announces each change of a link on the stream of a credential holding config.manage, and on no other",
    async ({ signal }) => {
      const linkable = await boot("cloud-events");
      const reader = await mint(linkable, {
        permissions: ["config.manage"],
        type_permissions: { "core.note": "read" },
      });
      const lacking = await mint(linkable, {
        type_permissions: { "core.note": "write" },
      });
      const changes = (events: SseEvent[]) =>
        events.filter((event) => event.event === "cloud_link.changed");
      const created = (events: SseEvent[], id: string) =>
        events.some(
          (event) =>
            event.event === "item.created" &&
            (event.data as { item?: { id?: string } }).item?.id === id,
        );
      await withStreamAtCursor(
        linkable.server.apiUrl,
        reader,
        { signal },
        async (held) =>
          withStreamAtCursor(
            linkable.server.apiUrl,
            lacking,
            { signal },
            async (without) => {
              await start(linkable, "key", { sign_in_address: "keep" });
              linkable.cloud.approve();
              const linked = await linkable.until(
                "the link to be linked",
                (s) => s.state === "linked",
              );
              const note = await linkable.call(
                { key: lacking },
                "POST",
                "/items",
                {
                  type: "core.note",
                  properties: { title: `sentinel ${randomUUID()}` },
                },
              );
              expect(note.status, JSON.stringify(note.body)).toBe(201);
              const last = note.body.item.id as string;
              const seen = await collectUntil(
                held,
                (events) => created(events, last),
                "the sentinel note",
                signal,
              );
              const frames = changes(seen.events);
              expect(
                frames.map((frame) => (frame.data as any).cloud_link.state),
              ).toEqual(["linking", "linked"]);
              expect(frames[1]!.data).toEqual({
                event_type: "cloud_link.changed",
                cloud_link: linked,
              });
              const elsewhere = await collectUntil(
                without,
                (events) => created(events, last),
                "the sentinel note",
                signal,
              );
              expect(changes(elsewhere.events)).toEqual([]);
            },
          ),
      );
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "records the start, the link, the move of the sign-in address and the unlink in the audit log",
    async () => {
      const { linkable } = await movedLink("cloud-audit");
      const unlinked = await linkable.call(
        "socket",
        "DELETE",
        "/cloud/link?confirm_sign_in_address_change=true",
      );
      expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
      for (const action of [
        "cloud.link_start",
        "cloud.linked",
        "cloud.sign_in_address_move",
        "cloud.unlink",
      ]) {
        expect(await audited(linkable, action), action).toHaveLength(1);
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
