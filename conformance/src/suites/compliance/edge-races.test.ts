/**
 * Concurrent edge requests over HTTP. Each test asserts the set of outcomes
 * the contract allows and never one interleaving of them.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackEdge,
  trackEdgeType,
  trackItem,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";

const ROUNDS = 5;

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "edge-races"));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function note(): Promise<string> {
  const r = await client.createItem(createNote({ source: ctx.source }));
  expect(r.status).toBe(201);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

async function edgesFrom(source: string, edgeType: string) {
  const r = await client.listItemEdges(source, { edge_type: edgeType });
  expect(r.status).toBe(200);
  for (const edge of r.data.data) trackEdge(ctx, edge.id);
  return r.data.data;
}

describe("concurrent edge writes", () => {
  it("lands one of two parents named for the same child", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const child = await note();
      const parents = [await note(), await note()];
      const answers = await Promise.all(
        parents.map((parent) =>
          client.createEdge({
            source_id: parent,
            target_id: child,
            edge_type: "parent-of",
          }),
        ),
      );
      for (const r of answers) {
        if (r.ok) trackEdge(ctx, r.data.edge.id);
      }

      expect(answers.map((r) => r.status).sort(), `round ${round}`).toEqual([
        201, 400,
      ]);
      const refused = answers.find((r) => !r.ok);
      expect(refused?.error?.error.code).toBe("edge_constraint_violation");
      expect(refused?.error?.error.details?.constraint).toBe("cardinality");

      const held = await client.listItemBackrefs(child, {
        edge_type: "parent-of",
      });
      expect(held.status).toBe(200);
      expect(held.data.data).toHaveLength(1);
      const landed = answers.find((r) => r.ok);
      expect(held.data.data[0]?.id).toBe(landed?.data?.edge.id);
    }
  });

  it("lands one of two creates of the same triple", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const source = await note();
      const target = await note();
      const answers = await Promise.all(
        [0, 1].map(() =>
          client.createEdge({
            source_id: source,
            target_id: target,
            edge_type: "about",
          }),
        ),
      );
      for (const r of answers) {
        if (r.ok) trackEdge(ctx, r.data.edge.id);
      }

      expect(answers.map((r) => r.status).sort(), `round ${round}`).toEqual([
        201, 400,
      ]);
      const refused = answers.find((r) => !r.ok);
      expect(refused?.error?.error.code).toBe("edge_constraint_violation");
      expect(refused?.error?.error.details?.constraint).toBe("duplicate");
      expect(await edgesFrom(source, "about")).toHaveLength(1);
    }
  });

  it("lands one of two updates naming the same version", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const source = await note();
      const target = await note();
      const created = await client.createEdge({
        source_id: source,
        target_id: target,
        edge_type: "about",
        properties: { note: "original" },
      });
      expect(created.status).toBe(201);
      trackEdge(ctx, created.data.edge.id);
      const id = created.data.edge.id;

      const answers = await Promise.all(
        ["first", "second"].map((text) =>
          client.updateEdge(id, {
            properties: { note: text },
            version: created.data.edge.version,
          }),
        ),
      );
      const label = `round ${round}`;
      expect(answers.map((r) => r.status).sort(), label).toEqual([200, 409]);
      const landed = answers.find((r) => r.ok);
      const refused = answers.find((r) => !r.ok);
      expect(refused?.error?.error.code, label).toBe("version_conflict");

      const stored = await client.getEdge(id);
      expect(stored.data.edge.version, label).toBe(2);
      expect(stored.data.edge.properties, label).toEqual(
        landed?.data.edge.properties,
      );
      const current = (
        refused?.error as unknown as {
          current: { version: number; properties: Record<string, unknown> };
        }
      ).current;
      expect(current.version, label).toBe(2);
      expect(current.properties, label).toEqual(stored.data.edge.properties);
    }
  });

  it("stores one edge when two bulk pages carry the same triple", async () => {
    for (const atomic of [true, false]) {
      for (const mode of ["upsert", "create_only"] as const) {
        for (let round = 0; round < ROUNDS; round += 1) {
          const source = await note();
          const target = await note();
          const label = `atomic ${String(atomic)}, ${mode}, round ${round}`;
          const answers = await Promise.all(
            [0, 1].map(() =>
              client.bulkEdges({
                atomic,
                mode,
                edges: [
                  {
                    source_id: source,
                    target_id: target,
                    edge_type: "about",
                  },
                ],
              }),
            ),
          );
          for (const r of answers) {
            expect(r.status, label).toBe(200);
          }

          const outcomes = answers
            .map((r) => r.data.results[0]?.outcome)
            .sort();
          expect(outcomes, label).toEqual(
            mode === "upsert" ? ["created", "updated"] : ["created", "skipped"],
          );
          const stored = await edgesFrom(source, "about");
          expect(stored, label).toHaveLength(1);
          for (const r of answers) {
            expect(r.data.results[0]?.id, label).toBe(stored[0]?.id);
          }
        }
      }
    }
  });

  it("either keeps an edge type with its new edge or deletes it and refuses the edge", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const edgeType = `mock.race-${String(round)}.${ctx.runId}`;
      const registered = await client.registerEdgeType({
        id: edgeType,
        cardinality: "many-to-many",
      });
      expect(registered.status).toBe(201);
      trackEdgeType(ctx, edgeType);
      const source = await note();
      const target = await note();

      const remove = () => client.deleteEdgeType(edgeType);
      const create = () =>
        client.createEdge({
          source_id: source,
          target_id: target,
          edge_type: edgeType,
        });
      // Which request leaves first alternates, so both orders get a chance.
      const sent =
        round % 2 === 0
          ? { removal: remove(), creation: create() }
          : { creation: create(), removal: remove() };
      const [removal, creation] = await Promise.all([
        sent.removal,
        sent.creation,
      ]);
      if (creation.ok) trackEdge(ctx, creation.data.edge.id);

      const types = await client.listEdgeTypes();
      const registeredNow = types.data.data.some((t) => t.id === edgeType);
      const stored = await edgesFrom(source, edgeType);
      const label = `round ${round}: delete ${String(removal.status)}, create ${String(creation.status)}`;

      if (creation.status === 201) {
        expect(removal.status, label).toBe(409);
        expect(removal.error?.error.code, label).toBe("edge_type_in_use");
        expect(registeredNow, label).toBe(true);
        expect(stored, label).toHaveLength(1);
      } else {
        expect(removal.status, label).toBe(200);
        expect(creation.status, label).toBe(404);
        expect(creation.error?.error.code, label).toBe("edge_type_not_found");
        expect(registeredNow, label).toBe(false);
        expect(stored, label).toHaveLength(0);
      }
    }
  });
});
