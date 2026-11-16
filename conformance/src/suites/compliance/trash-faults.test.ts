import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * A trash that fails after it has begun to move items. `fail:audit=items.trash`
 * fails the statement that records the trash's audit entry, after the write
 * has begun on the items, so a trash that is not whole is one the fault
 * shows.
 *
 * **Why a server of its own.** A fault acts on any caller's next write of its
 * action, so on the run's shared server it could fail another file's trash.
 */
let server: FreshServer;
let working: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("trash-faults");
  working = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterEach(async () => {
  await server.clearFault();
});

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

async function note(body: string): Promise<string> {
  const made = await working.createItem({
    type: "core.note",
    properties: { body },
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return made.data.item.id;
}

/** Two items, each with a child its trash takes with it. */
async function parents(label: string) {
  const named: string[] = [];
  const all: string[] = [];
  for (const which of ["first", "second"]) {
    const parent = await note(`${label} ${which} parent`);
    const child = await note(`${label} ${which} child`);
    const edge = await working.createEdge({
      from_id: parent,
      to_id: child,
      edge_type: "parent-of",
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
    named.push(parent);
    all.push(parent, child);
  }
  return { named, all };
}

async function states(ids: string[]): Promise<number[]> {
  return Promise.all(ids.map(async (id) => (await working.getItem(id)).status));
}

describe("POST /items/trash when the trash fails", () => {
  it("leaves every named item and the children their trash takes as they were when the trash fails, and trashes them all without the fault", async () => {
    const { named, all } = await parents("rest");
    const preview = await working.previewItemTrash(named);
    expect(preview.status).toBe(200);

    await server.setFault("fail:audit=items.trash");
    const failed = await working.trashItems(named, preview.data.digest);
    expect(failed.status).toBe(500);
    // The witness that the fault acted on the trash, once.
    expect(
      (await server.faults()).find((fault) => fault.name === "fail:audit")
        ?.fired,
    ).toBe(1);
    expect(await states(all)).toEqual([200, 200, 200, 200]);
    for (const id of all) {
      expect((await working.getItem(id)).data.item.state).toBe("active");
    }

    // The witness: the same trash, with the fault gone, takes all four.
    await server.clearFault();
    const trashed = await working.trashItems(named, preview.data.digest);
    expect(trashed.status, JSON.stringify(trashed.error)).toBe(200);
    expect(await states(all)).toEqual([404, 404, 404, 404]);
  });
});
