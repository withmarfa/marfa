import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";

/**
 * A type below another can hold what its chain would refuse: a build that
 * ships a field, a status word or a thumbnail above it leaves the registered
 * type below in conflict, a state the registration doors refuse and so cannot
 * produce.
 *
 * **Arranged in the stored file, on a server of its own.** Each case registers
 * two sibling parents that agree, a middle type under the first and a leaf
 * under the middle with a harmless field, stops the server, rewrites the leaf's
 * stored fields to the conflicting ones, and boots the server on that file.
 * What is asserted is what the instance then answers to a replacement of the
 * middle type.
 */
let server: FreshServer | undefined;
let client: MarfaClient;

interface Case {
  name: string;
  parentFields: Record<string, unknown>;
  held: Record<string, unknown>;
  declaresItself: Record<string, unknown>;
  refusedAs: string;
}

const CASES: Case[] = [
  {
    name: "a field in another shape",
    parentFields: { count: { type: "integer" } },
    held: { count: { type: "string" } },
    declaresItself: { count: { type: "integer" } },
    refusedAs: "inheritance_violation",
  },
  {
    name: "a status word the parents give",
    parentFields: {
      stage: {
        type: "status",
        status_values: [{ value: "open", group: "not_started" }],
      },
    },
    held: {
      stage: {
        type: "status",
        status_values: [{ value: "open", group: "completed" }],
      },
    },
    declaresItself: {
      stage: {
        type: "status",
        status_values: [{ value: "waiting", group: "in_progress" }],
      },
    },
    refusedAs: "inheritance_violation",
  },
  {
    name: "a second thumbnail",
    parentFields: { picture: { type: "thumbnail" } },
    held: { preview: { type: "thumbnail" } },
    declaresItself: { picture: { type: "thumbnail" } },
    refusedAs: "invalid_schema",
  },
];

const NAMED = CASES.map((held, index) => [held.name, index] as const);

const ids = (index: number) => {
  const first = `standing${String(index)}.first`;
  return {
    first,
    second: `standing${String(index)}.second`,
    middle: `standing${String(index)}.middle`,
    leaf: `standing${String(index)}.middle.leaf`,
  };
};

beforeAll(async () => {
  server = await bootFreshServer("type-standing-conflicts");
  const arranging = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  for (const [index, held] of CASES.entries()) {
    const { first, second, middle, leaf } = ids(index);
    for (const parent of [first, second]) {
      const made = await arranging.registerType({
        id: parent,
        fields: held.parentFields as never,
      });
      expect(made.status, JSON.stringify(made.error)).toBe(201);
    }
    expect(
      (
        await arranging.registerType({
          id: middle,
          parent: first,
          fields: {},
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await arranging.registerType({
          id: leaf,
          parent: middle,
          fields: { spare: { type: "string" } },
        })
      ).status,
    ).toBe(201);
  }
  await server.restart(() => {
    for (const [index, held] of CASES.entries()) {
      const changed = withInstanceDatabase(server!.sqlitePath, (db) => {
        const row = db
          .prepare("SELECT definition FROM types WHERE id = ?")
          .get(ids(index).leaf) as { definition: string };
        const definition = JSON.parse(row.definition) as {
          fields: Record<string, unknown>;
        };
        definition.fields = held.held;
        return db
          .prepare("UPDATE types SET definition = ? WHERE id = ?")
          .run(JSON.stringify(definition), ids(index).leaf);
      });
      expect(Number(changed.changes)).toBe(1);
    }
  });
  client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

describe("a replacement of a type above one that holds what its chain would refuse", () => {
  it.each(NAMED)(
    "takes a move between parents that give the same, and a relabel, for %s",
    async (_name, index) => {
      const { first, second, middle, leaf } = ids(index);
      const held = CASES[index]!;
      // The witness: the same declaration, sent through the door, is refused.
      const sent = await client.registerType({
        id: `${leaf}-again`,
        parent: middle,
        fields: held.held as never,
      });
      expect(
        sent.status,
        "the door took the conflict, so the fixture does not show a conflict that stands",
      ).toBe(400);

      const moved = await client.replaceType(middle, {
        parent: second,
        label: "Moved",
        fields: {},
      });
      expect(moved.status, JSON.stringify(moved.error)).toBe(200);
      const back = await client.replaceType(middle, {
        parent: first,
        fields: {},
      });
      expect(back.status, JSON.stringify(back.error)).toBe(200);
    },
  );

  it.each(NAMED)(
    "refuses a replacement that declares what the type below holds, for %s",
    async (_name, index) => {
      const { first, middle } = ids(index);
      const held = CASES[index]!;
      const refused = await client.replaceType(middle, {
        parent: first,
        fields: held.declaresItself as never,
      });
      expect(refused.status).toBe(400);
      expect(refused.error?.error.code).toBe(held.refusedAs);
    },
  );
});
