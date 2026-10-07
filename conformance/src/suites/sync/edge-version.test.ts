import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  cleanup,
} from "../../utils/setup.js";
import { detectSyncCapabilities, requireRule } from "./capabilities.js";
import type { SyncCapabilities } from "./capabilities.js";

/**
 * "A write names the version it read", applied to edges: an edge carries a
 * version, an update names the version it read, and a stale one is refused.
 *
 * An edge without one is the one part of the graph where two devices editing
 * the same row silently lose an edit. It also breaks the client rule that
 * events apply in log order gated by version: a store applies an inbound
 * payload only when its version is not older than the row it holds, and with
 * no version on the payload there is nothing to compare, so a late-arriving
 * event overwrites a newer local edge.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let caps: SyncCapabilities;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "sync",
    "edge-version",
  ));
  caps = await detectSyncCapabilities({ client, ctx, apiUrl, apiKey });
});

afterAll(async () => {
  await cleanup(ctx);
});

interface EdgeEnvelope {
  edge: { id: string; version?: number; properties: Record<string, unknown> };
}

async function makeEdge(): Promise<{
  edge: EdgeEnvelope["edge"];
  sourceId: string;
}> {
  const [source, target] = await Promise.all([
    client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "edge-version-source" },
    }),
    client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "edge-version-target" },
    }),
  ]);
  expect(source.ok && target.ok).toBe(true);
  trackItem(ctx, source.data.item.id);
  trackItem(ctx, target.data.item.id);

  const created = await client.rawRequest<EdgeEnvelope>("/edges", {
    method: "POST",
    body: {
      source_id: source.data.item.id,
      target_id: target.data.item.id,
      edge_type: "about",
      properties: { note: "original" },
    },
  });
  expect(created.ok).toBe(true);
  trackEdge(ctx, created.data.edge.id);
  return { edge: created.data.edge, sourceId: source.data.item.id };
}

describe("edges carry a version", () => {
  it("refuses an update naming a stale version and accepts the current one", async () => {
    requireRule(caps, "edgeVersion");

    const { edge } = await makeEdge();
    expect(typeof edge.version).toBe("number");
    const firstVersion = edge.version!;

    // The control. The same request with the version the client actually read
    // has to succeed, or the refusal below is a route that rejects every
    // versioned update rather than one that rejects stale ones.
    const accepted = await client.rawRequest<EdgeEnvelope>(
      `/edges/${edge.id}`,
      {
        method: "PATCH",
        body: { properties: { note: "first writer" }, version: firstVersion },
      },
    );
    expect(
      accepted.ok,
      `an update naming the current version was refused: ${JSON.stringify(accepted.error)}`,
    ).toBe(true);
    expect(
      accepted.data.edge.version,
      "an accepted edge update did not move the version, so a second writer cannot be detected",
    ).toBeGreaterThan(firstVersion);

    // The second device, which read the edge before the write above landed.
    const stale = await client.rawRequest<EdgeEnvelope>(`/edges/${edge.id}`, {
      method: "PATCH",
      body: { properties: { note: "second writer" }, version: firstVersion },
    });
    expect(
      stale.status,
      "an edge update against a stale version was accepted, so two devices editing one edge silently lose an edit",
    ).toBe(409);

    // The refusal has to carry the edge as it now stands, and this is not a
    // convenience: without the body in the refusal a client holding a stale
    // version has to go and read the edge again before it can rebase, on a
    // round trip the refusal already had the answer for.
    //
    // Under `current`, which is where every `version_conflict` this server
    // answers puts the live row (`edges/update-stale-answer`), rather than
    // under `edge` where the 200 puts it.
    const refused: EdgeEnvelope["edge"] | undefined = (
      stale.data as unknown as { current?: EdgeEnvelope["edge"] }
    ).current;
    expect(
      refused,
      "the refusal carried no edge, so the client it refused cannot rebase its change and there is no route it can call to recover",
    ).toBeDefined();
    expect(
      refused!.version,
      "the refusal reported a version the client could not advance past",
    ).toBe(accepted.data.edge.version);
    expect(
      refused!.properties.note,
      "the refusal reported the edge as the loser already held it rather than as the winner left it",
    ).toBe("first writer");

    const after = await client.getEdge(edge.id);
    expect(after.ok).toBe(true);
    expect(
      after.data.edge.properties.note,
      "the refused write landed anyway, so the 409 was reported without being enforced",
    ).toBe("first writer");
  });

  it("refuses an update naming no version", async () => {
    requireRule(caps, "edgeVersion");

    // The other half of the rule above. A door that refuses a stale version
    // but accepts a request naming none has not closed the hole: a client
    // that simply omits the field gets the blind overwrite back, and the
    // refusal above protects only the callers that were already careful.
    const { edge } = await makeEdge();

    const refused = await client.rawRequest<EdgeEnvelope>(`/edges/${edge.id}`, {
      method: "PATCH",
      body: { properties: { note: "no version named" } },
    });
    expect(
      refused.status,
      `an edge update naming no version was not refused 400: ${JSON.stringify(refused.error ?? refused.data)}`,
    ).toBe(400);
    expect(refused.error?.error.code).toBe("missing_required_field");

    // Read back, because a 400 announced after the write landed protects
    // nothing and every assertion above passes on a server that refuses
    // loudly and writes anyway.
    const after = await client.getEdge(edge.id);
    expect(after.ok).toBe(true);
    expect(
      after.data.edge.properties.note,
      "the refused write reached the stored edge, so the refusal was reported without being enforced",
    ).toBe("original");
    expect(
      after.data.edge.version,
      "a refused edge update moved the version",
    ).toBe(edge.version);
  });
});
