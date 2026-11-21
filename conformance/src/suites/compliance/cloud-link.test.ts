import { spawn } from "node:child_process";
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
      expect(Date.parse(started.linking.expires_at)).toBe(link.expiresAt);
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
          MARFA_CONTROL_ONLY: "true",
          MARFA_CONTROL_SOCKET: socket,
          MARFA_DATABASE_PATH: join(root, "marfa.db"),
          MARFA_BLOB_PATH: join(root, "blobs"),
          MARFA_ENRICHMENT_ENABLED: "false",
          MARFA_ENRICHMENT_OCR_ENABLED: "false",
          MARFA_CLOUD_URL: cloud.url,
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
      const refused = await controlRequest(socket, "/cloud/link", {
        method: "POST",
        body: { sign_in_address: "keep" },
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect((refused.body as any).error.code).toBe("no_public_listener");
      // The witness: the same socket reads the link.
      const read = await controlRequest(socket, "/cloud/link");
      expect(read.status).toBe(200);
      expect(cloud.requests).toEqual([]);
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
    "lets a link expire at its time though Marfa Cloud cannot be reached",
    async () => {
      const linkable = await boot("cloud-expires", { lifetimeMs: 600_000 });
      await start(linkable, "key", { sign_in_address: "keep" });
      linkable.cloud.down();
      // The witness: the link is linking until its time passes.
      expect((await linkable.status()).state).toBe("linking");
      await linkable.server.advanceClock(601_000);
      const failed = await linkable.until(
        "the link to expire",
        (s) => s.state === "failed",
      );
      expect(failed.failure.reason).toBe("expired");
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
});

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
      expect(await linkable.status()).toEqual({ state: "not_linked" });
      linkable.cloud.up();
      await linkable.cloud.waitFor("/link/unlink", 1, 60_000);
      expect(linkable.cloud.latest().unlinked).toBe(true);
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
    "cancels a link waiting for approval, and unlinks it if Marfa Cloud approves it later",
    async () => {
      const linkable = await boot("cloud-cancel");
      await start(linkable, "key", { sign_in_address: "keep" });
      const cancelled = await linkable.call("key", "DELETE", "/cloud/link");
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
      expect(cancelled.body.state).toBe("not_linked");
      linkable.cloud.approve();
      await linkable.cloud.waitFor("/link/unlink", 1, 60_000);
      const link = linkable.cloud.latest();
      expect(link.unlinked).toBe(true);
      expect(await linkable.status()).toEqual({ state: "not_linked" });
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
