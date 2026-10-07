import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  getOperatorClient,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import { createNote, generateId } from "../../generators/items.js";
import {
  approvedAppToken,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
} from "../../utils/fresh-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

/**
 * A key may claim sources besides its own, and a write may name one it
 * claims (`keys-and-oauth.md` 34, `items/source-claimed`).
 *
 * The natural key is `(source, source_id)` and a key's own source is no other
 * unrevoked key's own, so two keys writing under their own sources never
 * present one natural key: the same file in one folder on two machines
 * would be two items. A claim is how they share one. Every claim here is
 * built from this file's own source, so the rows it writes stay the file's.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let operator: MarfaClient;
/** The source the keys below share, which no key holds as its own. */
let folder: string;
/** A second source nothing in this file is given, for the refusals. */
let elsewhere: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "claimed-sources",
  ));
  operator = getOperatorClient();
  folder = `${ctx.source}-folder`;
  elsewhere = `${ctx.source}-elsewhere`;
});

afterAll(async () => {
  await cleanup(ctx);
});

/**
 * A key the operator mints with write on notes, `keys.mint`, and the claims
 * named. The operator may grant any source, which is how a claim reaches a
 * key in this file at all.
 */
async function claimingKey(
  label: string,
  sources: readonly string[],
): Promise<{ client: MarfaClient; id: string; source: string }> {
  const source = `${ctx.source}-${label}`;
  const minted = await operator.createKey({
    label,
    source,
    sources,
    type_permissions: { "core.note": "write" },
    permissions: ["keys.mint"],
  });
  expect(
    minted.status,
    `the operator could not mint a key claiming [${sources.join(", ")}], so nothing below holds the claim it writes under`,
  ).toBe(201);
  trackKey(ctx, minted.data.id);
  return {
    client: new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key }),
    id: minted.data.id,
    source,
  };
}

describe("a write naming a source", () => {
  it("writes under a source the key claims, and the row carries it", async () => {
    const writer = await claimingKey("writer", [folder]);
    const written = await writer.client.createItem(
      createNote({ source: folder, source_id: `claimed-${ctx.runId}` }),
    );
    expect(
      written.status,
      "a create naming a source its key claims was not written",
    ).toBe(201);
    trackItem(ctx, written.data.item.id);
    expect(
      written.data.item.source,
      "the row does not carry the source the write named, so its natural key is the credential's and no other key can share it",
    ).toBe(folder);
    const read = await client.getItem(written.data.item.id);
    expect(read.ok, "the row the create answered cannot be read back").toBe(
      true,
    );
    expect(
      read.data.item.source,
      "the stored row does not carry the source the create answered with",
    ).toBe(folder);

    // The witness. The same key naming no source writes under its own, so
    // the row above carries the claim because the write named it.
    const own = await writer.client.createItem(createNote());
    expect(own.status, "a create naming no source was not written").toBe(201);
    trackItem(ctx, own.data.item.id);
    expect(
      own.data.item.source,
      "a create naming no source was not stamped with the key's own",
    ).toBe(writer.source);
  });

  it("refuses a source the key does not claim, naming it", async () => {
    const stranger = await claimingKey("stranger", []);
    const sourceId = `unclaimed-${ctx.runId}`;
    const refused = await stranger.client.createItem(
      createNote({ source: folder, source_id: sourceId }),
    );
    expect(
      refused.status,
      "a create naming a source its key does not claim was accepted, so any key can write rows that read as another's",
    ).toBe(403);
    expect(
      refused.error?.error.code,
      "the refusal is not the one a permission the caller lacks answers",
    ).toBe("forbidden");
    expect(
      refused.error?.error.details?.source,
      "the refusal does not name the source, so the caller cannot tell which one it may not write under",
    ).toBe(folder);
    await expectMatchesSchema("POST", "/items", 403, refused.error);

    // Nothing was written under the source, and the proof is a key that
    // may write there: the same natural key is a new row for it, where a
    // row the refusal left behind would have answered an upsert.
    const claimer = await claimingKey("stranger-witness", [folder]);
    const fresh = await claimer.client.createItem(
      createNote({ source: folder, source_id: sourceId }),
    );
    expect(
      fresh.status,
      "the refused create left a row under the source it was refused, which a key claiming the source has now written over",
    ).toBe(201);
    trackItem(ctx, fresh.data.item.id);

    // The witness. The same body under the key's own source lands, so the
    // refusal above is the source and not the write.
    const own = await stranger.client.createItem(
      createNote({ source: stranger.source, source_id: sourceId }),
    );
    expect(
      own.status,
      "the same create under the key's own source was not written, so the refusal above says nothing about the source",
    ).toBe(201);
    trackItem(ctx, own.data.item.id);
    expect(own.data.item.source).toBe(stranger.source);
  });

  it("upserts onto one row from two keys claiming one source", async () => {
    const first = await claimingKey("first-machine", [folder]);
    const second = await claimingKey("second-machine", [folder]);
    const sourceId = `shared-${ctx.runId}`;

    const created = await first.client.createItem(
      createNote({
        source: folder,
        source_id: sourceId,
        properties: { title: "shared", body: "written on the first machine" },
      }),
    );
    expect(
      created.status,
      "the first key's create under the shared source was not written",
    ).toBe(201);
    trackItem(ctx, created.data.item.id);

    const upserted = await second.client.createItem(
      createNote({
        source: folder,
        source_id: sourceId,
        properties: { title: "shared", body: "written on the second machine" },
      }),
    );
    expect(
      upserted.status,
      "the second key's create under the shared source made a row of its own, so one file on two machines is two items",
    ).toBe(200);
    expect(
      upserted.data.item.id,
      "the second key's create landed on another row than the first key's",
    ).toBe(created.data.item.id);
    expect(
      upserted.data.item.version,
      "the upsert did not advance the version, so a device holding the first write cannot tell it was overwritten",
    ).toBe(created.data.item.version + 1);
    expect(
      upserted.data.item.properties.body,
      "the upsert answered the row without the second key's properties",
    ).toBe("written on the second machine");

    // The witness. The same `source_id` under the second key's own source is
    // another natural key and a new row, so what joined the two writes above
    // is the source they share.
    const apart = await second.client.createItem(
      createNote({ source_id: sourceId }),
    );
    expect(
      apart.status,
      "the same source_id under the key's own source was not a new row",
    ).toBe(201);
    trackItem(ctx, apart.data.item.id);
    expect(
      apart.data.item.id,
      "a write under the key's own source landed on the shared row, so the upsert above is not the claim's doing",
    ).not.toBe(created.data.item.id);
  });

  it("lands a bulk entry naming a claim on the claim's row, not on its own source's", async () => {
    const first = await claimingKey("bulk-first", [folder]);
    const second = await claimingKey("bulk-second", [folder]);
    const sourceId = `bulk-shared-${ctx.runId}`;

    const claimed = await first.client.createItem(
      createNote({
        source: folder,
        source_id: sourceId,
        properties: { title: "shared", body: "written by the first key" },
      }),
    );
    expect(
      claimed.status,
      "the first key's create under the shared source was not written",
    ).toBe(201);
    trackItem(ctx, claimed.data.item.id);

    // The same `source_id` under the second key's own source, written first,
    // so a page that looked the pair up under the credential's own source
    // rather than the one its entry names has a row to land on.
    const own = await second.client.createItem(
      createNote({
        source_id: sourceId,
        properties: { title: "own", body: "under the second key's own source" },
      }),
    );
    expect(
      own.status,
      "the second key's create under its own source was not written",
    ).toBe(201);
    trackItem(ctx, own.data.item.id);
    expect(own.data.item.source).toBe(second.source);

    const page = await second.client.bulkItems({
      items: [
        {
          type: "core.note",
          source: folder,
          source_id: sourceId,
          properties: { title: "shared", body: "written by the second key" },
        },
      ],
    });
    expect(
      page.status,
      `a page naming a claimed source was refused: ${JSON.stringify(page.error)}`,
    ).toBe(200);
    expect(
      page.data.results[0]?.outcome,
      "the second key's entry under the shared source made a row of its own, so one file on two machines is two items",
    ).toBe("updated");
    expect(
      page.data.results[0]?.id,
      "the entry naming the claim landed on another row than the one the first key wrote under it",
    ).toBe(claimed.data.item.id);

    const shared = await client.getItem(claimed.data.item.id);
    expect(shared.ok, "the shared row cannot be read back").toBe(true);
    expect(
      shared.data.item.properties.body,
      "the shared row does not carry the second key's entry",
    ).toBe("written by the second key");
    expect(
      shared.data.item.version,
      "the entry did not advance the shared row's version",
    ).toBe(claimed.data.item.version + 1);
    const untouched = await client.getItem(own.data.item.id);
    expect(
      untouched.ok,
      "the row under the key's own source cannot be read",
    ).toBe(true);
    expect(
      untouched.data.item.version,
      "the entry naming the claim also wrote to the row under the key's own source",
    ).toBe(own.data.item.version);

    // The witness. The same entry naming no source lands on the row under
    // the key's own source, so that row was there to be landed on and the
    // entry above reached the shared row because it named the claim.
    const ownPage = await second.client.bulkItems({
      items: [
        {
          type: "core.note",
          source_id: sourceId,
          properties: { title: "own", body: "rewritten under its own source" },
        },
      ],
    });
    expect(
      ownPage.status,
      `a page naming no source was refused: ${JSON.stringify(ownPage.error)}`,
    ).toBe(200);
    expect(
      ownPage.data.results[0],
      "an entry naming no source did not land on the row under the key's own source",
    ).toMatchObject({ outcome: "updated", id: own.data.item.id });
  });

  it("gates a bulk entry resolving a trashed row on the row's type, and names no id", async () => {
    // A key writing bookmarks and notes under the shared source, and one
    // writing notes alone under it: the second reaches the first's rows
    // through the source they share, whatever their types.
    const minted = await operator.createKey({
      label: "trashed-writer",
      source: `${ctx.source}-trashed-writer`,
      sources: [folder],
      type_permissions: { "core.note": "write", "core.bookmark": "write" },
    });
    expect(minted.status, "the operator could not mint the bookmark key").toBe(
      201,
    );
    trackKey(ctx, minted.data.id);
    const both = new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
    const notesOnly = await claimingKey("trashed-notes", [folder]);

    const sourceId = `trashed-bookmark-${ctx.runId}`;
    const bookmark = {
      url: "https://example.com/trashed",
      title: "A bookmark in the bin",
    };
    const created = await both.createItem({
      type: "core.bookmark",
      source: folder,
      source_id: sourceId,
      properties: bookmark,
    });
    expect(
      created.status,
      `the bookmark under the shared source was not written: ${JSON.stringify(created.error)}`,
    ).toBe(201);
    trackItem(ctx, created.data.item.id);
    const trashed = await both.deleteItem(created.data.item.id);
    expect(trashed.ok, "the bookmark could not be trashed").toBe(true);

    // The witness. The key that may write the row's type, declaring it, is
    // acknowledged with the row's id, so an id is what this entry discloses
    // when its gates pass.
    const acknowledged = await both.bulkItems({
      atomic: false,
      items: [
        {
          type: "core.bookmark",
          source: folder,
          source_id: sourceId,
          properties: bookmark,
        },
      ],
    });
    expect(
      acknowledged.status,
      `a page resolving the trashed row was refused: ${JSON.stringify(acknowledged.error)}`,
    ).toBe(200);
    expect(
      acknowledged.data.results[0],
      "an entry resolving a trashed row its key may write was not acknowledged with the row's id",
    ).toMatchObject({
      outcome: "skipped",
      reason: "trashed",
      id: created.data.item.id,
    });

    const note = { title: "a note", body: "declared over a trashed bookmark" };
    const entry = {
      type: "core.note",
      source: folder,
      source_id: sourceId,
      properties: note,
    };

    const unwritable = await notesOnly.client.bulkItems({
      atomic: false,
      items: [entry],
    });
    expect(
      unwritable.status,
      `a non-atomic page was refused whole: ${JSON.stringify(unwritable.error)}`,
    ).toBe(200);
    const refused = unwritable.data.results[0];
    expect(
      refused?.outcome,
      "an entry resolving a trashed row of a type its key may not write was not refused",
    ).toBe("errored");
    expect(
      refused?.error?.code,
      "the refusal is not the one a type the key may not write answers",
    ).toBe("type_not_permitted");
    expect(
      JSON.stringify(refused),
      "the refusal names the trashed row's id to a key that may not write its type",
    ).not.toContain(created.data.item.id);
    expect(
      JSON.stringify(refused),
      "the refusal names the type of a row its key may not read",
    ).not.toContain("core.bookmark");
    // Its witness is below: the same entry from the key that may write the
    // trashed row is refused on this same path too, and that refusal names
    // the row, its id in `details.item_id` and its type in
    // `details.actual_type`.

    const mismatched = await both.bulkItems({ atomic: false, items: [entry] });
    expect(
      mismatched.status,
      `a non-atomic page was refused whole: ${JSON.stringify(mismatched.error)}`,
    ).toBe(200);
    const declared = mismatched.data.results[0];
    expect(
      declared?.outcome,
      "an entry declaring another type than the trashed row's was acknowledged",
    ).toBe("errored");
    expect(
      declared?.error?.code,
      "the refusal is not the one a declared type the row is not answers",
    ).toBe("type_mismatch");
    expect(
      declared?.error?.details?.actual_type,
      "the declared type was not held to the trashed row's own",
    ).toBe("core.bookmark");
    expect(
      declared?.error?.details?.item_id,
      "the refusal to the key that may write the trashed row does not name it, so nothing shows this path can carry an id at all",
    ).toBe(created.data.item.id);
  });

  it("tells a key its natural key is taken, and nothing of a row it may not read", async () => {
    // A key writing bookmarks under the shared source, one reading them, and
    // one holding notes alone: the last reaches the bookmark through the
    // source they share, and may learn that its key is taken and nothing
    // else, not the row's id, its type or any property.
    const mint = async (
      label: string,
      type_permissions: Record<string, string>,
    ): Promise<MarfaClient> => {
      const minted = await operator.createKey({
        label,
        source: `${ctx.source}-${label}`,
        sources: [folder],
        type_permissions,
      });
      expect(minted.status, `the operator could not mint ${label}`).toBe(201);
      trackKey(ctx, minted.data.id);
      return new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
    };
    const writer = await mint("hidden-writer", {
      "core.note": "write",
      "core.bookmark": "write",
    });
    const reader = await mint("hidden-reader", {
      "core.note": "write",
      "core.bookmark": "read",
    });
    const notesOnly = await mint("hidden-notes", { "core.note": "write" });

    const live = `hidden-live-${ctx.runId}`;
    const binned = `hidden-trashed-${ctx.runId}`;
    const secret = { url: "https://example.com/hidden", title: "Hidden" };
    const row = async (sourceId: string): Promise<string> => {
      const created = await writer.createItem({
        type: "core.bookmark",
        source: folder,
        source_id: sourceId,
        properties: secret,
      });
      expect(
        created.status,
        `the bookmark was not written: ${JSON.stringify(created.error)}`,
      ).toBe(201);
      trackItem(ctx, created.data.item.id);
      return created.data.item.id;
    };
    const liveId = await row(live);
    const binnedId = await row(binned);
    expect((await writer.deleteItem(binnedId)).ok).toBe(true);

    // Nothing in the answer names the row: not its id, its type, nor a
    // property it holds.
    const disclosed = (answer: unknown): string[] => {
      const text = JSON.stringify(answer);
      return [
        liveId,
        binnedId,
        "core.bookmark",
        secret.url,
        secret.title,
      ].filter((named) => text.includes(named));
    };
    const note = (sourceId: string, version?: number) => ({
      type: "core.note",
      source: folder,
      source_id: sourceId,
      properties: { title: "a note", body: "over a bookmark" },
      ...(version === undefined ? {} : { version }),
    });

    // The witness: the key that may write the row is told which row its
    // key names, by id and snapshot, in the conditional create's refusal.
    const named = await writer.rawRequest("/items", {
      method: "POST",
      body: { ...note(live, 0), type: "core.bookmark", properties: secret },
    });
    expect(named.status).toBe(409);
    expect(
      (named.error as unknown as { current: { id: string } }).current.id,
    ).toBe(liveId);

    // The single create, live and trashed, with and without a version.
    for (const [label, body] of [
      ["a keyed create onto a live row", note(live)],
      ["a conditional keyed create onto a live row", note(live, 0)],
      ["a keyed create onto a trashed row", note(binned)],
    ] as const) {
      const refused = await notesOnly.rawRequest("/items", {
        method: "POST",
        body,
      });
      expect(
        [refused.status, refused.error?.error.code],
        `${label} was not refused for the row's type`,
      ).toEqual([403, "type_not_permitted"]);
      expect(
        disclosed(refused.error),
        `${label} told a key that may not read the row about it`,
      ).toEqual([]);
    }

    // The bulk door, upserting and creating only.
    const upserted = await notesOnly.bulkItems({
      atomic: false,
      items: [note(live), note(binned)],
    });
    expect(upserted.status).toBe(200);
    for (const result of upserted.data.results) {
      expect(result.outcome).toBe("errored");
      expect(result.error?.code).toBe("type_not_permitted");
    }
    expect(
      disclosed(upserted.data.results),
      "an upsert entry refused for the row's type named the row",
    ).toEqual([]);

    const createOnly = await notesOnly.bulkItems({
      mode: "create_only",
      atomic: false,
      items: [note(live), note(binned)],
    });
    expect(createOnly.status).toBe(200);
    expect(
      createOnly.data.results.map((result) => [result.outcome, result.reason]),
      "a create_only entry onto a taken key was not told the key is taken",
    ).toEqual([
      ["skipped", "duplicate_source"],
      ["skipped", "duplicate_source"],
    ]);
    expect(
      disclosed(createOnly.data.results),
      "a create_only entry named a row its key may not read",
    ).toEqual([]);

    // The witness for the type: a key that may read the row's type but not
    // write it is refused naming the type, so its absence above is the gate
    // and not a message that never names one.
    const readerRefused = await reader.rawRequest("/items", {
      method: "POST",
      body: note(live),
    });
    expect(readerRefused.status).toBe(403);
    expect(JSON.stringify(readerRefused.error)).toContain("core.bookmark");
    expect(JSON.stringify(readerRefused.error)).not.toContain(liveId);

    // The witness for the bulk half: a key that may read the row's type is
    // told its id, so the absence above is the gate and not a door that
    // names no id to anyone.
    const readable = await reader.bulkItems({
      mode: "create_only",
      atomic: false,
      items: [note(live)],
    });
    expect(readable.data.results[0]).toMatchObject({
      outcome: "skipped",
      reason: "duplicate_source",
      id: liveId,
    });
  });

  it("refuses a create naming another id than the row its natural key resolves, to a key that may not read the row, without naming it", async () => {
    const mint = async (
      label: string,
      type_permissions: Record<string, string>,
    ): Promise<MarfaClient> => {
      const minted = await operator.createKey({
        label,
        source: `${ctx.source}-${label}`,
        sources: [folder],
        type_permissions,
      });
      expect(minted.status, `the operator could not mint ${label}`).toBe(201);
      trackKey(ctx, minted.data.id);
      return new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
    };
    const writer = await mint("other-id-writer", {
      "core.note": "write",
      "core.bookmark": "write",
    });
    const notesOnly = await mint("other-id-notes", { "core.note": "write" });

    const sourceId = `other-id-${ctx.runId}`;
    const secret = { url: "https://example.com/other-id", title: "Hidden" };
    const row = await writer.createItem({
      type: "core.bookmark",
      source: folder,
      source_id: sourceId,
      properties: secret,
    });
    expect(row.status, JSON.stringify(row.error)).toBe(201);
    trackItem(ctx, row.data.item.id);

    const fresh = generateId();
    const body = {
      type: "core.note",
      id: fresh,
      source: folder,
      source_id: sourceId,
      properties: { title: "a note", body: "over a bookmark" },
    };
    const refused = await notesOnly.rawRequest("/items", {
      method: "POST",
      body,
    });
    expect([refused.status, refused.error?.error.code]).toEqual([
      403,
      "type_not_permitted",
    ]);
    const text = JSON.stringify(refused.error);
    for (const named of [
      row.data.item.id,
      "core.bookmark",
      secret.url,
      secret.title,
    ]) {
      expect(text, `the refusal named ${named}`).not.toContain(named);
    }
    expect((await client.getItem(fresh)).status).toBe(404);

    // The witness: a key that may write the row's type is told which row the
    // key names, so the silence above is the gate and not a door that names
    // no row to anyone.
    const named = await writer.rawRequest("/items", {
      method: "POST",
      body: { ...body, type: "core.bookmark", properties: secret },
    });
    expect(named.status).toBe(400);
    expect(JSON.stringify(named.error)).toContain(row.data.item.id);
  });

  it("refuses a bulk entry naming a source its key does not claim, and rolls an atomic page back", async () => {
    const note = { title: "bulk", body: "a bulk entry" };

    // The witness first: an entry naming a source its key claims lands
    // under it, so the refusals below are about the claim and not the door.
    const claimer = await claimingKey("bulk-claimer", [folder]);
    const claimed = await claimer.client.bulkItems({
      items: [
        {
          type: "core.note",
          source: folder,
          source_id: `bulk-claimed-${ctx.runId}`,
          properties: note,
        },
      ],
    });
    expect(claimed.status, "a bulk page naming a claimed source failed").toBe(
      200,
    );
    expect(
      claimed.data.results[0]?.outcome,
      "a bulk entry naming a source its key claims was not written",
    ).toBe("created");
    trackItem(ctx, claimed.data.results[0]!.id!);
    const landed = await client.getItem(claimed.data.results[0]!.id!);
    expect(
      landed.data.item.source,
      "a bulk entry naming a source its key claims was not stamped with it",
    ).toBe(folder);

    const stranger = await claimingKey("bulk-stranger", []);
    const ownId = `bulk-own-${ctx.runId}`;
    const partial = await stranger.client.bulkItems({
      atomic: false,
      items: [
        { type: "core.note", source_id: ownId, properties: note },
        {
          type: "core.note",
          source: folder,
          source_id: `bulk-unclaimed-${ctx.runId}`,
          properties: note,
        },
      ],
    });
    expect(
      partial.status,
      "a non-atomic page carrying one refused entry was refused whole",
    ).toBe(200);
    expect(
      partial.data.results[0]?.outcome,
      "the good entry beside a refused one was not written",
    ).toBe("created");
    trackItem(ctx, partial.data.results[0]!.id!);
    expect(
      partial.data.results[1]?.outcome,
      "a bulk entry naming a source its key does not claim was written",
    ).toBe("errored");
    expect(
      partial.data.results[1]?.error?.code,
      "the entry's refusal is not the one a permission the caller lacks answers",
    ).toBe("forbidden");
    expect(
      partial.data.results[1]?.error?.details?.source,
      "the entry's refusal does not name the source it may not write under",
    ).toBe(folder);

    const atomicId = `bulk-atomic-${ctx.runId}`;
    const rolled = await stranger.client.bulkItems({
      items: [
        { type: "core.note", source_id: atomicId, properties: note },
        {
          type: "core.note",
          source: folder,
          source_id: `${atomicId}-unclaimed`,
          properties: note,
        },
      ],
    });
    expect(
      rolled.status,
      "an atomic page carrying an entry its key may not write under was not refused as a permission the caller lacks",
    ).toBe(403);
    expect(
      rolled.error?.error.code,
      "the atomic refusal is not a rollback",
    ).toBe("bulk_atomic_rollback");
    expect(
      rolled.error?.error.details?.code,
      "the rollback does not carry the entry's own refusal",
    ).toBe("forbidden");
    expect(
      rolled.error?.error.details?.index,
      "the rollback names the wrong entry",
    ).toBe(1);

    // The listing under the key's own source surfaces what the key wrote
    // there, the non-atomic page's good entry among it, so the good entry of
    // the rolled-back page is absent because it never landed.
    const own = await client.listItems({ source: stranger.source, limit: 100 });
    expect(own.ok, "the listing under the key's own source failed").toBe(true);
    const listed = own.data.data.map((row) => row.source_id);
    expect(
      listed,
      "the listing does not surface a row the key wrote under its own source, so the absence below proves nothing",
    ).toContain(ownId);
    expect(
      listed,
      "the rolled-back page left its good entry behind",
    ).not.toContain(atomicId);
  });

  it("refuses an atomic page for an entry's source or type before a stale entry ahead of it", async () => {
    const writer = await claimingKey("atomic-order", [folder]);
    const staleId = `atomic-order-stale-${ctx.runId}`;
    const seeded = await writer.client.createItem(
      createNote({
        source_id: staleId,
        properties: { title: "original", body: "original body" },
      }),
    );
    expect(seeded.status, "the row a stale entry needs was not written").toBe(
      201,
    );
    trackItem(ctx, seeded.data.item.id);
    const advanced = await writer.client.updateItem(seeded.data.item.id, {
      properties: { title: "moved on" },
      version: seeded.data.item.version,
    });
    expect(advanced.status, "the row could not be moved past its seed").toBe(
      200,
    );
    const stale = {
      type: "core.note",
      source_id: staleId,
      properties: { title: "from a stale writer" },
      version: seeded.data.item.version,
    };
    const note = { title: "atomic order", body: "an entry behind a stale one" };

    // The witness. Alone, the stale entry rolls its page back for its
    // version, so it is an entry the pages below could be refused for.
    const alone = await writer.client.bulkItems({ items: [stale] });
    expect(alone.status, "a stale entry alone did not roll its page back").toBe(
      409,
    );
    expect(alone.error?.error.code).toBe("bulk_atomic_rollback");
    expect(
      alone.error?.error.details?.code,
      "the stale entry was refused for something other than its version",
    ).toBe("version_conflict");
    expect(alone.error?.error.details?.index).toBe(0);

    // Behind it, an entry naming a source the key does not claim. What each
    // entry names is judged across the page before any entry meets its row,
    // so the page is refused for the second entry, and at its status.
    const unclaimed = await writer.client.bulkItems({
      items: [
        stale,
        {
          type: "core.note",
          source: elsewhere,
          source_id: `atomic-order-unclaimed-${ctx.runId}`,
          properties: note,
        },
      ],
    });
    expect(
      unclaimed.status,
      "a page carrying an entry its key may not write under was refused for a stale entry ahead of it, so whether a caller learns of the source depends on what the store holds",
    ).toBe(403);
    expect(unclaimed.error?.error.code).toBe("bulk_atomic_rollback");
    expect(
      unclaimed.error?.error.details?.code,
      "the rollback does not carry the unclaimed source's refusal",
    ).toBe("forbidden");
    expect(
      unclaimed.error?.error.details?.index,
      "the rollback names the stale entry rather than the one naming a source its key does not claim",
    ).toBe(1);
    expect(
      (
        unclaimed.error?.error.details?.details as
          Record<string, unknown> | undefined
      )?.source,
      "the rollback does not name the source its entry may not write under",
    ).toBe(elsewhere);

    // The write gate is judged the same way: an entry of a type the key may
    // not write, behind the same stale entry.
    const unwritable = await writer.client.bulkItems({
      items: [
        stale,
        {
          type: "core.bookmark",
          source_id: `atomic-order-bookmark-${ctx.runId}`,
          properties: { url: "https://example.com/atomic-order" },
        },
      ],
    });
    expect(
      unwritable.status,
      "a page carrying an entry of a type its key may not write was refused for a stale entry ahead of it",
    ).toBe(403);
    expect(unwritable.error?.error.code).toBe("bulk_atomic_rollback");
    expect(
      unwritable.error?.error.details?.code,
      "the rollback does not carry the type gate's refusal",
    ).toBe("type_not_permitted");
    expect(
      unwritable.error?.error.details?.index,
      "the rollback names the stale entry rather than the one of a type its key may not write",
    ).toBe(1);
  });

  it("keeps a row's source where its create put it", async () => {
    const writer = await claimingKey("keeper", [folder]);
    const created = await writer.client.createItem(
      createNote({ source: folder }),
    );
    expect(
      created.status,
      "a create naming a claimed source was not written",
    ).toBe(201);
    trackItem(ctx, created.data.item.id);

    const moved = await writer.client.rawRequest<unknown>(
      `/items/${created.data.item.id}`,
      {
        method: "PATCH",
        body: {
          properties: { title: "moved" },
          version: created.data.item.version,
          source: writer.source,
        },
      },
    );
    expect(
      moved.status,
      "an update naming a source was accepted, so a row can leave the natural key it was written under",
    ).toBe(400);
    expect(moved.error?.error.code).toBe("validation_error");

    // The witness. The same update without the source lands, and the row
    // keeps the source its create put there.
    const patched = await writer.client.updateItem(created.data.item.id, {
      properties: { title: "moved" },
      version: created.data.item.version,
    });
    expect(
      patched.status,
      "the same update naming no source was refused, so the refusal above says nothing about the source",
    ).toBe(200);
    expect(
      patched.data.item.source,
      "an update moved the row off the source its create put it under",
    ).toBe(folder);
  });

  it("refuses a key moving a natural key under a source it does not write under", async () => {
    const owner = await claimingKey("nk-owner", []);
    const other = await claimingKey("nk-other", []);
    const created = await owner.client.createItem(
      createNote({ source_id: `nk-${ctx.runId}` }),
    );
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    trackItem(ctx, created.data.item.id);
    const id = created.data.item.id;

    const patched = await other.client.updateItem(id, {
      source_id: `nk-moved-${ctx.runId}`,
      version: created.data.item.version,
    });
    expect(patched.status).toBe(403);
    expect(patched.error?.error.code).toBe("forbidden");
    expect(patched.error?.error.details?.source).toBe(owner.source);

    const entry = await other.client.bulkItems({
      atomic: false,
      items: [
        {
          type: "core.note",
          id,
          properties: { body: "moved" },
          source_id: `nk-moved-${ctx.runId}`,
        },
      ],
    });
    expect(entry.status).toBe(200);
    expect(entry.data.results[0]?.outcome).toBe("errored");
    expect(entry.data.results[0]?.error?.code).toBe("forbidden");
    expect(entry.data.results[0]?.error?.details?.source).toBe(owner.source);

    // The witness: the key whose source it is moves it.
    const own = await owner.client.updateItem(id, {
      source_id: `nk-moved-${ctx.runId}`,
      version: created.data.item.version,
    });
    expect(own.status, JSON.stringify(own.error)).toBe(200);
    expect(own.data.item.source_id).toBe(`nk-moved-${ctx.runId}`);
  });

  it("stops a narrowed key writing under a source it no longer claims, and leaves its rows there editable", async () => {
    const writer = await claimingKey("narrowed", [folder]);
    const sourceId = `narrowed-${ctx.runId}`;

    // The witness. While the key claims the source, a create under it lands.
    const created = await writer.client.createItem(
      createNote({ source: folder, source_id: sourceId }),
    );
    expect(
      created.status,
      "a create naming a source its key claims was not written",
    ).toBe(201);
    trackItem(ctx, created.data.item.id);

    const narrowed = await operator.updateKey(writer.id, { sources: [] });
    expect(narrowed.status, "the operator could not narrow the key").toBe(200);
    expect(narrowed.data.sources).toEqual([]);

    const refusedCreate = await writer.client.createItem(
      createNote({ source: folder, source_id: `${sourceId}-after` }),
    );
    expect(
      refusedCreate.status,
      "a key narrowed off a source still created a row under it",
    ).toBe(403);
    expect(refusedCreate.error?.error.code).toBe("forbidden");
    expect(
      refusedCreate.error?.error.details?.source,
      "the refusal does not name the source the key no longer claims",
    ).toBe(folder);

    const refusedUpsert = await writer.client.createItem(
      createNote({
        source: folder,
        source_id: sourceId,
        properties: { title: "upserted", body: "after the narrowing" },
      }),
    );
    expect(
      refusedUpsert.status,
      "a key narrowed off a source still upserted onto a row under it by its natural key",
    ).toBe(403);
    expect(refusedUpsert.error?.error.code).toBe("forbidden");
    expect(refusedUpsert.error?.error.details?.source).toBe(folder);
    const unchanged = await client.getItem(created.data.item.id);
    expect(unchanged.ok, "the row under the source cannot be read").toBe(true);
    expect(
      unchanged.data.item.version,
      "the refused upsert wrote to the row",
    ).toBe(created.data.item.version);

    // Nothing was written by the refused create either: a key still
    // claiming the source makes a new row under the same natural key, where
    // a row the refusal left behind would have answered an upsert.
    const claimer = await claimingKey("narrowed-witness", [folder]);
    const fresh = await claimer.client.createItem(
      createNote({ source: folder, source_id: `${sourceId}-after` }),
    );
    expect(
      fresh.status,
      "the refused create left a row under the source, which a key claiming it has now written over",
    ).toBe(201);
    trackItem(ctx, fresh.data.item.id);

    // An update by id names no source, and the row's never moves, so the
    // claim is not asked: the row the key wrote under the source stays its
    // to edit while its type map reaches it.
    const patched = await writer.client.updateItem(created.data.item.id, {
      properties: { title: "edited after the narrowing" },
      version: created.data.item.version,
    });
    expect(
      patched.status,
      `an update by id was refused a row under a source its key no longer claims: ${JSON.stringify(patched.error)}`,
    ).toBe(200);
    expect(patched.data.item.source).toBe(folder);
    expect(patched.data.item.version).toBe(created.data.item.version + 1);
  });
});

describe("a key's claims", () => {
  it("answers a key's claims on the mint, the listing and the update", async () => {
    const minted = await operator.createKey({
      label: "doors",
      source: `${ctx.source}-doors`,
      sources: [folder, elsewhere],
    });
    expect(minted.status, "the operator could not mint a claiming key").toBe(
      201,
    );
    trackKey(ctx, minted.data.id);
    expect(
      minted.data.sources,
      "the mint did not answer the claims it wrote",
    ).toEqual([folder, elsewhere]);
    await expectMatchesSchema("POST", "/keys", 201, minted.data);

    const listed = await operator.listKeys();
    expect(listed.ok, "the key listing failed").toBe(true);
    await expectMatchesSchema("GET", "/keys", 200, listed.data);
    const row = listed.data.data.find((k) => k.id === minted.data.id);
    expect(row?.sources, "the listing does not carry the key's claims").toEqual(
      [folder, elsewhere],
    );

    const renamed = await operator.updateKey(minted.data.id, {
      label: "doors-renamed",
    });
    expect(renamed.status, "an update naming only a label failed").toBe(200);
    await expectMatchesSchema("PATCH", "/keys/{id}", 200, renamed.data);
    expect(
      renamed.data.sources,
      "an update naming no claims did not answer the ones the key holds",
    ).toEqual([folder, elsewhere]);

    // The witness that the lists above are the claims and not an echo of
    // something every key carries: this file's own key claims nothing.
    const own = listed.data.data.find((k) => k.id === ctx.trackedKeys[0]);
    expect(
      own?.sources,
      "a key minted with no claims answers some, so the lists above could be anything",
    ).toEqual([]);
  });

  it("holds a claim named twice once, on the mint and on the update", async () => {
    const minted = await operator.createKey({
      label: "twice",
      source: `${ctx.source}-twice`,
      sources: [folder, folder],
    });
    expect(minted.status, "the operator could not mint a claiming key").toBe(
      201,
    );
    trackKey(ctx, minted.data.id);
    expect(
      minted.data.sources,
      "the mint held a claim named twice twice",
    ).toEqual([folder]);

    // Two distinct claims beside a repeat: both are held, in the order first
    // named, so a list of one is the repeat folded and not a list cut short.
    const updated = await operator.updateKey(minted.data.id, {
      sources: [elsewhere, folder, elsewhere],
    });
    expect(updated.status, "an update naming claims failed").toBe(200);
    expect(
      updated.data.sources,
      "the update held a claim named twice twice",
    ).toEqual([elsewhere, folder]);
    const listed = await operator.listKeys();
    expect(listed.ok, "the key listing failed").toBe(true);
    expect(
      listed.data.data.find((k) => k.id === minted.data.id)?.sources,
      "the listing answers a claim the update named twice more than once",
    ).toEqual([elsewhere, folder]);
  });

  it("refuses a mint or an update claiming a source its caller does not hold", async () => {
    // This file's key holds `keys.mint` and claims nothing.
    const refusedMint = await client.createKey({
      label: "unheld",
      source: `${ctx.source}-unheld`,
      sources: [folder],
    });
    expect(
      refusedMint.status,
      "a key granted a source it does not hold, so a claim can be passed to anyone by anyone who can mint",
    ).toBe(403);
    expect(refusedMint.error?.error.code).toBe("forbidden");
    expect(
      refusedMint.error?.error.details?.source,
      "the refusal does not name the source the caller may not grant",
    ).toBe(folder);
    await expectMatchesSchema("POST", "/keys", 403, refusedMint.error);

    // The witness. Its own source is its to grant.
    const ownGrant = await client.createKey({
      label: "own-grant",
      source: `${ctx.source}-own-grant`,
      sources: [ctx.source],
    });
    expect(
      ownGrant.status,
      "a key could not grant its own source, so the refusal above may be every claim",
    ).toBe(201);
    trackKey(ctx, ownGrant.data.id);
    expect(ownGrant.data.sources).toEqual([ctx.source]);

    // A key claiming one source grants it, and is refused the first source
    // past what it holds.
    const granter = await claimingKey("granter", [folder]);
    const granted = await granter.client.createKey({
      label: "granted",
      source: `${ctx.source}-granted`,
      sources: [folder],
    });
    expect(
      granted.status,
      "a key could not grant a source it claims, so a claim cannot travel with a device's key",
    ).toBe(201);
    trackKey(ctx, granted.data.id);
    expect(granted.data.sources).toEqual([folder]);
    const past = await granter.client.createKey({
      label: "past",
      source: `${ctx.source}-past`,
      sources: [folder, elsewhere],
    });
    expect(past.status, "a key granted a source past what it claims").toBe(403);
    expect(
      past.error?.error.details?.source,
      "the refusal named a source the caller holds rather than the one it does not",
    ).toBe(elsewhere);

    const refusedUpdate = await client.updateKey(ownGrant.data.id, {
      sources: [folder],
    });
    expect(
      refusedUpdate.status,
      "an update granted a source its caller does not hold, which the mint refuses a moment earlier",
    ).toBe(403);
    expect(refusedUpdate.error?.error.code).toBe("forbidden");
    expect(
      refusedUpdate.error?.error.details?.source,
      "the update's refusal does not name the source the caller may not grant",
    ).toBe(folder);
    await expectMatchesSchema("PATCH", "/keys/{id}", 403, refusedUpdate.error);

    // The witness. The operator may grant any source, and the same update
    // from it lands and reads back on the listing.
    const operatorUpdate = await operator.updateKey(ownGrant.data.id, {
      sources: [folder],
    });
    expect(
      operatorUpdate.status,
      "the operator could not grant a source, so the refusal above may be every update",
    ).toBe(200);
    expect(operatorUpdate.data.sources).toEqual([folder]);
    const listed = await operator.listKeys();
    expect(
      listed.data.data.find((k) => k.id === ownGrant.data.id)?.sources,
      "an update's claims did not read back on the listing",
    ).toEqual([folder]);
  });

  it("refuses a key whose own source another key claims, unless its caller could grant it", async () => {
    const taken = `${ctx.source}-taken`;
    const claimer = await claimingKey("taken-claimer", [taken]);

    // This file's key claims nothing, so naming the claimed source as a new
    // key's own would hand that key every row written under it.
    const refused = await client.createKey({ label: "taken", source: taken });
    expect(
      refused.status,
      "a key took as its own a source another key claims, and with it every row written under that source",
    ).toBe(403);
    expect(refused.error?.error.code).toBe("forbidden");
    expect(
      refused.error?.error.details?.source,
      "the refusal does not name the source the caller may not take",
    ).toBe(taken);

    // The witness. The key that claims the source may give it to a new key
    // as its own, so the refusal is the caller's reach and not the source.
    const granted = await claimer.client.createKey({
      label: "taken",
      source: taken,
    });
    expect(
      granted.status,
      "a key claiming a source could not give it as a new key's own",
    ).toBe(201);
    trackKey(ctx, granted.data.id);

    // The source is now another key's own, and the key claiming it still
    // writes under it: a row's source does not name the key that wrote it.
    const written = await claimer.client.createItem(
      createNote({ source: taken }),
    );
    expect(
      written.status,
      "a key claiming a source that is now another key's own could no longer write under it",
    ).toBe(201);
    trackItem(ctx, written.data.item.id);
    expect(written.data.item.source).toBe(taken);
  });

  it("compares a key's own source with another key's claim case included", async () => {
    const claimed = `${ctx.source}-cased`;
    await claimingKey("cased-claimer", [claimed]);

    // The witness. This file's key claims nothing, so the claimed source
    // itself is refused as a new key's own.
    const exact = await client.createKey({
      label: "cased-exact",
      source: claimed,
    });
    expect(
      exact.status,
      "a key took as its own a source another key claims, so the mint below proves nothing about case",
    ).toBe(403);
    expect(exact.error?.error.details?.source).toBe(claimed);

    const differing = `${ctx.source}-CASED`;
    const minted = await client.createKey({
      label: "cased-differing",
      source: differing,
    });
    expect(
      minted.status,
      "a key was refused as its own a source differing from another key's claim only in case, so the mint compares sources otherwise than a write names them",
    ).toBe(201);
    trackKey(ctx, minted.data.id);
    expect(minted.data.source).toBe(differing);

    // What makes that safe: the key it minted holds no reach on the claim,
    // and a write naming it is refused.
    const cased = new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
    const write = await cased.createItem(createNote({ source: claimed }));
    expect(
      write.status,
      "a key whose own source differs from a claim only in case wrote under the claim",
    ).toBe(403);
    expect(write.error?.error.code).toBe("forbidden");
    expect(write.error?.error.details?.source).toBe(claimed);
  });

  it("refuses a reserved prefix, even to the operator key", async () => {
    for (const reserved of ["oauth:client:person", "OAuth:client:person"]) {
      const refused = await operator.createKey({
        label: "reserved",
        source: `${ctx.source}-reserved`,
        sources: [reserved],
      });
      expect(
        refused.status,
        `the operator granted ${reserved}, so a key's rows can read as an app's`,
      ).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }

    // The witness. The same caller grants an ordinary source on both doors,
    // so the refusals are the prefix and not the caller.
    const target = await operator.createKey({
      label: "reserved-target",
      source: `${ctx.source}-reserved-target`,
      sources: [folder],
    });
    expect(
      target.status,
      "the operator could not grant an ordinary source, so the refusals above may be every claim",
    ).toBe(201);
    trackKey(ctx, target.data.id);

    const refusedUpdate = await operator.updateKey(target.data.id, {
      sources: [folder, "oauth:client:person"],
    });
    expect(
      refusedUpdate.status,
      "an update granted a reserved prefix the mint refuses",
    ).toBe(400);
    expect(refusedUpdate.error?.error.code).toBe("validation_error");
    const kept = await operator.updateKey(target.data.id, {
      sources: [folder, elsewhere],
    });
    expect(
      kept.status,
      "the operator could not update a key to ordinary claims",
    ).toBe(200);
    expect(kept.data.sources).toEqual([folder, elsewhere]);
  });

  it("grants a source under any other prefix, connector: included", async () => {
    // Only `oauth:` names an identity a key cannot earn. A connector holds
    // a key like any other writer, so its source is the key's own choice.
    const own = `connector:${ctx.source}`;
    const claim = `connector:${ctx.source}-claim`;
    const minted = await operator.createKey({
      label: "connector-prefix",
      source: own,
      sources: [claim],
    });
    expect(minted.status, JSON.stringify(minted.error)).toBe(201);
    trackKey(ctx, minted.data.id);
    expect(minted.data.source).toBe(own);
    expect(minted.data.sources).toEqual([claim]);
  });

  it("refuses a claim that is empty or longer than a source may be, and trims one", async () => {
    for (const bad of ["", "   ", "x".repeat(201)]) {
      const refused = await operator.createKey({
        label: "bounded",
        source: `${ctx.source}-bounded`,
        sources: [bad],
      });
      expect(
        refused.status,
        `a claim of ${String(bad.length)} characters was granted, so a key can claim what no key could hold as its own source`,
      ).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }

    // The witness. A claim at the bound is granted, and one padded with
    // spaces is stored as a key's own source would be.
    const atBound = `${ctx.source}-`.padEnd(200, "x");
    const granted = await operator.createKey({
      label: "bounded",
      source: `${ctx.source}-bounded`,
      sources: [atBound, `  ${folder}  `],
    });
    expect(
      granted.status,
      "a claim of 200 characters was refused, so the refusals above may be every claim",
    ).toBe(201);
    trackKey(ctx, granted.data.id);
    expect(
      granted.data.sources,
      "a padded claim was stored with its padding, so it never matches the source a write names",
    ).toEqual([atBound, folder]);
  });

  it("refuses a mint or an update claiming more than 1,000 sources", async () => {
    const claims = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `${ctx.source}-many-${String(i)}`);

    // The witness. A key claiming exactly the cap is granted, so the
    // refusals below are the count and not the claims themselves.
    const atCap = await operator.createKey({
      label: "many",
      source: `${ctx.source}-many`,
      sources: claims(1000),
    });
    expect(
      atCap.status,
      "a key claiming 1,000 sources was refused, so the refusals below may be every long list",
    ).toBe(201);
    trackKey(ctx, atCap.data.id);
    expect(atCap.data.sources).toHaveLength(1000);

    const refusedMint = await operator.createKey({
      label: "too-many",
      source: `${ctx.source}-too-many`,
      sources: claims(1001),
    });
    expect(
      refusedMint.status,
      "a mint claiming 1,001 sources was granted, so a key's claims grow without bound",
    ).toBe(400);
    expect(refusedMint.error?.error.code).toBe("validation_error");

    const refusedUpdate = await operator.updateKey(atCap.data.id, {
      sources: claims(1001),
    });
    expect(
      refusedUpdate.status,
      "an update claiming 1,001 sources was granted, so a key's claims grow without bound",
    ).toBe(400);
    expect(refusedUpdate.error?.error.code).toBe("validation_error");

    const listed = await operator.listKeys();
    expect(listed.ok, "the key listing failed").toBe(true);
    expect(
      listed.data.data.find((k) => k.id === atCap.data.id)?.sources,
      "a refused update changed the key's claims",
    ).toHaveLength(1000);
  });

  it("a mint naming nothing takes the creator's claims", async () => {
    const creator = await claimingKey("creator", [folder]);
    const inherited = await creator.client.createKey({
      label: "inherited",
      source: `${ctx.source}-inherited`,
    });
    expect(inherited.status, "a mint naming nothing was refused").toBe(201);
    trackKey(ctx, inherited.data.id);
    expect(
      inherited.data.sources,
      "a mint naming nothing did not take the creator's claims, so a device's key minted from another cannot write the folder it was minted for",
    ).toEqual([folder]);
    expect(
      inherited.data.type_permissions,
      "a mint naming nothing did not take the creator's maps either",
    ).toEqual({ "core.note": "write" });

    // The absence, beside the witness above: naming an empty list holds
    // none, and names reach, so it holds no map either; naming a map and no
    // claims holds no claim.
    const none = await creator.client.createKey({
      label: "claims-none",
      source: `${ctx.source}-claims-none`,
      sources: [],
    });
    expect(none.status, "a mint naming an empty list was refused").toBe(201);
    trackKey(ctx, none.data.id);
    expect(
      none.data.sources,
      "a mint naming no claims took the creator's anyway",
    ).toEqual([]);
    expect(
      none.data.type_permissions,
      "a mint naming its claims took the creator's maps for free, so it holds more than it named",
    ).toEqual({});
    const mapOnly = await creator.client.createKey({
      label: "map-only",
      source: `${ctx.source}-map-only`,
      type_permissions: { "core.note": "read" },
    });
    expect(mapOnly.status, "a mint naming a map was refused").toBe(201);
    trackKey(ctx, mapOnly.data.id);
    expect(
      mapOnly.data.sources,
      "a mint naming a map took the creator's claims anyway, so it holds more than it named",
    ).toEqual([]);
  });

  it(
    "never widens a key an app made to a new source",
    async () => {
      // An app's key is minted through a sign-in, which needs an owner, and an
      // instance has one: the story needs a server of its own.
      const server = await bootFreshServer("claimed-sources-app");
      try {
        const app = new MarfaClient({
          baseUrl: server.apiUrl,
          apiKey: await approvedAppToken(server),
        });
        const own = new MarfaClient({
          baseUrl: server.apiUrl,
          apiKey: server.operatorKey,
        });

        const appKey = await app.createKey({
          label: "app-made",
          source: "app-made",
        });
        expect(
          appKey.status,
          "the app could not mint a key, so there is no key an app made to hold to the rule",
        ).toBe(201);
        expect(
          appKey.data.oauth_client_id,
          "the app's key does not say an app made it, so nothing below is about an app's key",
        ).toBeDefined();
        // Its witness is the widened key below, whose claims the same field
        // answers.
        expect(
          appKey.data.sources,
          "a key an app made claims a source, though an app claims none to give it",
        ).toEqual([]);

        // The witness. The operator widens a key it made itself to the same
        // source, so the refusal below is the key and not the caller.
        const plain = await own.createKey({ label: "plain", source: "plain" });
        expect(plain.status, "the operator could not mint a key").toBe(201);
        const widened = await own.updateKey(plain.data.id, {
          sources: ["shared-folder"],
        });
        expect(
          widened.status,
          "the operator could not widen a key it made, so the refusal below may be every update",
        ).toBe(200);
        expect(widened.data.sources).toEqual(["shared-folder"]);

        const refused = await own.updateKey(appKey.data.id, {
          sources: ["shared-folder"],
        });
        expect(
          refused.status,
          "a key an app made was widened to a source, so what the person approved for the app is not a ceiling",
        ).toBe(403);
        expect(refused.error?.error.code).toBe("forbidden");
        expect(
          refused.error?.error.details?.source,
          "the refusal does not name the source the key may not be given",
        ).toBe("shared-folder");
        await expectMatchesSchema("PATCH", "/keys/{id}", 403, refused.error);
      } finally {
        await server.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS + 120_000,
  );
});
