import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createKeysModeFixture, type KeysModeFixture } from "./test-harness.js";

/**
 * `client.items.getDetail` — the bundled single-item read. Proves the SDK
 * surfaces the envelope (`metadata`, outbound `edges`, opt-in `backrefs` /
 * `neighbors` / `versions`) that the lean `get` discards, against a real
 * in-process server.
 */

let fx: KeysModeFixture;

beforeAll(async () => {
  fx = await createKeysModeFixture();
});

afterAll(() => {
  fx.cleanup();
});

describe("items.getDetail", () => {
  it("returns the base envelope (item + metadata + outbound edges) without include", async () => {
    const { client } = fx;
    const parent = await client.items.create({
      type: "core.note",
      properties: { body: "root" },
      tags: ["root-tag"],
    });
    const child = await client.items.create({
      type: "core.note",
      properties: { body: "child" },
    });
    await client.edges.create({
      source_id: parent.id,
      target_id: child.id,
      edge_type: "parent-of",
    });

    const detail = await client.items.getDetail(parent.id);
    expect(detail.item.id).toBe(parent.id);
    expect(detail.metadata.tags).toEqual(["root-tag"]);
    expect(detail.item.edges?.["parent-of"]?.edges.length).toBe(1);
    // Opt-in blocks absent unless requested.
    expect(detail.backrefs).toBeUndefined();
    expect(detail.neighbors).toBeUndefined();
    expect(detail.versions).toBeUndefined();
  });

  it("hydrates backrefs, neighbors and versions when requested", async () => {
    const { client } = fx;
    const parent = await client.items.create({
      type: "core.note",
      properties: { body: "thread" },
    });
    const child = await client.items.create({
      type: "core.note",
      properties: { body: "child" },
    });
    const comment = await client.items.create({
      type: "core.note",
      properties: { body: "comment" },
    });
    await client.edges.create({
      source_id: parent.id,
      target_id: child.id,
      edge_type: "parent-of",
    });
    await client.edges.create({
      source_id: comment.id,
      target_id: parent.id,
      edge_type: "in-thread",
    });
    // A historical version snapshot is written on update, not on the initial
    // create — bump the item once so `versions` has something to return.
    await client.items.update(
      parent.id,
      { body: "thread v2" },
      { expectedVersion: parent.version },
    );

    const detail = await client.items.getDetail(parent.id, {
      include: ["backrefs", "neighbors", "versions"],
    });
    // Outbound + inbound edges.
    expect(detail.item.edges?.["parent-of"]?.edges.length).toBe(1);
    expect(detail.backrefs?.["in-thread"]?.edges.length).toBe(1);
    // Both neighbors hydrated as full { item, metadata }.
    const neighborIds = (detail.neighbors ?? []).map((n) => n.item.id).sort();
    expect(neighborIds).toEqual([child.id, comment.id].sort());
    // A small neighbourhood is complete, not truncated.
    expect(detail.neighbors_truncated).toBe(false);
    // Versions present.
    expect((detail.versions ?? []).length).toBeGreaterThanOrEqual(1);
  });
});
