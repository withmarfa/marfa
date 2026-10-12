import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { HeldLock } from "../../utils/held-lock.js";
import { idOf, openBody, send } from "../../utils/inbound-sender.js";

let server: FreshServer;
let serial = 0;
beforeAll(async () => {
  server = await bootFreshServer("inbound-source-continuity", {
    RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_INBOUND_REQUESTS: "3",
    RATE_LIMIT_WINDOW_MS: "600000",
  });
}, FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

function call(
  path: string,
  method = "GET",
  body?: unknown,
  key = server.managementKey,
) {
  return fetch(server.apiUrl + path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function mint(source: string) {
  const response = await call("/keys", "POST", { label: source, source });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; key: string };
}
async function register(key: string) {
  const response = await call(
    "/connectors",
    "POST",
    { name: "Source reader" },
    key,
  );
  const value = (await response.json()) as {
    id: string;
    last_run: unknown;
    hold_expires_at: unknown;
  };
  return { ...value, status: response.status, key };
}
async function fixture() {
  const source = `source-continuity-${String(++serial)}`;
  const oldKey = await mint(source);
  const old = await register(oldKey.key);
  expect(old.status).toBe(201);
  const created = await call(
    `/connectors/${old.id}/endpoints`,
    "POST",
    { label: "Kept address", duplicate_header: "X-Delivery" },
    old.key,
  );
  expect(created.status).toBe(201);
  const endpoint = (await created.json()) as {
    id: string;
    path: string;
    created_at: string;
  };
  return { source, oldKey, old, endpoint };
}
async function listed(id: string, key: string, suffix = "endpoints") {
  const response = await call(
    `/connectors/${id}/${suffix}`,
    "GET",
    undefined,
    key,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { data: Record<string, unknown>[] };
}
function sql(query: string) {
  return execFileSync(
    "sqlite3",
    ["-batch", "-bail", server.sqlitePath, query],
    { encoding: "utf8" },
  ).trim();
}

describe("source-owned inbound continuity", () => {
  it(
    "survives an interrupted successor registration and a discarded committed reply on the same database",
    async () => {
      const { source, oldKey, old, endpoint } = await fixture();
      const bytes = Buffer.from([0, 255, 13, 10, 128]);
      const original = idOf(
        await send(server.apiUrl, endpoint.path, bytes, ["X-Delivery", "same"]),
      );
      expect(
        (
          await call(
            `/connectors/${old.id}/deliveries/handled`,
            "POST",
            { ids: [original], outcome: "processed" },
            old.key,
          )
        ).status,
      ).toBe(200);
      const pending = idOf(
        await send(server.apiUrl, endpoint.path, "pending", [
          "X-Delivery",
          "same",
        ]),
      );
      expect((await call(`/keys/${oldKey.id}`, "DELETE")).status).toBe(200);
      const successorKey = await mint(source);
      // Prime authentication's usage stamp before holding the writer.
      expect(
        (await call("/keys/current", "GET", undefined, successorKey.key))
          .status,
      ).toBe(200);
      expect(
        (await send(server.apiUrl, endpoint.path, "before binding")).status,
      ).toBe(404);
      const lock = await HeldLock.take(server.sqlitePath);
      let completed = false;
      const blocked = call(
        "/connectors",
        "POST",
        { name: "Interrupted" },
        successorKey.key,
      ).then(
        (response) => {
          completed = true;
          return response.status;
        },
        () => {
          completed = true;
          return 0;
        },
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(completed).toBe(false);
        expect(
          sql(
            `SELECT count(*) FROM connectors WHERE key_id = '${successorKey.id}'`,
          ),
        ).toBe("0");
        expect(
          sql(
            `SELECT connector_id FROM inbound_sources WHERE source = '${source}'`,
          ),
        ).toBe(old.id);
        const ended = await server.restart({
          signal: "SIGKILL",
          whileStopped: async () => {
            await blocked;
            expect(
              sql(
                `SELECT count(*) FROM connectors WHERE key_id = '${successorKey.id}'`,
              ),
            ).toBe("0");
            expect(
              sql(
                `SELECT connector_id FROM inbound_sources WHERE source = '${source}'`,
              ),
            ).toBe(old.id);
            await lock.release();
          },
        });
        expect(ended.signal).toBe("SIGKILL");
      } finally {
        await lock.release();
      }
      expect(
        sql(
          `SELECT count(*) FROM connectors WHERE key_id = '${successorKey.id}'`,
        ),
      ).toBe("0");
      expect(
        sql(
          `SELECT connector_id FROM inbound_sources WHERE source = '${source}'`,
        ),
      ).toBe(old.id);
      const answers = await Promise.all([
        register(successorKey.key),
        register(successorKey.key),
      ]);
      expect(answers.map((a) => a.status).sort()).toEqual([200, 201]);
      expect(answers[0]!.id).toBe(answers[1]!.id);
      const successor = answers[0]!;
      expect(
        (
          await call(
            "/connectors",
            "POST",
            { name: "Stale registration" },
            old.key,
          )
        ).status,
      ).toBe(401);
      expect(
        sql(
          `SELECT connector_id FROM inbound_sources WHERE source = '${source}'`,
        ),
      ).toBe(successor.id);
      expect(successor.last_run).toBeNull();
      expect(successor.hold_expires_at).toBeNull();
      expect(
        sql(
          `SELECT count(*) FROM connectors WHERE key_id = '${successorKey.id}'`,
        ),
      ).toBe("1");
      expect((await listed(successor.id, successor.key)).data).toMatchObject([
        {
          id: endpoint.id,
          connector_id: successor.id,
          created_at: endpoint.created_at,
        },
      ]);
      const body = await call(
        `/connectors/${successor.id}/deliveries/${original}/body`,
        "GET",
        undefined,
        successor.key,
      );
      expect(body.status).toBe(200);
      expect(Buffer.from(await body.arrayBuffer())).toEqual(bytes);
      const deliveries = await listed(
        successor.id,
        successor.key,
        "deliveries?state=any",
      );
      expect(deliveries.data.map((d) => d.id)).toEqual([original, pending]);
      expect(deliveries.data[1]?.duplicate_of).toEqual({
        id: original,
        outcome: "processed",
      });
      expect((await listed(old.id, server.managementKey)).data).toEqual([]);
      expect(
        (await call(`/connectors/${old.id}/endpoints/${endpoint.id}`, "DELETE"))
          .status,
      ).toBe(404);
      expect(
        (await send(server.apiUrl, endpoint.path, "after binding")).status,
      ).toBe(202);
      expect((await call(`/connectors/${old.id}`, "DELETE")).status).toBe(200);
      expect(
        (await listed(successor.id, successor.key)).data.map((e) => e.id),
      ).toEqual([endpoint.id]);
      // A committed reply whose body the caller never keeps is retried by key.
      const lostKey = await mint("discarded-registration-reply");
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(
          server.apiUrl + "/connectors",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${lostKey.key}`,
              "Content-Type": "application/json",
            },
          },
          (response) => {
            expect(response.statusCode).toBe(201);
            response.destroy();
            resolve();
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify({ name: "Reply discarded" }));
      });
      const retried = await register(lostKey.key);
      expect(retried.status).toBe(200);
      expect(
        sql(`SELECT id FROM connectors WHERE key_id = '${lostKey.id}'`),
      ).toBe(retried.id);
      expect(
        sql(
          `SELECT count(*) FROM connectors WHERE key_id = '${successorKey.id}'`,
        ),
      ).toBe("1");
      expect((await call(`/connectors/${successor.id}`, "DELETE")).status).toBe(
        200,
      );
      expect((await send(server.apiUrl, endpoint.path, "deleted")).status).toBe(
        404,
      );
      expect(
        sql(
          `SELECT count(*) FROM inbound_deliveries WHERE endpoint_id = '${endpoint.id}'`,
        ),
      ).toBe("0");
      expect(
        sql(
          `SELECT count(*) FROM inbound_delivery_bodies WHERE delivery_id = '${original}'`,
        ),
      ).toBe("0");
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it("keeps the endpoint rate window across takeover and refuses an already arriving body", async () => {
    await server.restart({
      env: { MARFA_INBOUND_MAX_BYTES: "4", MARFA_INBOUND_IN_FLIGHT_BYTES: "4" },
    });
    const { source, oldKey, old, endpoint } = await fixture();
    expect((await send(server.apiUrl, endpoint.path, "x")).status).toBe(202);
    const held = openBody(server.apiUrl, endpoint.path, 4, "hel");
    const probe = await fixture();
    let probeStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      probeStatus = (await send(server.apiUrl, probe.endpoint.path, "xx"))
        .status;
      if (probeStatus === 503) break;
      expect(probeStatus).toBe(202);
    }
    // Two probe bytes cannot fit while the three held bytes are in flight.
    expect(probeStatus).toBe(503);
    expect((await call(`/keys/${oldKey.id}`, "DELETE")).status).toBe(200);
    const successor = await register((await mint(source)).key);
    expect(successor.status).toBe(201);
    held.finish("d");
    expect((await held.answer).status).toBe(404);
    expect(
      (await listed(successor.id, successor.key, "deliveries")).data,
    ).toHaveLength(1);
    expect((await send(server.apiUrl, endpoint.path, "new")).status).toBe(202);
    expect((await send(server.apiUrl, endpoint.path, "x")).status).toBe(429);
    expect((await listed(old.id, server.managementKey)).data).toEqual([]);
  });
  it("preserves retired endpoints and retained bodies after key expiry without serving before registration", async () => {
    await server.restart({
      env: {
        MARFA_INBOUND_MAX_BYTES: "26214400",
        MARFA_INBOUND_IN_FLIGHT_BYTES: "67108864",
      },
    });
    const { source, oldKey, old, endpoint } = await fixture();
    const receipt = idOf(await send(server.apiUrl, endpoint.path, "retained"));
    const retiredResponse = await call(
      `/connectors/${old.id}/endpoints`,
      "POST",
      {},
      old.key,
    );
    expect(retiredResponse.status).toBe(201);
    const retired = (await retiredResponse.json()) as {
      id: string;
      path: string;
    };
    expect(
      (
        await call(
          `/connectors/${old.id}/endpoints/${retired.id}`,
          "DELETE",
          undefined,
          old.key,
        )
      ).status,
    ).toBe(200);
    await server.restart(() => {
      sql(
        `UPDATE api_keys SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = '${oldKey.id}'`,
      );
    });
    expect((await send(server.apiUrl, endpoint.path, "expired")).status).toBe(
      404,
    );
    // The public key-management door does not resolve expired keys.
    // Retire the expired slot while the fixture's server is stopped.
    await server.restart(() => {
      sql(
        `UPDATE api_keys SET revoked_at = '2026-01-01T00:00:00.000Z' WHERE id = '${oldKey.id}'`,
      );
    });
    const next = await mint(source);
    expect(
      (await send(server.apiUrl, endpoint.path, "unregistered")).status,
    ).toBe(404);
    const successor = await register(next.key);
    expect(successor.status).toBe(201);
    const inherited = (await listed(successor.id, successor.key)).data;
    expect(inherited.map((e) => e.id).sort()).toEqual(
      [endpoint.id, retired.id].sort(),
    );
    expect(
      inherited.find((e) => e.id === retired.id)?.retired_at,
    ).not.toBeNull();
    expect((await send(server.apiUrl, retired.path, "retired")).status).toBe(
      404,
    );
    const body = await call(
      `/connectors/${successor.id}/deliveries/${receipt}/body`,
      "GET",
      undefined,
      successor.key,
    );
    expect(body.status).toBe(200);
    expect(await body.text()).toBe("retained");
    expect((await send(server.apiUrl, endpoint.path, "active")).status).toBe(
      202,
    );
  });

  it("keeps source endpoint and retained capacity across registration replacement", async () => {
    await server.restart({
      env: {
        MARFA_INBOUND_MAX_BYTES: "26214400",
        MARFA_INBOUND_IN_FLIGHT_BYTES: "67108864",
        MARFA_INBOUND_BACKLOG_DELIVERIES: "1",
        MARFA_INBOUND_RETAINED_DELIVERIES: "1",
      },
    });
    const { source, oldKey, old, endpoint } = await fixture();
    for (let i = 1; i < 10; i++)
      expect(
        (await call(`/connectors/${old.id}/endpoints`, "POST", {}, old.key))
          .status,
      ).toBe(201);
    const receipt = idOf(await send(server.apiUrl, endpoint.path, "kept"));
    const before = sql(
      `SELECT id,source,received_at,size,stored_bytes FROM inbound_deliveries WHERE id = '${receipt}'`,
    );
    expect((await call(`/keys/${oldKey.id}`, "DELETE")).status).toBe(200);
    const successor = await register((await mint(source)).key);
    expect(
      sql(
        `SELECT id,source,received_at,size,stored_bytes FROM inbound_deliveries WHERE id = '${receipt}'`,
      ),
    ).toBe(before);
    expect(
      (
        await call(
          `/connectors/${successor.id}/endpoints`,
          "POST",
          {},
          successor.key,
        )
      ).status,
    ).toBe(409);
    expect(
      (await send(server.apiUrl, endpoint.path, "over backlog")).status,
    ).toBe(503);
    expect(
      (
        await call(
          `/connectors/${successor.id}/deliveries/handled`,
          "POST",
          { ids: [receipt], outcome: "processed" },
          successor.key,
        )
      ).status,
    ).toBe(200);
    expect(
      (await send(server.apiUrl, endpoint.path, "over retained")).status,
    ).toBe(503);
    expect(
      (
        await listed(successor.id, successor.key, "deliveries?state=any")
      ).data.map((d) => d.id),
    ).toEqual([receipt]);
  });
});
