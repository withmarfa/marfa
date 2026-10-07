import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { detectSyncCapabilities, requireRule } from "./capabilities.js";
import type { SyncCapabilities } from "./capabilities.js";

/**
 * "A modification time moves when the item changes": every reconnect runs an
 * incremental catch-up before resuming the stream, bounded by that time.
 *
 * The catch-up exists because a cursor the log no longer serves leaves a
 * client with nothing to resume from. Reading everything modified since the
 * last pass closes that gap — but only if "modified" means what a client
 * thinks it means. Tags and extensions live in a sidecar table, and a
 * server that writes the sidecar without moving the item's modification time
 * makes a metadata change invisible to this read. What comes back is a short
 * list that looks complete: nothing errors, and the client believes it is
 * caught up.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let caps: SyncCapabilities;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "sync",
    "catchup",
  ));
  caps = await detectSyncCapabilities({ client, ctx, apiUrl, apiKey });
});

afterAll(async () => {
  await cleanup(ctx);
});

async function idsModifiedSince(boundary: string): Promise<Set<string>> {
  const response = await client.rawRequest<{ data?: Array<{ id: string }> }>(
    `/items?source=${encodeURIComponent(ctx.source)}&limit=100&updated_after=${encodeURIComponent(boundary)}`,
  );
  if (!response.ok) {
    throw new Error(
      `the catch-up read was refused (${String(response.status)}): ${JSON.stringify(response.error)}`,
    );
  }
  return new Set((response.data.data ?? []).map((i) => i.id));
}

describe("the modification time a catch-up reads", () => {
  it("moves when a tag is written, not only when a property is", async () => {
    // The read this rule serves is bounded by modification time, so a tag
    // write that does not move it makes the whole catch-up blind to metadata
    // — and the read still answers 200 with a short list that looks complete.
    // Checking the bump directly is what catches that, whatever the catch-up
    // filter itself does with the bound.
    const tagged = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "updated-at-tagged" },
    });
    const untouched = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "updated-at-untouched" },
    });
    expect(tagged.ok && untouched.ok).toBe(true);
    trackItem(ctx, tagged.data.item.id);
    trackItem(ctx, untouched.data.item.id);

    const before = tagged.data.item.updated_at;
    const controlBefore = untouched.data.item.updated_at;
    expect(
      typeof before,
      "the create response carried no modification time to compare against",
    ).toBe("string");

    // A second of separation, because the column can be stored at a coarser
    // resolution than the writes are made at. Without it a bump and no bump
    // are the same value and the assertion below passes either way.
    await new Promise((r) => setTimeout(r, 1100));

    const tag = await client.updateMetadata(tagged.data.item.id, {
      tags: ["catchup-updated-at"],
    });
    expect(
      tag.ok,
      `could not write the tag under test: ${JSON.stringify(tag.error)}`,
    ).toBe(true);

    const [after, control] = await Promise.all([
      client.getItem(tagged.data.item.id),
      client.getItem(untouched.data.item.id),
    ]);
    expect(after.ok && control.ok).toBe(true);

    // The control. A server that restamped every row on read, or a clock that
    // moved under the test, would satisfy the assertion below without the tag
    // write having done anything.
    expect(
      control.data.item.updated_at,
      "an item nobody touched changed its modification time, so a change to the tagged item proves nothing",
    ).toBe(controlBefore);

    expect(
      Date.parse(after.data.item.updated_at ?? ""),
      "a tag write left the item's modification time where it was, so a catch-up bounded by that time never sees the tag and returns a short list that looks complete",
    ).toBeGreaterThan(Date.parse(before ?? ""));
  });
});

describe("every tag operation moves the modification time", () => {
  it("moves updated_at on every tag operation", async () => {
    const tagged = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "updated-at-each-operation" },
    });
    const untouched = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "updated-at-each-control" },
    });
    expect(tagged.ok && untouched.ok).toBe(true);
    trackItem(ctx, tagged.data.item.id);
    trackItem(ctx, untouched.data.item.id);
    const id = tagged.data.item.id;

    const operations = [
      {
        name: "POST /items/{id}/tags",
        send: () =>
          client.rawRequest(`/items/${id}/tags`, {
            method: "POST",
            body: { tags: ["first"] },
          }),
      },
      {
        name: "DELETE /items/{id}/tags/{tag}",
        send: () => client.removeTag(id, "first"),
      },
      {
        name: "PUT /items/{id}/metadata",
        send: () =>
          client.rawRequest(`/items/${id}/metadata`, {
            method: "PUT",
            body: { tags: ["replaced"] },
          }),
      },
    ];

    const controlBefore = untouched.data.item.updated_at;
    let last = tagged.data.item.updated_at;
    for (const { name, send } of operations) {
      // The column can be stored at a coarser resolution than the writes are
      // made at, so a bump and no bump are the same value without this.
      await new Promise((r) => setTimeout(r, 1100));
      const written = await send();
      expect(
        written.ok,
        `${name} was refused: ${JSON.stringify(written.error)}`,
      ).toBe(true);
      const read = await client.getItem(id);
      expect(read.ok).toBe(true);
      expect(
        Date.parse(read.data.item.updated_at ?? ""),
        `${name} left the item's modification time where it was`,
      ).toBeGreaterThan(Date.parse(last ?? ""));
      last = read.data.item.updated_at;
    }

    const control = await client.getItem(untouched.data.item.id);
    expect(
      control.data.item.updated_at,
      "an item nobody touched changed its modification time, so a change to the tagged item proves nothing",
    ).toBe(controlBefore);
  });
});

describe("incremental catch-up", () => {
  it("sees a tag written after the boundary, not just a property change", async () => {
    requireRule(caps, "updatedAfter");

    // Two items created together. One is touched after the boundary and one
    // is not, so the read has something to exclude as well as something to
    // find — a filter that returns everything cannot pass.
    const tagged = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "catchup-tagged" },
    });
    const untouched = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "catchup-untouched" },
    });
    expect(tagged.ok && untouched.ok).toBe(true);
    trackItem(ctx, tagged.data.item.id);
    trackItem(ctx, untouched.data.item.id);

    // The boundary a reconnecting client would carry. A second of slack
    // absorbs clock skew between the runner and the server; the assertion
    // does not depend on the exact instant, only on the tag write landing
    // after it.
    await new Promise((r) => setTimeout(r, 1100));
    const boundary = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 1100));

    const tag = await client.updateMetadata(tagged.data.item.id, {
      tags: ["catchup-probe"],
    });
    expect(
      tag.ok,
      `could not write the tag under test: ${JSON.stringify(tag.error)}`,
    ).toBe(true);

    const ids = await idsModifiedSince(boundary);

    // The control. An item nobody touched after the boundary must be absent,
    // or the read is returning the whole listing and the assertion below is
    // satisfied by a filter that does nothing.
    expect(
      ids.has(untouched.data.item.id),
      "an item that was not modified after the boundary came back, so the bound is not being applied",
    ).toBe(false);

    expect(
      ids.has(tagged.data.item.id),
      "a tag write did not move the item's modification time, so an incremental catch-up is blind to metadata and returns a short list that looks complete",
    ).toBe(true);
  });

  it("reads across every lifecycle state in one pass", async () => {
    requireRule(caps, "stateAny");

    // A client re-importing has to see trashed rows too: a row it holds as
    // active and the server holds as trashed is a row it will never correct
    // if the read cannot return it.
    const active = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "catchup-state-active" },
    });
    const trashed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "catchup-state-trashed" },
    });
    expect(active.ok && trashed.ok).toBe(true);
    trackItem(ctx, active.data.item.id);
    trackItem(ctx, trashed.data.item.id);
    const deleted = await client.deleteItem(trashed.data.item.id);
    expect(deleted.ok).toBe(true);

    const anyState = await client.rawRequest<{ data?: Array<{ id: string }> }>(
      `/items?source=${encodeURIComponent(ctx.source)}&limit=100&state=any`,
    );
    expect(
      anyState.ok,
      `state=any was refused (${anyState.status}), so a re-import cannot read the whole dataset in one pass`,
    ).toBe(true);
    const ids = new Set((anyState.data.data ?? []).map((i) => i.id));

    expect(
      ids.has(active.data.item.id),
      "an active row was missing from a state=any read",
    ).toBe(true);
    expect(
      ids.has(trashed.data.item.id),
      "a trashed row was missing from a state=any read, so a client cannot learn that a row it holds as active has been trashed",
    ).toBe(true);
  });
});
