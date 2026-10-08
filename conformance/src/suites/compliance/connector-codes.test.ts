import { randomUUID } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { AuditEntry, TestContext } from "../../client/types.js";
import { createNote } from "../../generators/items.js";
import { idOf, send } from "../../utils/inbound-sender.js";
import { publishedOperations } from "../../utils/openapi.js";
import {
  cleanup,
  createSecondClient,
  createTestContext,
  getManagementClient,
  trackItem,
  trackKey,
} from "../../utils/setup.js";

/**
 * The answers on the connector and inbound doors that the chapters state and
 * the other fixtures leave to a status alone or to nothing: the code a
 * revoked key is told, the bounds of a page, the refusal another connector's
 * delivery meets, the server's clock on what it stamps, and what a refused
 * registration leaves.
 */

/** Registrations that hold state, cleared before the file ends. */
const stateful: string[] = [];

let ctx: TestContext;
let client: MarfaClient;
let apiUrl: string;
const operator = () => getManagementClient();

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "connector-codes",
  ));
});

afterAll(async () => {
  // A source's state outlives its registration, so it goes first.
  for (const id of stateful) await operator().deleteConnectorState(id);
  await cleanup(ctx);
});

interface Owner {
  client: MarfaClient;
  id: string;
  keyId: string;
  source: string;
}

async function owner(label: string): Promise<Owner> {
  const own = await createSecondClient(ctx, label);
  const registered = await own.registerConnector({
    name: `${ctx.runId} ${label}`,
  });
  expect(registered.status).toBe(201);
  return {
    client: own,
    id: registered.data.id,
    keyId: registered.data.key_id,
    source: registered.data.source,
  };
}

const at = () => new Date().toISOString();

async function address(own: Owner): Promise<{ id: string; path: string }> {
  const made = await own.client.createInboundEndpoint(own.id);
  expect(made.status).toBe(201);
  return { id: made.data.id, path: made.data.path };
}

describe("a revoked key", () => {
  it("answers 401 unauthorized to a revoked key on every door, and leaves its runs to the operator", async () => {
    const own = await owner("revoked");
    const when = at();
    const failed = await own.client.reportConnectorRun(own.id, {
      outcome: "failed",
      started_at: when,
      finished_at: when,
      error: "vendor failure",
    });
    expect(failed.status).toBe(201);
    const succeeded = await own.client.reportConnectorRun(own.id, {
      outcome: "succeeded",
      started_at: when,
      finished_at: when,
      summary: "ten rows",
    });
    expect(succeeded.status).toBe(201);
    const runs = (await own.client.listConnectorRuns(own.id)).data.data;
    expect(runs.map((run) => run.id)).toEqual([
      succeeded.data.id,
      failed.data.id,
    ]);

    // What the key holds, so that a refusal leaves something to compare.
    const process = randomUUID();
    const row = await client.createItem(createNote());
    expect(row.ok).toBe(true);
    trackItem(ctx, row.data.item.id);
    expect((await own.client.holdConnector(own.id, process)).status).toBe(200);
    expect(
      (
        await own.client.replaceConnectorState(own.id, {
          process,
          state: { cursor: "kept" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await own.client.writeConnectorAgreements(own.id, {
          process,
          set: [{ item_id: row.data.item.id, waiting: true, record: { e: 1 } }],
        })
      ).status,
    ).toBe(200);
    const made = await address(own);
    const delivery = idOf(await send(apiUrl, made.path, "kept"));
    const beat = await own.client.heartbeatConnector(own.id);
    expect(beat.status).toBe(200);

    expect((await client.revokeKey(own.keyId)).status).toBe(200);

    const base = `/connectors/${own.id}`;
    const doors: [string, string, string, Record<string, unknown>?][] = [
      ["POST", "/connectors", "/connectors", { name: "again" }],
      ["GET", "/connectors", "/connectors"],
      ["GET", "/connectors/{id}", base],
      ["DELETE", "/connectors/{id}", base],
      ["POST", "/connectors/{id}/heartbeat", `${base}/heartbeat`],
      [
        "POST",
        "/connectors/{id}/runs",
        `${base}/runs`,
        { outcome: "succeeded", started_at: when, finished_at: when },
      ],
      ["GET", "/connectors/{id}/runs", `${base}/runs`],
      ["POST", "/connectors/{id}/hold", `${base}/hold`, { process }],
      ["DELETE", "/connectors/{id}/hold", `${base}/hold?process=${process}`],
      ["GET", "/connectors/{id}/state", `${base}/state`],
      [
        "PUT",
        "/connectors/{id}/state",
        `${base}/state`,
        { process, state: { cursor: "revoked" } },
      ],
      ["DELETE", "/connectors/{id}/state", `${base}/state`],
      [
        "POST",
        "/connectors/{id}/agreements",
        `${base}/agreements`,
        { process, clear: [row.data.item.id] },
      ],
      [
        "POST",
        "/connectors/{id}/agreements/lookup",
        `${base}/agreements/lookup`,
        { item_ids: [row.data.item.id] },
      ],
      ["GET", "/connectors/{id}/agreements", `${base}/agreements`],
      ["POST", "/connectors/{id}/endpoints", `${base}/endpoints`, {}],
      ["GET", "/connectors/{id}/endpoints", `${base}/endpoints`],
      [
        "DELETE",
        "/connectors/{id}/endpoints/{endpoint_id}",
        `${base}/endpoints/${made.id}`,
      ],
      ["GET", "/connectors/{id}/deliveries", `${base}/deliveries`],
      [
        "GET",
        "/connectors/{id}/deliveries/{delivery_id}/body",
        `${base}/deliveries/${delivery}/body`,
      ],
      [
        "POST",
        "/connectors/{id}/deliveries/handled",
        `${base}/deliveries/handled`,
        { ids: [delivery], outcome: "processed" },
      ],
    ];
    // The doors above are every operation the document publishes under
    // `/connectors`, so a door added later is a door this test fails to drive.
    const published = (await publishedOperations())
      .filter((op) => op.path.startsWith("/connectors"))
      .map((op) => `${op.method} ${op.path}`)
      .sort();
    expect(
      doors.map(([method, template]) => `${method} ${template}`).sort(),
    ).toEqual(published);

    for (const [method, , path, body] of doors) {
      const refused = await own.client.rawRequest<unknown>(path, {
        method,
        body,
      });
      expect(refused.status, `${method} ${path}`).toBe(401);
      expect(refused.error?.error.code, `${method} ${path}`).toBe(
        "unauthorized",
      );
    }

    // The registration outlives the key, and so do its runs, which the
    // revoked key's refused report did not add to.
    const read = await operator().getConnector(own.id);
    expect(read.status).toBe(200);
    expect(read.data.key_id).toBe(own.keyId);
    expect(read.data.last_run?.id).toBe(succeeded.data.id);
    expect(read.data.last_heartbeat_at).toBe(beat.data.last_heartbeat_at);
    expect(read.data.hold_expires_at).not.toBeNull();
    const kept = await operator().listConnectorRuns(own.id);
    expect(kept.status).toBe(200);
    expect(kept.data.data).toEqual(runs);
    expect(kept.data.next_cursor).toBeNull();
    // None of the refused writes and removals happened: the endpoint is
    // live, and the next key under the source reads the state and the
    // agreement as they were left.
    const endpoints = await operator().listInboundEndpoints(own.id);
    expect(endpoints.data.data.map((row) => row.retired_at)).toEqual([null]);
    const successor = await client.createKey({
      label: `${own.source}-successor`,
      source: own.source,
      default_tier: "library",
    });
    expect(successor.status).toBe(201);
    trackKey(ctx, successor.data.id);
    const next = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: successor.data.key,
    });
    const successorRegistration = await next.registerConnector({
      name: `${ctx.runId} successor`,
    });
    expect(successorRegistration.status).toBe(201);
    stateful.push(successorRegistration.data.id);
    expect(
      (await next.getConnectorState(successorRegistration.data.id)).data.state,
    ).toEqual({ cursor: "kept" });
    expect(
      (
        await next.lookupConnectorAgreements(successorRegistration.data.id, [
          row.data.item.id,
        ])
      ).data.data.map((agreement) => agreement.record),
    ).toEqual([{ e: 1 }]);
  });
});

describe("the bounds of a page", () => {
  it("refuses a limit outside 1 to 200 with validation_error on the runs, agreements and deliveries listings, and takes both ends", async () => {
    const own = await owner("limits");
    const listings = [
      `/connectors/${own.id}/runs`,
      `/connectors/${own.id}/agreements`,
      `/connectors/${own.id}/deliveries`,
    ];
    for (const path of listings) {
      for (const limit of ["1", "200"]) {
        const taken = await own.client.rawRequest<unknown>(
          `${path}?limit=${limit}`,
        );
        expect(taken.status, `${path} limit=${limit}`).toBe(200);
      }
      for (const limit of ["0", "201", "-1", "1.5", "many"]) {
        const refused = await own.client.rawRequest<unknown>(
          `${path}?limit=${limit}`,
        );
        expect(refused.status, `${path} limit=${limit}`).toBe(400);
        expect(refused.error?.error.code, `${path} limit=${limit}`).toBe(
          "validation_error",
        );
      }
    }
  });

  it("lists 50 deliveries and 50 agreements unless a limit is named, and up to 200 when it is", async () => {
    const own = await owner("default-page");
    stateful.push(own.id);
    const made = await address(own);
    for (let i = 0; i < 51; i++) {
      idOf(await send(apiUrl, made.path, String(i)));
    }
    const deliveries = await own.client.listInboundDeliveries(own.id);
    expect(deliveries.data.data).toHaveLength(50);
    expect(deliveries.data.next_cursor).not.toBeNull();
    const all = await own.client.listInboundDeliveries(own.id, { limit: 200 });
    expect(all.data.data).toHaveLength(51);
    expect(all.data.next_cursor).toBeNull();

    const created = await client.bulkItems(
      Array.from({ length: 51 }, (_, i) =>
        createNote({
          source: ctx.source,
          source_id: `${ctx.runId}-default-${String(i)}`,
          properties: { title: `n${String(i)}`, body: "agreed" },
        }),
      ),
    );
    expect(created.status).toBe(200);
    const rows = created.data.results.map((row) => row.id ?? "");
    for (const id of rows) {
      expect(id).not.toBe("");
      trackItem(ctx, id);
    }
    const process = randomUUID();
    expect((await own.client.holdConnector(own.id, process)).status).toBe(200);
    const written = await own.client.writeConnectorAgreements(own.id, {
      process,
      set: rows.map((item_id) => ({ item_id, waiting: false, record: {} })),
    });
    expect(written.data.written).toBe(51);
    const agreements = await own.client.listConnectorAgreements(own.id);
    expect(agreements.data.data).toHaveLength(50);
    expect(agreements.data.next_cursor).not.toBeNull();
    const every = await own.client.listConnectorAgreements(own.id, {
      limit: 200,
    });
    expect(every.data.data).toHaveLength(51);
    expect(every.data.next_cursor).toBeNull();
  });
});

describe("a registration that is not the asker's", () => {
  it("answers another connector's delivery, endpoint and registration with the code of each, and marks and retires nothing", async () => {
    const mine = await owner("cross-mine");
    const theirs = await owner("cross-theirs");
    const made = await address(mine);
    const delivery = idOf(await send(apiUrl, made.path, "mine"));

    // The witness: the connector's own key reaches all three.
    expect(
      (await mine.client.getInboundDeliveryBody(mine.id, delivery)).status,
    ).toBe(200);

    const body = await theirs.client.getInboundDeliveryBody(
      theirs.id,
      delivery,
    );
    expect(body.status).toBe(404);
    expect(
      ((await body.json()) as { error: { code: string } }).error.code,
    ).toBe("delivery_not_found");
    const marked = await theirs.client.markInboundDeliveriesHandled(theirs.id, {
      ids: [delivery],
      outcome: "processed",
    });
    expect(marked.status).toBe(404);
    expect(marked.error?.error.code).toBe("delivery_not_found");
    const retired = await theirs.client.retireInboundEndpoint(
      theirs.id,
      made.id,
    );
    expect(retired.status).toBe(404);
    expect(retired.error?.error.code).toBe("endpoint_not_found");

    // Another's registration is read as one that is not there.
    const absent = "01a0c000-0000-7000-8000-000000000000";
    for (const suffix of ["", "/runs"]) {
      const hidden = await theirs.client.rawRequest<unknown>(
        `/connectors/${mine.id}${suffix}`,
      );
      const unknown = await theirs.client.rawRequest<unknown>(
        `/connectors/${absent}${suffix}`,
      );
      expect(hidden.status, suffix).toBe(404);
      expect(hidden.error?.error.code, suffix).toBe("connector_not_found");
      expect(hidden.error?.error).toEqual(unknown.error?.error);
    }

    const [stored] = (await mine.client.listInboundDeliveries(mine.id)).data
      .data;
    expect(stored?.id).toBe(delivery);
    expect(stored?.handled_at).toBeNull();
    const endpoints = await mine.client.listInboundEndpoints(mine.id);
    expect(endpoints.data.data.map((row) => row.retired_at)).toEqual([null]);
  });
});

describe("what the server stamps", () => {
  it("stamps a heartbeat, a run's report and a receipt with its own clock", async () => {
    const own = await owner("clock");
    const made = await address(own);
    // The fixture's clock and the server's are one machine's in a run, and
    // a second either way allows for the stamp's rounding.
    const within = (stamp: string, before: number, after: number) => {
      expect(Date.parse(stamp)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(stamp)).toBeLessThanOrEqual(after + 1000);
    };

    let before = Date.now();
    const beat = await own.client.heartbeatConnector(own.id);
    within(beat.data.last_heartbeat_at, before, Date.now());

    // A run's own times say nothing of when it was reported.
    before = Date.now();
    const run = await own.client.reportConnectorRun(own.id, {
      outcome: "succeeded",
      started_at: "2020-01-01T00:00:00Z",
      finished_at: "2020-01-01T00:00:01Z",
    });
    expect(run.status).toBe(201);
    const reported = Date.now();
    expect(run.data.started_at).toBe("2020-01-01T00:00:00.000Z");
    within(run.data.reported_at, before, reported);
    expect(
      (await own.client.listConnectorRuns(own.id)).data.data[0]?.reported_at,
    ).toBe(run.data.reported_at);

    before = Date.now();
    idOf(await send(apiUrl, made.path, "stamped"));
    const received = Date.now();
    const [delivery] = (await own.client.listInboundDeliveries(own.id)).data
      .data;
    within(delivery?.received_at ?? "", before, received);
  });
});

describe("a registration that was refused", () => {
  it("leaves nothing behind when the operator key, a name or a description is refused", async () => {
    const own = await createSecondClient(ctx, "refused");
    const keyId = (await own.getCurrentKey()).data.id;
    const operatorId = (await operator().getCurrentKey()).data.id;
    const since = at();
    const before = (await operator().listConnectors()).data.data.map(
      (row) => row.id,
    );

    for (const body of [
      { name: "" },
      { name: "n".repeat(201) },
      { name: "fine", description: "d".repeat(2001) },
      {},
    ]) {
      const refused = await own.registerConnector(
        body as { name: string; description?: string },
      );
      expect(refused.status, JSON.stringify(body).slice(0, 30)).toBe(400);
    }
    const byOperator = await operator().registerConnector({ name: "operator" });
    expect(byOperator.status).toBe(403);

    const after = (await operator().listConnectors()).data.data;
    expect(after.map((row) => row.id)).toEqual(before);
    expect(after.map((row) => row.key_id)).not.toContain(keyId);
    expect(after.map((row) => row.key_id)).not.toContain(operatorId);
    const written = async (): Promise<AuditEntry[]> => {
      const rows: AuditEntry[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listAudit({
          action: "connector.register",
          created_after: since,
          limit: 200,
          cursor,
        });
        expect(page.status).toBe(200);
        rows.push(...page.data.data);
        cursor = page.data.next_cursor ?? undefined;
      } while (cursor !== undefined);
      return rows;
    };
    expect(
      (await written()).filter((row) =>
        [keyId, operatorId].includes(row.key_id),
      ),
    ).toEqual([]);

    // The witness: a registration that is taken leaves its row and its
    // audit entry, so the absence above is of what a refusal would have left.
    const taken = await own.registerConnector({ name: `${ctx.runId} taken` });
    expect(taken.status).toBe(201);
    expect(
      (await written()).filter((row) => row.key_id === keyId),
    ).toHaveLength(1);
    expect(
      (await operator().listConnectors()).data.data.map((row) => row.key_id),
    ).toContain(keyId);
  });
});

describe("a body field no operation declares", () => {
  it("refuses a body field it does not declare, on every connector and inbound operation that takes a body", async () => {
    const own = await owner("undeclared");
    const made = await address(own);
    const delivery = idOf(await send(apiUrl, made.path, "waiting"));
    const process = randomUUID();
    const row = uuidv7();
    const when = at();
    expect((await own.client.holdConnector(own.id, process)).status).toBe(200);

    interface Door {
      label: string;
      method: "POST" | "PUT";
      path: string;
      /** A body the operation takes. */
      body: Record<string, unknown>;
      /** A field no operation names, spelled like one it does. */
      stray: string;
      /** What the operation answers a body it takes, the first time and again. */
      first: number;
      again: number;
    }
    const doors: Door[] = [
      {
        label: "POST /connectors",
        method: "POST",
        path: "/connectors",
        body: { name: `${ctx.runId} undeclared-register` },
        stray: "descripton",
        first: 201,
        again: 200,
      },
      {
        label: "POST runs",
        method: "POST",
        path: `/connectors/${own.id}/runs`,
        body: { outcome: "succeeded", started_at: when, finished_at: when },
        stray: "sumary",
        first: 201,
        again: 201,
      },
      {
        label: "POST hold",
        method: "POST",
        path: `/connectors/${own.id}/hold`,
        body: { process },
        stray: "window_ms",
        first: 200,
        again: 200,
      },
      {
        label: "PUT state",
        method: "PUT",
        path: `/connectors/${own.id}/state`,
        body: { process, state: { cursor: "a" } },
        stray: "merge",
        first: 200,
        again: 200,
      },
      {
        label: "POST agreements",
        method: "POST",
        path: `/connectors/${own.id}/agreements`,
        body: { process, clear: [row] },
        stray: "sets",
        first: 200,
        again: 200,
      },
      {
        label: "POST agreements/lookup",
        method: "POST",
        path: `/connectors/${own.id}/agreements/lookup`,
        body: { item_ids: [row] },
        stray: "waiting",
        first: 200,
        again: 200,
      },
      {
        label: "POST endpoints",
        method: "POST",
        path: `/connectors/${own.id}/endpoints`,
        body: { label: "undeclared" },
        stray: "lable",
        first: 201,
        again: 201,
      },
      {
        label: "POST deliveries/handled",
        method: "POST",
        path: `/connectors/${own.id}/deliveries/handled`,
        body: { ids: [delivery], outcome: "processed" },
        stray: "outcom",
        first: 200,
        again: 200,
      },
    ];

    for (const door of doors) {
      // The registration door is the one a key with none reaches.
      const caller =
        door.path === "/connectors"
          ? await createSecondClient(ctx, "undeclared-register")
          : own.client;
      const call = (body: Record<string, unknown>) =>
        caller.rawRequest<unknown>(door.path, { method: door.method, body });

      const refused = await call({ ...door.body, [door.stray]: true });
      expect(refused.status, door.label).toBe(400);
      expect(refused.error?.error.code, door.label).toBe("validation_error");
      expect(
        refused.error?.error.details?.["unknown_body_fields"],
        door.label,
      ).toEqual([door.stray]);

      // The witnesses: the same body without the field is taken, and a field
      // of the caller's own, which starts with an underscore, is ignored.
      expect((await call(door.body)).status, `${door.label}: without`).toBe(
        door.first,
      );
      expect(
        (await call({ ...door.body, _client: "kept by the caller" })).status,
        `${door.label}: an underscore field`,
      ).toBe(door.again);
    }

    // What the refusals would have done is not there to find: the one
    // delivery was marked once, by the witness, and no run or endpoint came
    // of a refusal.
    expect((await own.client.listConnectorRuns(own.id)).data.data).toHaveLength(
      2,
    );
    expect(
      (await own.client.listInboundEndpoints(own.id)).data.data,
    ).toHaveLength(3);
  });
});
