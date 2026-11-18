import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
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
} from "../../utils/own-blob-server.js";
import { waitFor } from "../../utils/wait.js";

/**
 * While `allow_private_addresses` is off, the heartbeat, the error webhook
 * and the object store reach only public addresses, as webhooks do, and only
 * the private local process or an app whose owner just signed in turns it
 * on. Every receiver here, and the run's
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

describe("where the server may send", () => {
  it(
    "refuses a key holding config.manage the switch turned on, which an app whose owner signed in just now turns on, and lets it turn the switch off",
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
        // The key turns the switch off, which asks for no sign-in, but not
        // while a private destination is stored.
        await setFrom(operator, {
          object_store_endpoint: "http://127.0.0.1:9",
        });
        const held = await operator.patchConfig({ [SWITCH]: false });
        expect(held.status).toBe(400);
        expect(JSON.stringify(held.error)).toContain("object_store_endpoint");
        expect(
          ((await operator.getConfig()).data as Record<string, unknown>)[
            SWITCH
          ],
        ).toBe(true);
        await setFrom(operator, { object_store_endpoint: null });
        const off = await operator.patchConfig({ [SWITCH]: false });
        expect(off.status, JSON.stringify(off.error)).toBe(200);
        expect(
          (await operator.getConfig()).data as Record<string, unknown>,
        ).not.toHaveProperty(SWITCH, true);
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a heartbeat_url, error_webhook_url or object_store_endpoint written as a private address while the switch is off",
    async () => {
      const server = await bootFreshServer("switch-literals", PUBLIC_ONLY);
      try {
        const { operator } = clientsFor(server);
        const keys = [
          "heartbeat_url",
          "error_webhook_url",
          "object_store_endpoint",
        ];
        const hosts = [
          "127.0.0.1:9",
          "[::1]:9",
          "10.1.2.3",
          "169.254.169.254",
          "[::ffff:192.168.0.1]",
        ];
        for (const key of keys) {
          for (const host of hosts) {
            const refused = await operator.patchConfig({
              [key]: `http://${host}/hush-${key}`,
            });
            expect(refused.status, `${key} ${host}`).toBe(400);
            const said = JSON.stringify(refused.error);
            expect(said).toContain(key);
            expect(said).toContain(SWITCH);
            expect(said).not.toContain(`hush-${key}`);
          }
          // The witness: the same setting takes a name, which a lookup judges.
          await setFrom(operator, { [key]: "http://receiver.example.test/" });
          await setFrom(operator, { [key]: null });
        }

        const socket = socketOf(server);
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
    "sends no error notice to a name that leads to a private address until the switch is on",
    async () => {
      const notices: Record<string, unknown>[] = [];
      const receiver = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk: Buffer) => (body += chunk.toString()));
        request.on("end", () => {
          notices.push(JSON.parse(body) as Record<string, unknown>);
          response.writeHead(204).end();
        });
      });
      await new Promise<void>((resolve) =>
        receiver.listen(0, "127.0.0.1", resolve),
      );
      const address = receiver.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("the receiver did not bind to a port");
      }
      const server = await bootFreshServer("switch-error-webhook", PUBLIC_ONLY);
      try {
        const { operator, working } = clientsFor(server);
        const fail = async () => {
          await server.setFault("fail:audit=item.create");
          const failed = await working.createItem({
            type: "core.note",
            properties: { body: `fails ${randomUUID()}` },
          });
          await server.clearFault();
          expect(failed.status).toBe(500);
          return failed.headers.get("x-request-id");
        };
        await setFrom(operator, {
          error_webhook_url: `http://localhost:${String(address.port)}/errors`,
        });
        const unsent = await fail();

        // The witness: the notices go out in order, so the one sent once the
        // switch is on arrives after the first would have.
        await setFrom(socketOf(server), { [SWITCH]: true });
        const sent = await fail();
        await waitFor("the notice sent once the switch is on", async () =>
          notices.find((notice) => notice.request_id === sent),
        );
        expect(notices.map((notice) => notice.request_id)).toEqual([sent]);
        expect(unsent).not.toBe(sent);
      } finally {
        await server.stop();
        receiver.closeAllConnections();
        await new Promise<void>((resolve) => receiver.close(() => resolve()));
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "takes an object store on a private address once the private local process turns the switch on, and not before",
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
        const literal = await operator.patchConfig({
          ...store,
          object_store_endpoint: endpoint,
        });
        expect(literal.status).toBe(400);
        await setFrom(operator, {
          ...store,
          object_store_endpoint: byName(endpoint),
        });
        const unusable = await waitFor("the store to be unusable", async () => {
          const said = await backups();
          return said.reason === "destination_unusable" ? said : undefined;
        });
        expect(unusable.status).toBe("failing");

        await setFrom(socketOf(server), { [SWITCH]: true });
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
});
