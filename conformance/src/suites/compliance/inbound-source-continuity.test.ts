import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { idOf, openCounted, send } from "../../utils/inbound-sender.js";
import { HOUR_MS, movedClock } from "../../utils/moved-clock.js";

let server: FreshServer;
let clock: ReturnType<typeof movedClock>;
let serial = 0;
beforeAll(async () => {
  server = await bootFreshServer("inbound-source-continuity", {
    MARFA_RATE_LIMIT_ENABLED: "false",
  });
  clock = movedClock(server);
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
/** A key that expires an hour from now on the server's clock, or never. */
const inAnHour = (): string => new Date(clock.now() + HOUR_MS).toISOString();

async function mint(source: string, expiresAt?: string) {
  const response = await call("/keys", "POST", {
    label: source,
    source,
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
  });
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
async function fixture(expiresAt?: string) {
  const source = `source-continuity-${String(++serial)}`;
  const oldKey = await mint(source, expiresAt);
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
/** The registrations whose key is `keyId`, as the operator lists them. */
async function registrationsOf(keyId: string): Promise<string[]> {
  const response = await call("/connectors");
  expect(response.status).toBe(200);
  const rows = (await response.json()) as {
    data: { id: string; key_id: string }[];
  };
  return rows.data.filter((row) => row.key_id === keyId).map((row) => row.id);
}
/** The registrations of `source` that hold its endpoints now. */
async function holders(source: string): Promise<string[]> {
  const response = await call("/connectors");
  expect(response.status).toBe(200);
  const rows = (await response.json()) as {
    data: { id: string; source: string }[];
  };
  const holding: string[] = [];
  for (const row of rows.data.filter((r) => r.source === source)) {
    if ((await listed(row.id, server.managementKey)).data.length > 0)
      holding.push(row.id);
  }
  return holding;
}
function operator(): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
}
/** How many times `keyId` registered a connector, by the audit listing. */
async function registrationAudits(keyId: string): Promise<number> {
  const listing = await operator().listAudit({
    action: "connector.register",
    limit: 100,
  });
  expect(listing.ok, JSON.stringify(listing.error)).toBe(true);
  return listing.data.data.filter((entry) => entry.key_id === keyId).length;
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
      await server.setFault("hold:write=connector.register");
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
      await server.waitForHold("hold:write");
      expect(completed).toBe(false);
      expect(await registrationsOf(successorKey.id)).toEqual([]);
      expect(await holders(source)).toEqual([old.id]);
      const ended = await server.restart({ signal: "SIGKILL" });
      expect(ended.signal).toBe("SIGKILL");
      await blocked;
      expect(await registrationsOf(successorKey.id)).toEqual([]);
      expect(await holders(source)).toEqual([old.id]);
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
      expect(await holders(source)).toEqual([successor.id]);
      expect(successor.last_run).toBeNull();
      expect(successor.hold_expires_at).toBeNull();
      expect(await registrationsOf(successorKey.id)).toEqual([successor.id]);
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
      expect(await registrationsOf(lostKey.id)).toEqual([retried.id]);
      expect(await registrationsOf(successorKey.id)).toEqual([successor.id]);
      expect((await call(`/connectors/${successor.id}`, "DELETE")).status).toBe(
        200,
      );
      expect((await send(server.apiUrl, endpoint.path, "deleted")).status).toBe(
        404,
      );
      // The source's next registration inherits what the source still owns,
      // which is nothing once its last registration was deleted.
      const again = await register(successorKey.key);
      expect(again.status).toBe(201);
      expect((await listed(again.id, again.key)).data).toEqual([]);
      // Removing the current registration frees the room its deliveries held.
      await server.restart({
        env: {
          MARFA_INBOUND_BACKLOG_DELIVERIES: "1",
          MARFA_INBOUND_RETAINED_DELIVERIES: "1",
        },
      });
      const full = await fixture();
      expect(
        (await send(server.apiUrl, full.endpoint.path, "kept")).status,
      ).toBe(202);
      // The witness: with the delivery kept, the next one is refused.
      expect(
        (await send(server.apiUrl, full.endpoint.path, "more")).status,
      ).toBe(503);
      expect((await call(`/connectors/${full.old.id}`, "DELETE")).status).toBe(
        200,
      );
      const replacement = await register(full.oldKey.key);
      expect(replacement.status).toBe(201);
      const fresh = await call(
        `/connectors/${replacement.id}/endpoints`,
        "POST",
        {},
        replacement.key,
      );
      expect(fresh.status).toBe(201);
      const { path } = (await fresh.json()) as { path: string };
      expect((await send(server.apiUrl, path, "room")).status).toBe(202);
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it("refuses an already arriving body after a takeover", async () => {
    await server.restart({
      env: {
        MARFA_INBOUND_MAX_BYTES: "2000",
        MARFA_INBOUND_IN_FLIGHT_BYTES: "4096",
      },
    });
    const { source, oldKey, old, endpoint } = await fixture();
    expect((await send(server.apiUrl, endpoint.path, "x")).status).toBe(202);
    const held = await openCounted(
      server,
      endpoint.path,
      1900,
      "h".repeat(1800),
    );
    // The source may hold half of the 4096, which 1900 and 300 pass, so the
    // probe is refused now the body is counted.
    expect(
      (await send(server.apiUrl, endpoint.path, "x".repeat(300))).status,
    ).toBe(503);
    const taken = 1;
    expect((await call(`/keys/${oldKey.id}`, "DELETE")).status).toBe(200);
    const successor = await register((await mint(source)).key);
    expect(successor.status).toBe(201);
    held.finish("d".repeat(100));
    expect((await held.answer).status).toBe(404);
    expect(
      (await listed(successor.id, successor.key, "deliveries")).data,
    ).toHaveLength(taken);
    expect((await send(server.apiUrl, endpoint.path, "new")).status).toBe(202);
    expect((await listed(old.id, server.managementKey)).data).toEqual([]);
  });
  it("preserves retired endpoints and retained bodies after key expiry without serving before registration", async () => {
    await server.restart({
      env: {
        MARFA_INBOUND_MAX_BYTES: "26214400",
        MARFA_INBOUND_IN_FLIGHT_BYTES: "67108864",
      },
    });
    const { source, oldKey, old, endpoint } = await fixture(inAnHour());
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
    await clock.advance(2 * HOUR_MS);
    expect((await send(server.apiUrl, endpoint.path, "expired")).status).toBe(
      404,
    );
    // Minting the replacement retires the expired source holder publicly.
    const next = await mint(source);
    expect(
      (await call("/keys/current", "GET", undefined, oldKey.key)).status,
    ).toBe(401);
    const revocations = await operator().listAudit({
      action: "key.revoke",
      resource_id: oldKey.id,
    });
    expect(revocations.ok, JSON.stringify(revocations.error)).toBe(true);
    expect(
      revocations.data.data.filter(
        (entry) => entry.details.reason === "expired",
      ),
    ).toHaveLength(1);
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
    const before = (await listed(old.id, old.key, "deliveries?state=any"))
      .data[0];
    expect(before?.id).toBe(receipt);
    expect((await call(`/keys/${oldKey.id}`, "DELETE")).status).toBe(200);
    const successor = await register((await mint(source)).key);
    expect(
      (await listed(successor.id, successor.key, "deliveries?state=any"))
        .data[0],
    ).toEqual(before);
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
  it.each(["revoked", "expired"])(
    "refuses registration when its key becomes %s while the writer is held",
    async (standing) => {
      await server.restart({
        env: {
          MARFA_INBOUND_BACKLOG_DELIVERIES: "1000",
          MARFA_INBOUND_RETAINED_DELIVERIES: "10000",
        },
      });
      const { source, oldKey, old, endpoint } = await fixture();
      expect((await send(server.apiUrl, endpoint.path, "witness")).status).toBe(
        202,
      );
      expect((await call(`/keys/${oldKey.id}`, "DELETE")).status).toBe(200);
      const waitingKey = await mint(
        source,
        standing === "expired" ? inAnHour() : undefined,
      );
      expect(
        (await call("/keys/current", "GET", undefined, waitingKey.key)).status,
      ).toBe(200);
      const bindingBefore = await holders(source);
      const auditBefore = await registrationAudits(waitingKey.id);
      expect(bindingBefore).toEqual([old.id]);
      expect(auditBefore).toBe(0);
      await server.setFault("hold:write=connector.register");
      let completed = false;
      const waiting = call(
        "/connectors",
        "POST",
        { name: "Waiting registration" },
        waitingKey.key,
      ).then((response) => {
        completed = true;
        return response;
      });
      await server.waitForHold("hold:write");
      expect(completed).toBe(false);
      expect(await registrationsOf(waitingKey.id)).toEqual([]);
      if (standing === "revoked") {
        expect((await call(`/keys/${waitingKey.id}`, "DELETE")).status).toBe(
          200,
        );
      } else {
        await clock.advance(2 * HOUR_MS);
      }
      await server.clearFault("hold:write");
      const refused = await waiting;
      expect(refused.status).toBe(401);
      expect(
        ((await refused.json()) as { error: { code: string } }).error.code,
      ).toBe("unauthorized");
      expect(await registrationsOf(waitingKey.id)).toEqual([]);
      expect(await holders(source)).toEqual(bindingBefore);
      expect(await registrationAudits(waitingKey.id)).toBe(auditBefore);
      // The witness: the same wait, with the key still standing, registers.
      const live = await mint(source);
      await server.setFault("hold:write=connector.register");
      const control = register(live.key);
      await server.waitForHold("hold:write");
      await server.clearFault("hold:write");
      const admitted = await control;
      expect(admitted.status).toBe(201);
      expect(await holders(source)).toEqual([admitted.id]);
      expect(await registrationAudits(live.id)).toBe(1);
      expect((await send(server.apiUrl, endpoint.path, "control")).status).toBe(
        202,
      );
    },
  );
});
