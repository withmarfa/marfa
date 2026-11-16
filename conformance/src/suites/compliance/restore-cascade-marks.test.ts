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
  for (const [from_id, to_id] of [
    [parent, child],
    [child, grandchild],
  ]) {
    const made = await client.createEdge({
      from_id: from_id!,
      to_id: to_id!,
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
          from_id: parent,
          to_id: child,
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

/** A task parent trashed with a note child and a note grandchild. */
async function taskBin(client: MarfaClient) {
  const made = await client.createItem({
    type: "core.task",
    properties: { title: "parent" },
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  const parent = made.data.item.id;
  const child = await note(client, "child");
  const grandchild = await note(client, "grandchild");
  for (const [from_id, to_id] of [
    [parent, child],
    [child, grandchild],
  ]) {
    const edge = await client.createEdge({
      from_id: from_id!,
      to_id: to_id!,
      edge_type: "parent-of",
    });
    expect(edge.status, JSON.stringify(edge.error)).toBe(201);
  }
  expect((await client.deleteItem(parent)).ok).toBe(true);
  return { parent, child, grandchild };
}

const lineOf = (archive: Uint8Array, id: string) =>
  archiveLines<{ item: Record<string, unknown> }>(archive, "items").find(
    (held) => held.item.id === id,
  )?.item;

describe("a restore of an archive that names an item it does not hold", () => {
  it("holds a child as its own trash when its parent was purged from the bin before the export", async () => {
    const source = working(origin);
    const held = await taskBin(source);
    // The witness: before the purge the export names the parent, and the parent's restore takes the child.
    const whole = await archiveOf(source);
    expect(lineOf(whole, held.child)?.trashed_with).toBe(held.parent);
    expect((await source.purgeItem(held.parent)).ok).toBe(true);
    const archive = await archiveOf(source);
    expect(lineOf(archive, held.parent)).toBeUndefined();
    expect(lineOf(archive, held.child)?.trashed_with).toBe(held.parent);

    const restored = await owner(destination).restoreArchive(archive);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data).toMatchObject({ imported: 2, duplicates: 0 });

    const target = working(destination);
    const child = await stateOf(target, held.child);
    expect(child.state).toBe("trashed");
    expect(child).not.toHaveProperty("trashed_with");
    expect(child).not.toHaveProperty("trashed_by_cascade");
    expect(await stateOf(target, held.grandchild)).not.toHaveProperty(
      "trashed_with",
    );
    expect((await target.restoreItem(held.child)).ok).toBe(true);
    expect((await stateOf(target, held.child)).state).toBe("active");
    expect((await stateOf(target, held.grandchild)).state).toBe("trashed");
  });

  it("holds a child as its own trash when a type filter left its parent out of the export", async () => {
    const source = working(origin);
    const held = await taskBin(source);
    const archive = await source.exportArchive({
      type: "core.note",
      state: "any",
    });
    expect(archive.status).toBe(200);
    expect(lineOf(archive.data, held.parent)).toBeUndefined();
    expect(lineOf(archive.data, held.child)?.trashed_with).toBe(held.parent);

    const restored = await owner(destination).restoreArchive(archive.data);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data).toMatchObject({ imported: 2, duplicates: 0 });
    const child = await stateOf(working(destination), held.child);
    expect(child.state).toBe("trashed");
    expect(child).not.toHaveProperty("trashed_with");
    expect(child).not.toHaveProperty("trashed_by_cascade");
  });

  it("marks a child with a parent the instance holds and the archive leaves out", async () => {
    const source = working(origin);
    const held = await taskBin(source);
    const parents = await source.exportArchive({
      type: "core.task",
      state: "any",
    });
    const children = await source.exportArchive({
      type: "core.note",
      state: "any",
    });
    expect(parents.status).toBe(200);
    expect(children.status).toBe(200);
    expect(lineOf(children.data, held.parent)).toBeUndefined();

    const first = await owner(destination).restoreArchive(parents.data);
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    const second = await owner(destination).restoreArchive(children.data);
    expect(second.status, JSON.stringify(second.error)).toBe(200);
    const target = working(destination);
    const child = await stateOf(target, held.child);
    expect(child.trashed_with).toBe(held.parent);
    expect(child.trashed_by_cascade).toBe(true);

    expect((await target.restoreItem(held.parent)).ok).toBe(true);
    for (const id of [held.parent, held.child, held.grandchild]) {
      expect((await stateOf(target, id)).state, id).toBe("active");
    }
  });

  it("holds an item as its own trash when its line records trashed_by_cascade without trashed_with", async () => {
    const source = working(origin);
    const held = await bin(source);
    const archive = await archiveOf(source);
    // The witness: the line as exported carries both.
    expect(lineOf(archive, held.child)?.trashed_with).toBe(held.parent);
    const damaged = editLineFile(archive, "items", (text) =>
      ndjson(
        text
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => {
            const parsed = JSON.parse(line) as {
              item: Record<string, unknown>;
            };
            if (parsed.item.id === held.child) delete parsed.item.trashed_with;
            return parsed;
          }),
      ),
    );
    expect(lineOf(damaged, held.child)?.trashed_by_cascade).toBe(true);
    expect(lineOf(damaged, held.child)).not.toHaveProperty("trashed_with");

    const restored = await owner(destination).restoreArchive(damaged);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    const target = working(destination);
    const child = await stateOf(target, held.child);
    expect(child.state).toBe("trashed");
    expect(child).not.toHaveProperty("trashed_with");
    expect(child).not.toHaveProperty("trashed_by_cascade");
    expect((await target.restoreItem(held.parent)).ok).toBe(true);
    expect((await stateOf(target, held.child)).state).toBe("trashed");
  });
});

describe("a restore of a part a with-hosts edge took into the bin", () => {
  it("holds the part as trashed with the host the line names, not as a part waiting for its other hosts", async () => {
    const source = working(origin);
    const part = await note(source, "part");
    const first = await note(source, "first host");
    const last = await note(source, "last host");
    for (const to_id of [first, last]) {
      const made = await source.createEdge({
        from_id: part,
        to_id,
        edge_type: "attached-to",
      });
      expect(made.status, JSON.stringify(made.error)).toBe(201);
    }
    expect((await source.deleteItem(first)).ok).toBe(true);
    expect((await stateOf(source, part)).state).toBe("active");
    expect((await source.deleteItem(last)).ok).toBe(true);
    const archive = await archiveOf(source);
    expect(lineOf(archive, part)?.trashed_with).toBe(last);
    // The witness: on the instance that was backed up, either host brings the part back.
    expect((await source.restoreItem(first)).ok).toBe(true);
    expect((await stateOf(source, part)).state).toBe("active");

    const restored = await owner(destination).restoreArchive(archive);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    const target = working(destination);
    expect((await stateOf(target, part)).trashed_with).toBe(last);
    expect((await target.restoreItem(first)).ok).toBe(true);
    expect((await stateOf(target, part)).state).toBe("trashed");
    expect((await target.restoreItem(last)).ok).toBe(true);
    expect((await stateOf(target, part)).state).toBe("active");
  });
});

describe("a restore of an archive whose cascade marks are wrong", () => {
  it.each([
    ["trashed_with", "not an id", "trashed_with", "that is no item ID"],
    ["trashed_with", 7, "trashed_with", "that is no text"],
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
