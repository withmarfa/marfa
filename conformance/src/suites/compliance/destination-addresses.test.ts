import { randomUUID } from "node:crypto";
import { get, type RequestOptions } from "node:http";
import { describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { beatReceiver } from "../../utils/beat-receiver.js";
import {
  approvedAppToken,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  bytesOf,
  clientsFor,
  PUBLIC_ONLY,
  replicateUntilCaughtUp,
  runJob,
  storeByName,
} from "../../utils/own-blob-server.js";
import { waitFor } from "../../utils/wait.js";
import {
  COLLECTOR_BUDGET_MS,
  COLLECTOR_TEST_TIMEOUT_MS,
  startFaultSinks,
} from "../../utils/fault-sinks.js";

/**
 * While `allow_private_addresses` is off, the heartbeat, the PostHog host
 * and the object store reach only public addresses, as webhooks do, and only
 * an owner, or an app whose owner signed in just now, turns it on. Every receiver here, and the run's
 * object store, listens on loopback; a receiver named `localhost` is a name
 * that leads there, which only a lookup can judge.
 */
const SWITCH = "allow_private_addresses";

function socketOf(server: FreshServer): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    controlSocket: server.controlSocket,
  });
}

async function setFrom(
  client: MarfaClient,
  changes: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const set = await client.patchConfig(changes);
  expect(set.status, JSON.stringify(set.error)).toBe(200);
  return set.data as Record<string, unknown>;
}

function byName(url: string): string {
  const named = new URL(url);
  named.hostname = "localhost";
  return named.toString();
}

/** An address the server judges public, where the resolver fault scripts one. */
const PUBLIC_ADDRESS = "93.184.216.34";

/** `url` asked of loopback under its own host, which no lookup then needs to find. */
function getAtLoopback(url: URL): Promise<{ status: number; body: Buffer }> {
  const lookup: RequestOptions["lookup"] = (_host, options, done) => {
    if (options.all) {
      done(null, [{ address: "127.0.0.1", family: 4 }]);
    } else {
      done(null, "127.0.0.1", 4);
    }
  };
  return new Promise((resolve, reject) => {
    get(url, { lookup }, (answer) => {
      const parts: Buffer[] = [];
      answer.on("data", (part: Buffer) => parts.push(part));
      answer.on("end", () =>
        resolve({ status: answer.statusCode ?? 0, body: Buffer.concat(parts) }),
      );
      answer.on("error", reject);
    }).on("error", reject);
  });
}

describe("where the server may send", () => {
  it(
    "refuses a key holding config.manage the switch, which an app whose owner signed in just now changes",
    async () => {
      const server = await bootFreshServer("switch-authority", PUBLIC_ONLY);
      try {
        const { operator } = clientsFor(server);
        const refused = await operator.patchConfig({ [SWITCH]: true });
        expect(refused.status).toBe(403);
        expect(refused.error?.error.code).toBe("app_sign_in_required");
        const put = await operator.updateConfig({ [SWITCH]: true });
        expect(put.status).toBe(403);
        expect((await operator.getConfig()).data).not.toHaveProperty(SWITCH);

        // The witness: an app whose owner signed in just now changes the same
        // setting, and so does the private local process.
        const app = new MarfaClient({
          baseUrl: server.apiUrl,
          apiKey: await approvedAppToken(server, ["config.manage"]),
        });
        expect((await setFrom(app, { [SWITCH]: true }))[SWITCH]).toBe(true);
        expect((await setFrom(app, { [SWITCH]: false }))[SWITCH]).toBe(false);
        const turned = await setFrom(socketOf(server), { [SWITCH]: true });
        expect(turned[SWITCH]).toBe(true);
        const same = await operator.patchConfig({ [SWITCH]: true });
        expect(same.status, JSON.stringify(same.error)).toBe(200);
        // A private destination stored while the switch is on does not turn
        // the key's refusal into a judgment of the settings.
        await setFrom(socketOf(server), {
          object_store_endpoint: "http://127.0.0.1:9",
        });
        const off = await operator.patchConfig({ [SWITCH]: false });
        expect(off.status).toBe(403);
        expect(off.error?.error.code).toBe("app_sign_in_required");
        expect(
          ((await operator.getConfig()).data as Record<string, unknown>)[
            SWITCH
          ],
        ).toBe(true);
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a heartbeat_url, posthog_host or object_store_endpoint written as a private address while the switch is off",
    async () => {
      const server = await bootFreshServer("switch-literals", PUBLIC_ONLY);
      try {
        const socket = socketOf(server);
        const keys = ["heartbeat_url", "posthog_host", "object_store_endpoint"];
        // The PostHog host is https and set with its token, so the switch is
        // the one rule it can break.
        const scheme = (key: string) =>
          key === "posthog_host" ? "https" : "http";
        const alongside = (key: string, value: unknown) =>
          key === "posthog_host" ? { posthog_project_token: value } : {};
        const hosts = [
          "127.0.0.1:9",
          "[::1]:9",
          "10.1.2.3",
          "169.254.169.254",
          "[::ffff:192.168.0.1]",
        ];
        for (const key of keys) {
          for (const host of hosts) {
            const refused = await socket.patchConfig({
              [key]: `${scheme(key)}://${host}/hush-${key}`,
              ...alongside(key, "phc_fixture"),
            });
            expect(refused.status, `${key} ${host}`).toBe(400);
            const said = JSON.stringify(refused.error);
            expect(said).toContain(key);
            expect(said).toContain(SWITCH);
            expect(said).not.toContain(`hush-${key}`);
          }
          // The witness: the same setting takes a name, which a lookup judges.
          await setFrom(socket, {
            [key]: `${scheme(key)}://receiver.example.test/`,
            ...alongside(key, "phc_fixture"),
          });
          await setFrom(socket, { [key]: null, ...alongside(key, null) });
        }

        await setFrom(socket, {
          [SWITCH]: true,
          object_store_endpoint: "http://127.0.0.1:9",
        });
        const off = await socket.patchConfig({ [SWITCH]: false });
        expect(off.status).toBe(400);
        expect(JSON.stringify(off.error)).toContain("object_store_endpoint");
        const cleared = await setFrom(socket, {
          [SWITCH]: false,
          object_store_endpoint: null,
        });
        expect(cleared[SWITCH]).toBe(false);
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses an OTLP endpoint written as a private address while the switch is off",
    async () => {
      const server = await bootFreshServer("switch-otlp-literals", PUBLIC_ONLY);
      try {
        const socket = socketOf(server);
        const keys = [
          "otel_exporter_otlp_endpoint",
          "otel_exporter_otlp_traces_endpoint",
          "otel_exporter_otlp_logs_endpoint",
        ];
        // A signal's endpoint is set beside the base, so the switch is the one
        // rule it can break.
        const base = (key: string) =>
          key === "otel_exporter_otlp_endpoint"
            ? {}
            : { otel_exporter_otlp_endpoint: "https://collector.example.test" };
        for (const key of keys) {
          for (const host of ["127.0.0.1:4318", "[::1]:4318", "10.1.2.3"]) {
            const refused = await socket.patchConfig({
              ...base(key),
              [key]: `http://${host}/hush-${key}`,
            });
            expect(refused.status, `${key} ${host}`).toBe(400);
            const said = JSON.stringify(refused.error);
            expect(said).toContain(key);
            expect(said).toContain(SWITCH);
            expect(said).not.toContain(`hush-${key}`);
          }
          // The witness: the same setting takes a name, which a lookup judges.
          await setFrom(socket, {
            ...base(key),
            [key]: "http://receiver.example.test:4318/",
          });
          await setFrom(socket, {
            otel_exporter_otlp_endpoint: null,
            otel_exporter_otlp_traces_endpoint: null,
            otel_exporter_otlp_logs_endpoint: null,
          });
        }
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "sends no trace or log record to a name that leads to a private address until the switch is on",
    async () => {
      const sinks = await startFaultSinks();
      const server = await bootFreshServer("switch-otlp", {
        ...PUBLIC_ONLY,
        MARFA_OTEL_SAMPLE_RATIO: "1",
      });
      try {
        const { operator, working } = clientsFor(server);
        const write = async (requestId: string) => {
          const written = await working.rawRequest("/items", {
            method: "POST",
            headers: { "X-Request-ID": requestId },
            body: { type: "core.note", properties: { body: "x" } },
          });
          expect(written.status).toBe(201);
        };
        await setFrom(operator, {
          otel_exporter_otlp_endpoint: byName(
            sinks.serverEnv().MARFA_OTEL_EXPORTER_OTLP_ENDPOINT!,
          ),
        });
        const unsent = `otlp-unsent-${randomUUID()}`;
        await write(unsent);
        await setFrom(socketOf(server), { [SWITCH]: true });
        const sent = `otlp-sent-${randomUUID()}`;
        await write(sent);
        await server.stop();

        // The witness: the write once the switch is on arrives.
        const named = (requestId: string, signal: "traces" | "logs") =>
          sinks.exports.filter(
            (post) =>
              post.signal === signal &&
              JSON.stringify(post.body).includes(`"${requestId}"`),
          );
        for (const signal of ["traces", "logs"] as const) {
          expect(named(sent, signal), signal).not.toEqual([]);
          expect(named(unsent, signal), signal).toEqual([]);
        }
      } finally {
        await server.stop();
        await sinks.close();
      }
    },
    COLLECTOR_TEST_TIMEOUT_MS,
  );

  it(
    "sends no heartbeat to a name that leads to a private address until the switch is on",
    async () => {
      const beats = await beatReceiver();
      const server = await bootFreshServer("switch-heartbeat", PUBLIC_ONLY);
      try {
        const { operator } = clientsFor(server);
        await setFrom(operator, { heartbeat_url: byName(beats.url) });
        const before = beats.count();
        const refused = await runJob<{ ok: boolean }>(operator, "heartbeat");
        expect(refused.result.ok).toBe(false);
        expect(beats.count()).toBe(before);

        // The witness: with the switch on, the same address hears the beat.
        await setFrom(socketOf(server), { [SWITCH]: true });
        const sent = await runJob<{ ok: boolean }>(operator, "heartbeat");
        expect(sent.result.ok).toBe(true);
        expect(beats.count()).toBeGreaterThan(before);
      } finally {
        await server.stop();
        await beats.close();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "sends no exception report to a name that leads to a private address until the switch is on",
    async () => {
      const sinks = await startFaultSinks();
      const server = await bootFreshServer("switch-posthog", PUBLIC_ONLY);
      try {
        const { operator, working } = clientsFor(server);
        const fail = async (requestId: string) => {
          await server.setFault("fail:audit=item.create");
          const failed = await working.rawRequest("/items", {
            method: "POST",
            headers: { "X-Request-ID": requestId },
            body: {
              type: "core.note",
              properties: { body: `fails ${randomUUID()}` },
            },
          });
          await server.clearFault();
          expect(failed.status).toBe(500);
        };
        await setFrom(operator, {
          posthog_host: byName(sinks.env().MARFA_POSTHOG_HOST!),
          posthog_project_token: "phc_fixture",
        });
        const unsent = `posthog-unsent-${randomUUID()}`;
        await fail(unsent);

        // The witness: reports go out in order, so the one sent once the
        // switch is on arrives after the first would have.
        await setFrom(socketOf(server), { [SWITCH]: true });
        const sent = `posthog-sent-${randomUUID()}`;
        await fail(sent);
        await waitFor(
          "the exception sent once the switch is on",
          async () =>
            sinks
              .sentExceptions()
              .find((event) => event.properties.request_id === sent),
          COLLECTOR_BUDGET_MS,
        );
        expect(
          sinks.sentExceptions().map((event) => event.properties.request_id),
        ).toEqual([sent]);
      } finally {
        await server.stop();
        await sinks.close();
      }
    },
    COLLECTOR_TEST_TIMEOUT_MS,
  );

  it(
    "takes an object store on a private address once a write to /config turns the switch on, and not before",
    async () => {
      const endpoint = process.env.MARFA_OBJECT_STORE_ENDPOINT;
      const bucket = process.env.MARFA_OBJECT_STORE_BUCKET;
      if (!endpoint || !bucket) {
        throw new Error(
          "MARFA_OBJECT_STORE_BUCKET and MARFA_OBJECT_STORE_ENDPOINT are required: source the env file `pnpm garage:up` writes.",
        );
      }
      const server = await bootFreshServer("switch-object-store", {
        ...PUBLIC_ONLY,
        MARFA_BACKUP_INTERVAL_SECONDS: "0",
      });
      try {
        const { operator, working } = clientsFor(server);
        const backups = async () => {
          const answer = await operator.rawRequest<{
            backups: Record<string, unknown>;
          }>("/health");
          expect(answer.status, JSON.stringify(answer.data)).toBe(200);
          return answer.data.backups;
        };
        const store = {
          object_store_bucket: bucket,
          object_store_region: process.env.MARFA_OBJECT_STORE_REGION ?? "",
          object_store_access_key_id:
            process.env.MARFA_OBJECT_STORE_ACCESS_KEY_ID ?? "",
          object_store_secret_access_key:
            process.env.MARFA_OBJECT_STORE_SECRET_ACCESS_KEY ?? "",
          object_store_path_style: true,
          object_store_prefix: `fixture-${randomUUID()}`,
        };
        const socket = socketOf(server);
        const literal = await socket.patchConfig({
          ...store,
          object_store_endpoint: endpoint,
        });
        expect(literal.status).toBe(400);
        await setFrom(socket, {
          ...store,
          object_store_endpoint: byName(endpoint),
        });
        const unusable = await waitFor("the store to be unusable", async () => {
          const said = await backups();
          return said.reason === "destination_unusable" ? said : undefined;
        });
        expect(unusable.status).toBe("failing");

        await setFrom(socket, { [SWITCH]: true });
        await waitFor("the object store to be in use", async () => {
          const said = await backups();
          return said.destination === "bucket" &&
            said.reason !== "destination_unusable"
            ? true
            : undefined;
        });
        const upload = await working.uploadBlob(
          bytesOf("kept in a private store", 64),
          "text/plain",
        );
        expect(upload.status, JSON.stringify(upload.error)).toBe(201);
        await replicateUntilCaughtUp(operator, "the file's copy in the store");
        expect(
          (await operator.listBlobCopies(upload.data.hash)).data.data,
        ).toHaveLength(2);
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "reaches an object store by virtual host at the bucket before the endpoint's host, and not while that host leads to a private address",
    async () => {
      const endpoint = process.env.MARFA_OBJECT_STORE_ENDPOINT;
      const bucket = process.env.MARFA_OBJECT_STORE_BUCKET;
      if (!endpoint || !bucket) {
        throw new Error(
          "MARFA_OBJECT_STORE_BUCKET and MARFA_OBJECT_STORE_ENDPOINT are required: source the env file `pnpm garage:up` writes.",
        );
      }
      const server = await bootFreshServer("switch-virtual-host", {
        ...PUBLIC_ONLY,
        MARFA_BACKUP_INTERVAL_SECONDS: "0",
      });
      try {
        const { operator, working } = clientsFor(server);
        const socket = socketOf(server);
        const backups = async () => {
          const answer = await operator.rawRequest<{
            backups: Record<string, unknown>;
          }>("/health");
          expect(answer.status, JSON.stringify(answer.data)).toBe(200);
          return answer.data.backups;
        };
        const named = storeByName(endpoint);
        // The bucket's host is scripted, so the test needs no resolver of its own.
        const host = `resolve:${bucket}.${new URL(named).hostname}`;
        await server.setFault(`${host}=127.0.0.1`);
        const settings = {
          object_store_bucket: bucket,
          object_store_region: process.env.MARFA_OBJECT_STORE_REGION ?? "",
          object_store_access_key_id:
            process.env.MARFA_OBJECT_STORE_ACCESS_KEY_ID ?? "",
          object_store_secret_access_key:
            process.env.MARFA_OBJECT_STORE_SECRET_ACCESS_KEY ?? "",
          object_store_endpoint: named,
          object_store_path_style: false,
        };
        await setFrom(socket, {
          ...settings,
          object_store_prefix: `fixture-${randomUUID()}`,
        });
        const unusable = await waitFor("the store to be unusable", async () => {
          const said = await backups();
          return said.reason === "destination_unusable" ? said : undefined;
        });
        expect(unusable.status).toBe("failing");

        // The witness: the same store, its host judged public, is taken.
        await server.setFault(`${host}=${PUBLIC_ADDRESS}>127.0.0.1`);
        const prefix = `fixture-${randomUUID()}`;
        await setFrom(socket, { ...settings, object_store_prefix: prefix });
        await waitFor("the object store to be in use", async () => {
          const said = await backups();
          return said.destination === "bucket" &&
            said.reason !== "destination_unusable"
            ? true
            : undefined;
        });
        const bytes = bytesOf("kept in a store reached by its host", 128);
        const upload = await working.uploadBlob(bytes, "text/plain");
        expect(upload.status, JSON.stringify(upload.error)).toBe(201);
        const note = await working.createItem({
          type: "core.note",
          properties: { body: `![blob](${upload.data.hash})` },
        });
        expect(note.status, JSON.stringify(note.error)).toBe(201);
        await replicateUntilCaughtUp(operator, "the file's copy in the store");
        expect(
          (await operator.listBlobCopies(upload.data.hash)).data.data,
        ).toHaveLength(2);

        const link = await working.getBlobUrl(upload.data.hash);
        expect(link.status, JSON.stringify(link.error)).toBe(200);
        const url = new URL(link.data.url);
        expect(url.host).toBe(`${bucket}.${new URL(named).host}`);
        expect(url.pathname.startsWith(`/${prefix}/`), url.pathname).toBe(true);
        const fetched = await getAtLoopback(url);
        expect(fetched.status).toBe(200);
        expect(new Uint8Array(fetched.body)).toEqual(bytes);
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
