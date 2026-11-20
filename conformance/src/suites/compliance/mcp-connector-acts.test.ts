import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { MarfaClient } from "../../client/api.js";
import type { InboundEndpointRow } from "../../client/types.js";
import { controlRequest } from "../../utils/control-request.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  callTool,
  connectMcp,
  toolError,
  toolResult,
  type McpConnection,
} from "../../utils/mcp.js";

/**
 * `marfa_delete_connector` and `marfa_retire_endpoint` on a server of their
 * own, so the clock and a write's faults can be scripted.
 */
const CONFIRMATION_LIFE_MS = 5 * 60 * 1000;
const DELETE = "marfa_delete_connector";
const RETIRE = "marfa_retire_endpoint";

let server: FreshServer;
let admin: McpConnection;
let otherAdmin: McpConnection;

function manager(): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
}

async function mint(
  label: string,
  source: string,
  extra: Record<string, unknown>,
): Promise<{ id: string; key: string }> {
  const minted = await controlRequest(server.controlSocket, "/keys", {
    method: "POST",
    body: { label: `mcp-connector-${label}`, source, ...extra },
  });
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  return minted.body as unknown as { id: string; key: string };
}

async function adminConnection(label: string): Promise<McpConnection> {
  const { key } = await mint(label, `mcp-connector-${label}`, {
    type_permissions: {},
    permissions: ["connectors.manage"],
  });
  return connectMcp(server.apiUrl, key, "2026-07-28", "/mcp/admin");
}

beforeAll(async () => {
  server = await bootFreshServer("mcp-connector-acts");
  admin = await adminConnection("admin");
  otherAdmin = await adminConnection("other-admin");
}, FRESH_SERVER_TIMEOUT_MS);

afterEach(async () => {
  await server.clearFault();
});

afterAll(async () => {
  await admin?.close();
  await otherAdmin?.close();
  await stopFreshServers();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

interface Connector {
  client: MarfaClient;
  id: string;
  source: string;
  keyId: string;
}

/** A registration under a key of its own; a second key on the same source takes the source over. */
async function connector(
  label: string,
  source = `mcp-connector-source-${label}-${randomUUID()}`,
): Promise<Connector> {
  const key = await mint(label, source, {
    default_tier: "library",
    type_permissions: { "core.note": "read" },
  });
  const client = new MarfaClient({ baseUrl: server.apiUrl, apiKey: key.key });
  const registered = await client.registerConnector({ name: label });
  expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  return { client, id: registered.data.id, source, keyId: key.id };
}

/** A successor registration for the source, once the old registration's key is revoked. */
async function takeOver(old: Connector, label: string): Promise<Connector> {
  expect((await manager().revokeKey(old.keyId)).status).toBe(200);
  return connector(label, old.source);
}

async function endpoint(owner: Connector): Promise<InboundEndpointRow> {
  const made = await owner.client.createInboundEndpoint(owner.id);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return made.data;
}

/** A sender's post to the endpoint's address. */
async function deliver(path: string, body = "delivered"): Promise<Response> {
  return fetch(new URL(path, server.apiUrl), { method: "POST", body });
}

async function delivered(path: string, body?: string): Promise<string> {
  const answer = await deliver(path, body);
  expect(answer.status).toBe(202);
  return ((await answer.json()) as { id: string }).id;
}

async function run(owner: Connector): Promise<void> {
  const started = new Date(Date.now() - 2_000).toISOString();
  const finished = new Date(Date.now() - 1_000).toISOString();
  const reported = await owner.client.reportConnectorRun(
    { outcome: "succeeded", started_at: started, finished_at: finished },
    owner.id,
  );
  expect(reported.status, JSON.stringify(reported.error)).toBe(201);
}

async function handled(owner: Connector, id: string): Promise<void> {
  const marked = await owner.client.markInboundDeliveriesHandled(owner.id, {
    ids: [id],
    outcome: "processed",
  });
  expect(marked.status, JSON.stringify(marked.error)).toBe(200);
}

async function note(): Promise<string> {
  const working = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  const made = await working.createItem({
    type: "core.note",
    properties: { body: "agreed with a connector" },
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return made.data.item.id;
}

/** The source's state and problems, written under a hold of the connector's own. */
async function writeState(
  owner: Connector,
  state: Record<string, unknown>,
  problems: Record<string, string> = {},
): Promise<void> {
  const process = "mcp-connector-acts";
  const held = await owner.client.takeConnectorHold(owner.id, process);
  expect(held.status, JSON.stringify(held.error)).toBe(200);
  const written = await owner.client.replaceConnectorState(owner.id, {
    process,
    state,
    problems,
  });
  expect(written.status, JSON.stringify(written.error)).toBe(200);
}

async function agree(
  owner: Connector,
  itemId: string,
  waiting: boolean,
  record: Record<string, unknown> = { etag: "one" },
): Promise<void> {
  const process = "mcp-connector-acts";
  const held = await owner.client.takeConnectorHold(owner.id, process);
  expect(held.status, JSON.stringify(held.error)).toBe(200);
  const written = await owner.client.writeConnectorAgreements(owner.id, {
    process,
    set: [{ item_id: itemId, waiting, record }],
  });
  expect(written.status, JSON.stringify(written.error)).toBe(200);
  expect(written.data.written).toBe(1);
}

async function agreements(owner: Connector): Promise<number> {
  const listed = await owner.client.listConnectorAgreements(owner.id);
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  return listed.data.data.length;
}

async function stands(id: string): Promise<boolean> {
  const status = (await manager().getConnector(id)).status;
  expect([200, 404]).toContain(status);
  return status === 200;
}

async function preview(
  tool: string,
  args: Record<string, unknown>,
  connection = admin,
): Promise<Record<string, unknown>> {
  return toolResult(await callTool(connection, tool, args));
}

async function stale(
  tool: string,
  args: Record<string, unknown>,
  connection = admin,
): Promise<Record<string, unknown>> {
  const refused = toolError(await callTool(connection, tool, args));
  expect(refused.code).toBe("confirmation_stale");
  return refused;
}

describe("marfa_delete_connector deletes a registration", () => {
  it("deletes nothing when called without a confirmation, and previews what goes and what stays", async () => {
    const owner = await connector("previewed");
    const made = await endpoint(owner);
    const waiting = await delivered(made.path, "waiting");
    await handled(owner, await delivered(made.path, "handled"));
    await run(owner);
    await writeState(owner, { cursor: "a" });
    await agree(owner, await note(), true);

    const shown = await preview(DELETE, { id: owner.id });
    expect(shown.connector).toMatchObject({
      id: owner.id,
      name: "previewed",
      source: owner.source,
    });
    expect(shown.current).toBe(true);
    const goesWith = shown.goes_with as Record<string, unknown>;
    expect((goesWith.endpoints as { id: string }[]).map((e) => e.id)).toEqual([
      made.id,
    ]);
    expect(goesWith.unhandled_deliveries).toBe(1);
    expect(goesWith.handled_deliveries).toBe(1);
    expect(goesWith.runs).toBe(1);
    expect(shown.stays).toEqual({ state: true, agreements: 1 });
    expect(typeof shown.confirm).toBe("string");

    expect(await stands(owner.id)).toBe(true);
    const pending = await owner.client.listInboundDeliveries(owner.id);
    expect(pending.data.data.map((row) => row.id)).toContain(waiting);
    expect((await deliver(made.path)).status).toBe(202);
  });

  it("deletes the registration, its runs, endpoints and deliveries with the confirmation the preview gave, and keeps the source's state and agreements", async () => {
    const owner = await connector("deleted");
    const made = await endpoint(owner);
    await delivered(made.path);
    await run(owner);
    await run(owner);
    await writeState(owner, { cursor: "kept" });
    await agree(owner, await note(), false);

    const shown = await preview(DELETE, { id: owner.id });
    const done = await preview(DELETE, {
      id: owner.id,
      confirm: shown.confirm,
    });
    expect(done.deleted).toBe(true);
    expect(done.runs).toBe(2);
    expect(done.already_done).toBeUndefined();

    expect(await stands(owner.id)).toBe(false);
    expect((await deliver(made.path)).status).toBe(404);
    // The same key registers again for the same source and finds what outlived the registration.
    const again = await owner.client.registerConnector({ name: "deleted" });
    expect(again.status).toBe(201);
    const back: Connector = { ...owner, id: again.data.id };
    const state = await back.client.getConnectorState(back.id);
    expect(state.data.state).toEqual({ cursor: "kept" });
    expect(await agreements(back)).toBe(1);
    expect((await back.client.listInboundEndpoints(back.id)).data.data).toEqual(
      [],
    );
  });

  it("deletes on a confirmation after the connector sent heartbeats, reported runs and registered again unchanged", async () => {
    const owner = await connector("running");
    const made = await endpoint(owner);
    await delivered(made.path);
    await run(owner);
    const shown = await preview(DELETE, { id: owner.id });
    expect((shown.goes_with as Record<string, unknown>).runs).toBe(1);

    expect((await owner.client.sendConnectorHeartbeat(owner.id)).status).toBe(
      200,
    );
    const held = await owner.client.takeConnectorHold(owner.id, "running");
    expect(held.status, JSON.stringify(held.error)).toBe(200);
    await run(owner);
    const again = await owner.client.registerConnector({ name: "running" });
    expect(again.status).toBe(200);
    expect(again.data.id).toBe(owner.id);

    const done = await preview(DELETE, {
      id: owner.id,
      confirm: shown.confirm,
    });
    expect(done.deleted).toBe(true);
    // The witness that the run reported after the preview went with it.
    expect(done.runs).toBe(2);
    expect(await stands(owner.id)).toBe(false);
  });

  it("deletes on a confirmation after a delivery arrived and was marked handled since the preview, removing the handled delivery the preview did not count", async () => {
    const owner = await connector("handled-between");
    const made = await endpoint(owner);
    const waiting = await delivered(made.path, "waiting");
    const before = await delivered(made.path, "handled before the preview");
    await handled(owner, before);
    const shown = await preview(DELETE, { id: owner.id });
    expect(shown.goes_with).toMatchObject({
      unhandled_deliveries: 1,
      handled_deliveries: 1,
    });

    const between = await delivered(made.path, "handled after the preview");
    await handled(owner, between);
    // The witness: a preview now counts a handled delivery the first did not.
    const now = await preview(DELETE, { id: owner.id });
    expect(now.goes_with).toMatchObject({
      unhandled_deliveries: 1,
      handled_deliveries: 2,
    });
    const kept = await owner.client.listInboundDeliveries(owner.id, {
      state: "any",
    });
    expect(kept.data.data.map((row) => row.id).sort()).toEqual(
      [waiting, before, between].sort(),
    );

    const done = await preview(DELETE, {
      id: owner.id,
      confirm: shown.confirm,
    });
    expect(done.deleted).toBe(true);
    expect(await stands(owner.id)).toBe(false);
    const again = await owner.client.registerConnector({
      name: "handled-between",
    });
    expect(again.status).toBe(201);
    const left = await owner.client.listInboundDeliveries(again.data.id, {
      state: "any",
    });
    expect(left.status, JSON.stringify(left.error)).toBe(200);
    expect(left.data.data).toEqual([]);
  });

  it("previews the registration's description and declared read-only types, counting those the answer leaves out", async () => {
    const few = await connector("read-only-few");
    const described = await few.client.registerConnector({
      name: "read-only-few",
      description: "Holds notes and tasks read only.",
      read_only_types: ["core.note", "core.task"],
    });
    expect(described.status, JSON.stringify(described.error)).toBe(200);
    const shown = await preview(DELETE, { id: few.id });
    expect(shown.connector).toMatchObject({
      description: "Holds notes and tasks read only.",
      read_only_types: ["core.note", "core.task"],
    });
    expect(
      (shown.connector as Record<string, unknown>).read_only_types_left_out,
    ).toBeUndefined();

    const many = await connector("read-only-many");
    const declared = Array.from(
      { length: 1000 },
      (_, n) => `acme.${"t".repeat(100)}${String(n).padStart(4, "0")}`,
    );
    const registered = await many.client.registerConnector({
      name: "read-only-many",
      read_only_types: declared,
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(200);
    const fitted = await preview(DELETE, { id: many.id });
    const summary = fitted.connector as {
      description: unknown;
      read_only_types: string[];
      read_only_types_left_out: number;
    };
    expect(summary.description).toBeNull();
    expect(summary.read_only_types.length).toBeGreaterThan(0);
    expect(summary.read_only_types_left_out).toBeGreaterThan(0);
    expect(
      summary.read_only_types.length + summary.read_only_types_left_out,
    ).toBe(1000);
    expect(summary.read_only_types).toEqual(
      declared.slice(0, summary.read_only_types.length),
    );
    expect(typeof fitted.confirm).toBe("string");
  });

  it("refuses a confirmation once a delivery arrived or was marked handled since the preview, with a new preview", async () => {
    const owner = await connector("delivered-between");
    const made = await endpoint(owner);
    const first = await delivered(made.path);
    const shown = await preview(DELETE, { id: owner.id });

    await delivered(made.path, "arrived after the preview");
    const arrived = await stale(DELETE, {
      id: owner.id,
      confirm: shown.confirm,
    });
    expect(
      (arrived.goes_with as Record<string, unknown>).unhandled_deliveries,
    ).toBe(2);
    expect(typeof arrived.confirm).toBe("string");
    expect(await stands(owner.id)).toBe(true);

    await handled(owner, first);
    const marked = await stale(DELETE, {
      id: owner.id,
      confirm: arrived.confirm,
    });
    expect(
      (marked.goes_with as Record<string, unknown>).unhandled_deliveries,
    ).toBe(1);
    expect(await stands(owner.id)).toBe(true);

    const done = await preview(DELETE, {
      id: owner.id,
      confirm: marked.confirm,
    });
    expect(done.deleted).toBe(true);
    expect(await stands(owner.id)).toBe(false);
  });

  it("refuses a confirmation once an endpoint was made or retired since the preview", async () => {
    const owner = await connector("endpoints-between");
    const first = await endpoint(owner);
    const shown = await preview(DELETE, { id: owner.id });

    await endpoint(owner);
    const made = await stale(DELETE, { id: owner.id, confirm: shown.confirm });
    expect(
      ((made.goes_with as Record<string, unknown>).endpoints as unknown[])
        .length,
    ).toBe(2);

    expect(
      (await owner.client.retireInboundEndpoint(owner.id, first.id)).status,
    ).toBe(200);
    await stale(DELETE, { id: owner.id, confirm: made.confirm });
    expect(await stands(owner.id)).toBe(true);
  });

  it("refuses a confirmation once the registration changed since the preview", async () => {
    const owner = await connector("renamed");
    const shown = await preview(DELETE, { id: owner.id });
    const changed = await owner.client.registerConnector({
      name: "renamed",
      description: "described after the preview",
    });
    expect(changed.status).toBe(200);
    const refused = await stale(DELETE, {
      id: owner.id,
      confirm: shown.confirm,
    });
    expect(typeof refused.confirm).toBe("string");
    expect(await stands(owner.id)).toBe(true);
  });

  it("refuses a confirmation once another registration took the source since the preview, and keeps the source's endpoints and deliveries when the old registration goes", async () => {
    const old = await connector("taken-over");
    const made = await endpoint(old);
    const waiting = await delivered(made.path);
    const shown = await preview(DELETE, { id: old.id });
    expect(shown.current).toBe(true);

    const successor = await takeOver(old, "successor");
    const refused = await stale(DELETE, { id: old.id, confirm: shown.confirm });
    expect(refused.current).toBe(false);
    expect(
      (refused.goes_with as Record<string, unknown>).endpoints,
    ).toBeUndefined();
    expect(await stands(old.id)).toBe(true);

    const done = await preview(DELETE, {
      id: old.id,
      confirm: refused.confirm,
    });
    expect(done.deleted).toBe(true);
    expect(await stands(old.id)).toBe(false);
    const listed = await successor.client.listInboundEndpoints(successor.id);
    expect(listed.data.data.map((row) => row.id)).toEqual([made.id]);
    const pending = await successor.client.listInboundDeliveries(successor.id);
    expect(pending.data.data.map((row) => row.id)).toEqual([waiting]);
    expect((await deliver(made.path)).status).toBe(202);
  });

  it("refuses a confirmation when the connector is gone, without saying it was not found", async () => {
    const owner = await connector("gone");
    const shown = await preview(DELETE, { id: owner.id });
    expect((await manager().deleteConnector(owner.id)).status).toBe(200);
    const refused = await stale(DELETE, {
      id: owner.id,
      confirm: shown.confirm,
    });
    expect(refused.confirm).toBeUndefined();
    // The witness: a preview of the same id names it as not found.
    const missing = toolError(await callTool(admin, DELETE, { id: owner.id }));
    expect(missing.code).toBe("connector_not_found");
  });
});

describe("marfa_delete_connector clears a connector's state", () => {
  it("clears nothing without a confirmation, and clears the state, problems and agreements with the one the preview gave", async () => {
    const owner = await connector("cleared");
    await writeState(owner, { cursor: "b" }, { feed: "The feed is slow." });
    await agree(owner, await note(), true);
    await agree(owner, await note(), false);

    const shown = await preview(DELETE, { id: owner.id, part: "state" });
    expect(shown).toMatchObject({
      state: true,
      problems: 1,
      agreements: 2,
      waiting: 1,
    });
    expect(typeof shown.confirm).toBe("string");
    expect((await owner.client.getConnectorState(owner.id)).data.state).toEqual(
      { cursor: "b" },
    );
    expect(await agreements(owner)).toBe(2);

    const done = await preview(DELETE, {
      id: owner.id,
      part: "state",
      confirm: shown.confirm,
    });
    expect(done).toMatchObject({ cleared: true, agreements: 2 });
    const state = await owner.client.getConnectorState(owner.id);
    expect(state.data.state).toEqual({});
    expect(state.data.problems).toEqual({});
    expect(await agreements(owner)).toBe(0);
    expect(await stands(owner.id)).toBe(true);
  });

  it("answers a source with no state and no agreements with no confirmation", async () => {
    const owner = await connector("nothing-to-clear");
    const empty = await preview(DELETE, { id: owner.id, part: "state" });
    expect(empty).toMatchObject({ state: false, agreements: 0 });
    expect(empty.confirm).toBeUndefined();
    // The witness: once the source holds state, the same preview gives one.
    await writeState(owner, { cursor: "c" });
    const held = await preview(DELETE, { id: owner.id, part: "state" });
    expect(typeof held.confirm).toBe("string");
  });

  it("refuses a confirmation once the state or an agreement changed since the preview", async () => {
    const owner = await connector("state-between");
    const item = await note();
    await writeState(owner, { cursor: "d" });
    await agree(owner, item, false);
    const shown = await preview(DELETE, { id: owner.id, part: "state" });

    await writeState(owner, { cursor: "e" });
    const state = await stale(DELETE, {
      id: owner.id,
      part: "state",
      confirm: shown.confirm,
    });
    expect(typeof state.confirm).toBe("string");

    await agree(owner, item, true);
    const waiting = await stale(DELETE, {
      id: owner.id,
      part: "state",
      confirm: state.confirm,
    });
    expect(waiting.waiting).toBe(1);

    await agree(owner, item, true, { etag: "two" });
    await stale(DELETE, {
      id: owner.id,
      part: "state",
      confirm: waiting.confirm,
    });
    expect((await owner.client.getConnectorState(owner.id)).data.state).toEqual(
      { cursor: "e" },
    );
    expect(await agreements(owner)).toBe(1);
  });
});

describe("marfa_retire_endpoint retires an endpoint", () => {
  it("retires nothing without a confirmation, and retires the endpoint with the one the preview gave, keeping its deliveries", async () => {
    const owner = await connector("retired");
    const made = await endpoint(owner);
    const waiting = await delivered(made.path);
    const args = { id: owner.id, endpoint_id: made.id };

    const shown = await preview(RETIRE, args);
    expect((shown.endpoint as Record<string, unknown>).id).toBe(made.id);
    expect(shown.unhandled_deliveries).toBe(1);
    expect(typeof shown.confirm).toBe("string");
    expect((await deliver(made.path)).status).toBe(202);

    const done = await preview(RETIRE, { ...args, confirm: shown.confirm });
    expect(done.retired).toBe(true);
    expect((await deliver(made.path)).status).toBe(404);
    const listed = await owner.client.listInboundEndpoints(owner.id);
    expect(listed.data.data[0]?.retired_at).not.toBeNull();
    const pending = await owner.client.listInboundDeliveries(owner.id);
    expect(pending.data.data.map((row) => row.id)).toContain(waiting);
  });

  it("answers an endpoint already retired with no confirmation", async () => {
    const owner = await connector("retired-before");
    const made = await endpoint(owner);
    const live = await preview(RETIRE, { id: owner.id, endpoint_id: made.id });
    expect(typeof live.confirm).toBe("string");
    expect(
      (await owner.client.retireInboundEndpoint(owner.id, made.id)).status,
    ).toBe(200);
    const shown = await preview(RETIRE, { id: owner.id, endpoint_id: made.id });
    expect(shown.already_retired).toBe(true);
    expect(shown.confirm).toBeUndefined();
  });

  it("refuses a confirmation once the endpoint was retired since the preview", async () => {
    const owner = await connector("retired-between");
    const made = await endpoint(owner);
    const args = { id: owner.id, endpoint_id: made.id };
    const shown = await preview(RETIRE, args);
    expect(
      (await owner.client.retireInboundEndpoint(owner.id, made.id)).status,
    ).toBe(200);
    const refused = await stale(RETIRE, { ...args, confirm: shown.confirm });
    expect(refused.already_retired).toBe(true);
    expect(refused.confirm).toBeUndefined();
  });

  it("refuses a confirmation once the connector no longer holds the endpoint's source", async () => {
    const old = await connector("retire-taken-over");
    const made = await endpoint(old);
    const shown = await preview(RETIRE, { id: old.id, endpoint_id: made.id });
    const successor = await takeOver(old, "retire-successor");
    const refused = await stale(RETIRE, {
      id: old.id,
      endpoint_id: made.id,
      confirm: shown.confirm,
    });
    expect(refused.confirm).toBeUndefined();
    const listed = await successor.client.listInboundEndpoints(successor.id);
    expect(listed.data.data[0]?.retired_at).toBeNull();
    expect((await deliver(made.path)).status).toBe(202);
  });
});

describe("a confirmation of a connector's change", () => {
  it("refuses a confirmation another credential got", async () => {
    const owner = await connector("other-credential");
    const made = await endpoint(owner);
    await writeState(owner, { cursor: "f" });
    const calls: [string, Record<string, unknown>][] = [
      [DELETE, { id: owner.id }],
      [DELETE, { id: owner.id, part: "state" }],
      [RETIRE, { id: owner.id, endpoint_id: made.id }],
    ];
    for (const [tool, args] of calls) {
      const theirs = await preview(tool, args, otherAdmin);
      const refused = await stale(tool, { ...args, confirm: theirs.confirm });
      expect(refused.confirm, tool).toBeUndefined();
    }
    expect(await stands(owner.id)).toBe(true);
    expect((await deliver(made.path)).status).toBe(202);
    expect((await owner.client.getConnectorState(owner.id)).data.state).toEqual(
      { cursor: "f" },
    );
  });

  it("refuses a confirmation once five minutes have passed since the preview", async () => {
    const owner = await connector("expired");
    const made = await endpoint(owner);
    await writeState(owner, { cursor: "g" });
    const calls: [string, Record<string, unknown>][] = [
      [DELETE, { id: owner.id }],
      [DELETE, { id: owner.id, part: "state" }],
      [RETIRE, { id: owner.id, endpoint_id: made.id }],
    ];
    const shown = [];
    for (const [tool, args] of calls) {
      shown.push((await preview(tool, args)).confirm);
    }
    await server.advanceClock(CONFIRMATION_LIFE_MS + 1_000);
    for (const [index, [tool, args]] of calls.entries()) {
      const refused = await stale(tool, { ...args, confirm: shown[index] });
      expect(refused.confirm, tool).toBeUndefined();
    }
    expect(await stands(owner.id)).toBe(true);
    expect((await deliver(made.path)).status).toBe(202);
  });

  it("refuses a confirmation sent for another connector, part or endpoint before reading it", async () => {
    const owner = await connector("named");
    const other = await connector("not-named");
    const made = await endpoint(owner);
    const otherEndpoint = await endpoint(owner);
    await writeState(owner, { cursor: "h" });
    await writeState(other, { cursor: "i" });

    const registration = await preview(DELETE, { id: owner.id });
    for (const args of [
      { id: other.id },
      { id: owner.id, part: "state" },
      { id: randomUUID() },
    ]) {
      const refused = await stale(DELETE, {
        ...args,
        confirm: registration.confirm,
      });
      expect(refused.confirm, JSON.stringify(args)).toBeUndefined();
    }
    const state = await preview(DELETE, { id: owner.id, part: "state" });
    const refused = await stale(DELETE, {
      id: owner.id,
      confirm: state.confirm,
    });
    expect(refused.confirm).toBeUndefined();
    const retiring = await preview(RETIRE, {
      id: owner.id,
      endpoint_id: made.id,
    });
    const wrong = await stale(RETIRE, {
      id: owner.id,
      endpoint_id: otherEndpoint.id,
      confirm: retiring.confirm,
    });
    expect(wrong.confirm).toBeUndefined();

    expect(await stands(owner.id)).toBe(true);
    expect(await stands(other.id)).toBe(true);
    expect((await deliver(made.path)).status).toBe(202);
    expect((await deliver(otherEndpoint.path)).status).toBe(202);
  });

  it("leaves the connector and the confirmation as they were when the confirmed change fails, and changes it without the fault", async () => {
    const owner = await connector("fault");
    const made = await endpoint(owner);
    await writeState(owner, { cursor: "j" });
    await agree(owner, await note(), false);
    const cases: [string, string, Record<string, unknown>][] = [
      [
        "inbound_endpoint.retire",
        RETIRE,
        { id: owner.id, endpoint_id: made.id },
      ],
      ["connector_state.delete", DELETE, { id: owner.id, part: "state" }],
      ["connector.delete", DELETE, { id: owner.id }],
    ];
    for (const [action, tool, args] of cases) {
      const shown = await preview(tool, args);
      await server.setFault(`fail:audit=${action}`);
      const failed = await callTool(admin, tool, {
        ...args,
        confirm: shown.confirm,
      });
      // The witness that the fault acted inside the change, after its rows went and before it committed.
      expect(
        (await server.faults()).find((fault) => fault.name === "fail:audit")
          ?.fired,
        action,
      ).toBe(1);
      expect(failed.isError, action).toBe(true);
      expect(await stands(owner.id), action).toBe(true);
      if (action === "inbound_endpoint.retire") {
        expect((await deliver(made.path)).status).toBe(202);
      }
      if (action === "connector_state.delete") {
        expect(
          (await owner.client.getConnectorState(owner.id)).data.state,
        ).toEqual({ cursor: "j" });
        expect(await agreements(owner)).toBe(1);
      }
      await server.clearFault();
      const done = await preview(tool, { ...args, confirm: shown.confirm });
      expect(done.already_done, action).toBeUndefined();
    }
    expect(await stands(owner.id)).toBe(false);
    expect((await deliver(made.path)).status).toBe(404);
  });

  it("changes nothing more on a confirmation an earlier call used, and says it already did", async () => {
    const owner = await connector("repeated");
    const made = await endpoint(owner);
    await run(owner);
    await writeState(owner, { cursor: "k" });
    await agree(owner, await note(), false);

    const retire = { id: owner.id, endpoint_id: made.id };
    const retiring = await preview(RETIRE, retire);
    expect(
      (await preview(RETIRE, { ...retire, confirm: retiring.confirm })).retired,
    ).toBe(true);
    const retiredAgain = await preview(RETIRE, {
      ...retire,
      confirm: retiring.confirm,
    });
    expect(retiredAgain).toMatchObject({ retired: true, already_done: true });

    const clear = { id: owner.id, part: "state" };
    const clearing = await preview(DELETE, clear);
    expect(
      await preview(DELETE, { ...clear, confirm: clearing.confirm }),
    ).toMatchObject({ cleared: true, agreements: 1 });
    // State written after the clear stays, as the repeated call changes nothing.
    await writeState(owner, { cursor: "after" });
    expect(
      await preview(DELETE, { ...clear, confirm: clearing.confirm }),
    ).toMatchObject({ cleared: true, agreements: 1, already_done: true });
    expect((await owner.client.getConnectorState(owner.id)).data.state).toEqual(
      { cursor: "after" },
    );

    const deleting = await preview(DELETE, { id: owner.id });
    expect(
      await preview(DELETE, { id: owner.id, confirm: deleting.confirm }),
    ).toMatchObject({ deleted: true, runs: 1 });
    expect(
      await preview(DELETE, { id: owner.id, confirm: deleting.confirm }),
    ).toMatchObject({ deleted: true, runs: 1, already_done: true });
    expect(await stands(owner.id)).toBe(false);
  });
});
