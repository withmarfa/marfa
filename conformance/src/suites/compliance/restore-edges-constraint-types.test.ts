import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { v7 as uuidv7 } from "uuid";
import { listTarGzEntries, tarGz } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * A real round trip on throwaway servers: the archive is exported from an
 * instance that force-deleted an item type while an edge type's constraints
 * still named it and edges between its items stood, restored into a fresh
 * one, and the edges the second instance holds are compared with the first's.
 * The state is the instance's own, made through the HTTP API alone: two
 * registrations, items, edges, and `DELETE /types/{id}?force=true`.
 */
let origin: FreshServer;
let destination: FreshServer;
let third: FreshServer;
let fourth: FreshServer;
beforeEach(async () => {
  [origin, destination, third, fourth] = await Promise.all([
    bootFreshServer("constraint-types-origin"),
    bootFreshServer("constraint-types-destination"),
    bootFreshServer("constraint-types-third"),
    bootFreshServer("constraint-types-fourth"),
  ]);
}, 4 * FRESH_SERVER_TIMEOUT_MS);
afterEach(async () => {
  await Promise.all([
    origin?.stop(),
    destination?.stop(),
    third?.stop(),
    fourth?.stop(),
  ]);
}, FRESH_SERVER_TIMEOUT_MS);

const working = (server: FreshServer) =>
  new MarfaClient({ baseUrl: server.apiUrl, apiKey: server.workingKey });
const owner = (server: FreshServer) =>
  new MarfaClient({ baseUrl: server.apiUrl, ownerCookie: server.ownerCookie });

const PAPER = "user.paper";

async function archiveOf(client: MarfaClient) {
  const exported = await client.exportArchive({ state: "any" });
  expect(
    exported.status,
    Buffer.from(exported.data).toString().slice(0, 500),
  ).toBe(200);
  return exported.data;
}

/** Every edge an instance holds, whole, in id order. */
async function edgesOf(client: MarfaClient) {
  const listed = await client.listEdges({ limit: 200 });
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  expect(listed.data.next_cursor).toBeNull();
  return [...listed.data.data].sort((a, b) => a.id.localeCompare(b.id));
}

/** The archive with each named member rewritten, every other as it was. */
function rewritten(
  archive: Uint8Array,
  changes: Record<string, (body: string) => string>,
) {
  return tarGz(
    listTarGzEntries(archive).map((entry) => ({
      name: entry.name,
      body: changes[entry.name]?.(entry.body.toString()) ?? entry.body,
    })),
  );
}

/** The ids of the item types a `types.ndjson` body registers. */
function registeredTypeIds(body: string) {
  return body
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line) => {
      const { type } = JSON.parse(line) as { type?: { id: string } };
      return type ? [type.id] : [];
    });
}

/** One `edges.ndjson` line for an edge no instance wrote. */
const edgeLine = (source_id: string, target_id: string, edge_type: string) =>
  `${JSON.stringify({
    edge: { id: uuidv7(), source_id, target_id, edge_type, properties: {} },
  })}\n`;

interface Story {
  papers: [string, string];
  note: string;
  task: string;
}

/** Two papers, a note and a task on the origin. */
async function populate(source: MarfaClient): Promise<Story> {
  expect(
    (
      await source.registerType({
        id: PAPER,
        version: 1,
        fields: { title: { type: "string", required: true } },
      })
    ).status,
  ).toBe(201);
  const ids: string[] = [];
  for (const [type, properties] of [
    [PAPER, { title: "first paper" }],
    [PAPER, { title: "second paper" }],
    ["core.note", { body: "a note" }],
    ["core.task", { title: "a task" }],
  ] as const) {
    const made = await source.createItem({ type, properties });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    ids.push(made.data.item.id);
  }
  const [a, b, note, task] = ids as [string, string, string, string];
  return { papers: [a, b], note, task };
}

async function register(
  source: MarfaClient,
  id: string,
  constraints: {
    source_type_constraints?: string[];
    target_type_constraints?: string[];
  },
) {
  const registered = await source.registerEdgeType({
    label: "Test edge type",
    id,
    cardinality: "many-to-many",
    ...constraints,
  });
  expect(registered.status, JSON.stringify(registered.error)).toBe(201);
}

async function link(
  source: MarfaClient,
  source_id: string,
  target_id: string,
  edge_type: string,
) {
  const made = await source.createEdge({ source_id, target_id, edge_type });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
}

/** An ordinary write the registered constraint refuses. */
async function expectRefused(
  client: MarfaClient,
  source_id: string,
  target_id: string,
  edge_type: string,
) {
  const refused = await client.createEdge({
    source_id,
    target_id,
    edge_type,
  });
  expect(refused.status, JSON.stringify(refused.error)).toBe(400);
  expect(refused.error?.error.code).toBe("edge_constraint_violation");
}

/**
 * Exports the origin and restores into the destination and the destination's
 * own export into the third, and asserts that every instance holds the same
 * items and edges and that the paper type is registered on none of them.
 */
async function roundTrip(
  source: MarfaClient,
  expected: { edges: number; items: number },
) {
  const exported = await archiveOf(source);
  const members = listTarGzEntries(exported);
  const carried = registeredTypeIds(
    members.find((m) => m.name === "types.ndjson")!.body.toString(),
  );
  expect(carried, "the archive carries no paper registration").not.toContain(
    PAPER,
  );
  expect(
    members.find((m) => m.name === "types.ndjson")!.body.toString(),
  ).toContain(`"edge_type"`);
  expect(
    members.find((m) => m.name === "items.ndjson")!.body.toString(),
    "the archive carries the papers",
  ).toContain(PAPER);

  const restored = await owner(destination).restoreArchive(exported);
  expect(restored.status, JSON.stringify(restored.error)).toBe(200);
  expect(restored.data).toMatchObject({
    imported: expected.items,
    edges_imported: expected.edges,
    edges_skipped: 0,
  });
  const reader = working(destination);
  const before = await edgesOf(source);
  expect(before).toHaveLength(expected.edges);
  expect(await edgesOf(reader)).toEqual(before);
  expect((await reader.getType(PAPER)).status).toBe(404);

  const second = await archiveOf(reader);
  const again = await owner(third).restoreArchive(second);
  expect(again.status, JSON.stringify(again.error)).toBe(200);
  expect(again.data).toMatchObject({
    edges_imported: expected.edges,
    edges_skipped: 0,
  });
  expect(await edgesOf(working(third))).toEqual(before);
  return exported;
}

describe("an edge whose endpoint constraint names a force-deleted item type", () => {
  it("keeps an edge whose source constraint names the deleted type, and still refuses a registered end the constraint does not admit", async () => {
    const source = working(origin);
    const { papers, note } = await populate(source);
    const type = "user.cites-source";
    await register(source, type, { source_type_constraints: [PAPER] });
    await link(source, papers[0], papers[1], type);
    await link(source, papers[0], note, type);

    // The witness: while the paper type is registered the constraint refuses
    // a note as the source, and it is the same constraint after the delete.
    await expectRefused(source, note, papers[0], type);
    expect((await source.deleteType(PAPER, true)).status).toBe(200);
    expect((await source.getType(PAPER)).status).toBe(404);
    const edgeTypes = await source.listEdgeTypes();
    expect(
      edgeTypes.data.data.find((t) => t.id === type)?.source_type_constraints,
    ).toEqual([PAPER]);

    // Ordinary writes are unchanged: an end of an unregistered type is still
    // refused by the constraint, and so is a registered one.
    await expectRefused(source, papers[1], note, type);
    await expectRefused(source, note, papers[1], type);

    // `GET /export` in both formats succeeds.
    const lines = await source.exportItems({ state: "any" });
    expect(lines.status).toBe(200);
    expect(lines.data).toContain(`"edge_type":"${type}"`);
    const exported = await roundTrip(source, { edges: 2, items: 4 });

    // A restore still holds an edge to the constraint of a registered end: a
    // note is no paper, so it is refused as a source, and the same archive
    // restores the edges it carries beside it.
    const crafted = rewritten(exported, {
      "edges.ndjson": (body) => body + edgeLine(note, papers[0], type),
    });
    const judged = await owner(fourth).restoreArchive(crafted);
    expect(judged.status, JSON.stringify(judged.error)).toBe(200);
    expect(judged.data).toMatchObject({
      edges_imported: 2,
      edges_skipped: 1,
      edges_skipped_reasons: { edge_constraint_violation: 1 },
    });
  }, 240_000);

  it("keeps an edge whose target constraint names the deleted type", async () => {
    const source = working(origin);
    const { papers, note } = await populate(source);
    const type = "user.cites-target";
    await register(source, type, { target_type_constraints: [PAPER] });
    await link(source, note, papers[0], type);
    await link(source, papers[1], papers[0], type);
    await expectRefused(source, papers[0], note, type);
    expect((await source.deleteType(PAPER, true)).status).toBe(200);
    await expectRefused(source, papers[0], note, type);
    await roundTrip(source, { edges: 2, items: 4 });
  }, 240_000);

  it("judges a constraint that lists a registered and a deleted type by the endpoint: an end of the deleted type is kept, and an end of a registered type must be one the list names", async () => {
    const source = working(origin);
    const { papers, note, task } = await populate(source);
    const type = "user.cites-either";
    await register(source, type, {
      source_type_constraints: [PAPER, "core.task"],
      target_type_constraints: ["core.note", PAPER],
    });
    await link(source, papers[0], note, type);
    await link(source, task, papers[1], type);
    await link(source, task, note, type);
    await expectRefused(source, note, task, type);
    expect((await source.deleteType(PAPER, true)).status).toBe(200);
    await expectRefused(source, note, task, type);
    const exported = await roundTrip(source, { edges: 3, items: 4 });

    // The registered type the list names still decides for a registered end,
    // and an end of a registered type that the list does not name is
    // refused, whichever end it is.
    const crafted = rewritten(exported, {
      "edges.ndjson": (body) =>
        body +
        edgeLine(note, task, type) +
        edgeLine(note, papers[0], type) +
        edgeLine(papers[1], task, type),
    });
    const judged = await owner(fourth).restoreArchive(crafted);
    expect(judged.status, JSON.stringify(judged.error)).toBe(200);
    expect(judged.data).toMatchObject({
      edges_imported: 3,
      edges_skipped: 3,
      edges_skipped_reasons: { edge_constraint_violation: 3 },
    });
  }, 240_000);

  it("restores an older archive whose item type is not registered, keeping the edge its constraint named the type for", async () => {
    const source = working(origin);
    const { papers, note } = await populate(source);
    const type = "user.cites-older";
    await register(source, type, {
      source_type_constraints: [PAPER],
      target_type_constraints: [PAPER, "core.note"],
    });
    await link(source, papers[0], papers[1], type);
    await link(source, papers[1], note, type);
    const whole = await archiveOf(source);

    // The archive as a build wrote it before the type was deleted, and as one
    // that carried no registration of the type holds the same rows.
    const registrations = (archive: Uint8Array) =>
      listTarGzEntries(archive)
        .find((m) => m.name === "types.ndjson")!
        .body.toString();
    expect(registeredTypeIds(registrations(whole))).toContain(PAPER);
    const older = rewritten(whole, {
      "types.ndjson": (body) =>
        body
          .split("\n")
          .filter(
            (line) =>
              line !== "" &&
              (JSON.parse(line) as { type?: { id?: string } }).type?.id !==
                PAPER,
          )
          .map((line) => `${line}\n`)
          .join(""),
    });
    expect(registeredTypeIds(registrations(older))).not.toContain(PAPER);
    expect(registrations(older)).toContain(`"${type}"`);

    const restored = await owner(destination).restoreArchive(older);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data).toMatchObject({
      imported: 4,
      edges_imported: 2,
      edges_skipped: 0,
    });
    const reader = working(destination);
    expect(await edgesOf(reader)).toEqual(await edgesOf(source));
    expect((await reader.getType(PAPER)).status).toBe(404);
    // The edge type came with its constraints, and a note is still no paper.
    await expectRefused(reader, note, papers[0], type);
  }, 240_000);
});
