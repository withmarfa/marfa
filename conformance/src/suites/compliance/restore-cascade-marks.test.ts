import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { archiveLines, editLineFile, ndjson } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * A real round trip on throwaway servers: a parent is trashed with the
 * children a cascade takes, the archive is exported, and a fresh server
 * restores it. What the archive records of the cascade decides what the
 * parent's restore from the bin brings back.
 */
let origin: FreshServer;
let destination: FreshServer;
beforeEach(async () => {
  [origin, destination] = await Promise.all([
    bootFreshServer("cascade-marks-origin"),
    bootFreshServer("cascade-marks-destination"),
  ]);
}, 2 * FRESH_SERVER_TIMEOUT_MS);
afterEach(async () => {
  await Promise.all([origin?.stop(), destination?.stop()]);
}, FRESH_SERVER_TIMEOUT_MS);

const working = (server: FreshServer) =>
  new MarfaClient({ baseUrl: server.apiUrl, apiKey: server.workingKey });
const owner = (server: FreshServer) =>
  new MarfaClient({
    baseUrl: server.apiUrl,
    controlSocket: server.controlSocket,
  });

async function note(client: MarfaClient, body: string): Promise<string> {
  const made = await client.createItem({
    type: "core.note",
    properties: { body },
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return made.data.item.id;
}

async function stateOf(client: MarfaClient, id: string) {
  const read = await client.getItem(id, "any");
  expect(read.status, JSON.stringify(read.error)).toBe(200);
  return read.data.item;
}

/** A parent trashed with a child and a grandchild, and a note trashed alone. */
async function bin(client: MarfaClient) {
  const parent = await note(client, "parent");
  const child = await note(client, "child");
  const grandchild = await note(client, "grandchild");
  const alone = await note(client, "alone");
  for (const [source_id, target_id] of [
    [parent, child],
    [child, grandchild],
  ]) {
    const made = await client.createEdge({
      source_id: source_id!,
      target_id: target_id!,
      edge_type: "parent-of",
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
  }
  expect((await client.deleteItem(alone)).ok).toBe(true);
  expect((await client.deleteItem(parent)).ok).toBe(true);
  return { parent, child, grandchild, alone };
}

async function archiveOf(client: MarfaClient) {
  const exported = await client.exportArchive({ state: "any" });
  expect(
    exported.status,
    Buffer.from(exported.data).toString().slice(0, 500),
  ).toBe(200);
  return exported.data;
}

describe("a restore of items a cascade trashed", () => {
  it("brings the children back with their parent after a restore into a fresh server, as on the instance that was backed up", async () => {
    const source = working(origin);
    const held = await bin(source);

    // The witness: the instance that was backed up brings the children back
    // with the parent, and leaves the note trashed alone where it is.
    const archive = await archiveOf(source);
    expect((await source.restoreItem(held.parent)).ok).toBe(true);
    expect((await stateOf(source, held.child)).state).toBe("active");
    expect((await stateOf(source, held.grandchild)).state).toBe("active");
    expect((await stateOf(source, held.alone)).state).toBe("trashed");

    const restored = await owner(destination).restoreArchive(archive);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data).toMatchObject({ imported: 4, duplicates: 0 });

    const target = working(destination);
    for (const id of [held.child, held.grandchild]) {
      const marked = await stateOf(target, id);
      expect(marked.state).toBe("trashed");
      expect(marked.trashed_by_cascade).toBe(true);
    }
    expect((await stateOf(target, held.child)).trashed_with).toBe(held.parent);
    const alone = await stateOf(target, held.alone);
    expect(alone).not.toHaveProperty("trashed_with");
    expect(alone).not.toHaveProperty("trashed_by_cascade");

    expect((await target.restoreItem(held.parent)).ok).toBe(true);
    for (const id of [held.parent, held.child, held.grandchild]) {
      const back = await stateOf(target, id);
      expect(back.state, id).toBe("active");
      expect(back).not.toHaveProperty("trashed_with");
      expect(back).not.toHaveProperty("trashed_by_cascade");
    }
    expect((await stateOf(target, held.alone)).state).toBe("trashed");
  });

  it("skips an item the instance already holds and leaves it as it is", async () => {
    const source = working(origin);
    const parent = await note(source, "parent");
    const child = await note(source, "child");
    expect(
      (
        await source.createEdge({
          source_id: parent,
          target_id: child,
          edge_type: "parent-of",
        })
      ).status,
    ).toBe(201);
    const whole = await archiveOf(source);
    expect((await source.deleteItem(parent)).ok).toBe(true);
    const binned = await archiveOf(source);
    // The witness: the second archive records the child as trashed with the parent.
    const line = archiveLines<{ item: Record<string, unknown> }>(
      binned,
      "items",
    ).find((held) => held.item.id === child);
    expect(line?.item.trashed_with).toBe(parent);

    const target = working(destination);
    const first = await owner(destination).restoreArchive(whole);
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    const second = await owner(destination).restoreArchive(binned);
    expect(second.status, JSON.stringify(second.error)).toBe(200);
    expect(second.data).toMatchObject({ imported: 0, duplicates: 2 });
    for (const id of [parent, child]) {
      const held = await stateOf(target, id);
      expect(held.state).toBe("active");
      expect(held).not.toHaveProperty("trashed_with");
    }
  });
});

describe("a restore of an archive whose cascade marks are wrong", () => {
  it.each([
    ["trashed_with", "not an id", "trashed_with", "that is no item ID"],
    ["trashed_with", 7, "trashed_with", "that is no text"],
    [
      "trashed_with",
      "01a1da77-dc43-7355-8516-a07ece14b904",
      "trashed_with",
      "that names an item the archive does not hold",
    ],
    ["trashed_by_cascade", "yes", "trashed_by_cascade", "that is no boolean"],
    [
      "trashed_by_cascade",
      false,
      "trashed_by_cascade",
      "that says an item was not trashed by a cascade",
    ],
  ])(
    "refuses an item line whose %s is %j, %s, naming the line and the field, and writes nothing",
    async (key, value, field, _why) => {
      const source = working(origin);
      const held = await bin(source);
      const archive = await archiveOf(source);
      const marked = (line: { item: Record<string, unknown> }) =>
        line.item.id === held.child;
      const damaged = editLineFile(archive, "items", (text) =>
        ndjson(
          text
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => {
              const parsed = JSON.parse(line) as {
                item: Record<string, unknown>;
              };
              if (marked(parsed)) parsed.item[key] = value;
              return parsed;
            }),
        ),
      );

      const refused = await owner(destination).restoreArchive(damaged);
      expect(refused.status, JSON.stringify(refused.error)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(refused.error?.error.details?.field).toBe(field);
      expect(refused.error?.error.details?.item_id).toBe(held.child);
      expect(
        (await working(destination).getItem(held.child, "any")).status,
      ).toBe(404);

      // The witness: the archive as exported restores, so the refusal above
      // is the marks' and nothing else's.
      const plain = await owner(destination).restoreArchive(archive);
      expect(plain.status, JSON.stringify(plain.error)).toBe(200);
      expect(plain.data.imported).toBe(4);
    },
  );
});
