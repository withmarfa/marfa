import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Item, Outcome } from "../../device/protocol.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

/**
 * An update a caller queues exact names the version the copy held
 * (`queue-and-verdicts/exact-update-sent`), so the server refuses it, merging
 * nothing, once another writer has moved the item. Against a real server and
 * the real binary, with a second device or a direct write as the other writer.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "update-exact",
  ));
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
});

function value<T>(result: Outcome<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value;
}

async function device(label: string): Promise<CliDevice> {
  const made = new CliDevice({
    binary: requireBinary(),
    store: newStore(`update-exact-${label}`),
    url: apiUrl,
    key: apiKey,
  });
  value(await made.hydrate(["core.note"], "library"));
  return made;
}

async function note(title: string): Promise<string> {
  const made = await client.createItem({
    type: "core.note",
    source: ctx.source,
    tier: "library",
    properties: { title, body: title },
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackItem(ctx, made.data.item.id);
  return made.data.item.id;
}

async function onServer(id: string) {
  const read = await client.getItem(id);
  expect(read.ok, JSON.stringify(read.error)).toBe(true);
  return read.data.item;
}

async function held(copy: CliDevice, id: string): Promise<Item> {
  return value(await copy.get(id));
}

it("refuses a queued move to the feed once another device has edited the item, which keeps that device's change", async () => {
  const moved = await note("moved elsewhere");
  const witness = await note("merged elsewhere");
  const a = await device("a");
  const b = await device("b");

  // Offline, A moves both notes to the feed, the first exact.
  const exact = value(
    await a.update(moved, {
      properties: {},
      version: (await held(a, moved)).version,
      tier: "feed",
      exact: true,
    }),
  );
  expect(exact.body).toMatchObject({ tier: "feed", version_match: "exact" });
  const merged = value(
    await a.update(witness, {
      properties: {},
      version: (await held(a, witness)).version,
      tier: "feed",
    }),
  );
  expect(merged.body).not.toHaveProperty("version_match");
  expect((await held(a, moved)).tier).toBe("feed");

  // B renames both.
  for (const id of [moved, witness]) {
    value(
      await b.update(id, {
        properties: { title: "renamed by B" },
        version: (await held(b, id)).version,
      }),
    );
  }
  value(await b.drain());
  const renamed = await onServer(moved);
  expect(renamed.properties.title).toBe("renamed by B");

  const report = value(await a.drain());
  expect(
    report.verdicts.find((row) => row.id === exact.id),
    JSON.stringify(report),
  ).toMatchObject({ verdict: "refused", reason: "version_conflict" });
  const row = value(await a.queue()).find((queued) => queued.id === exact.id);
  expect(row?.refusal).toMatchObject({ code: "version_conflict" });
  expect(JSON.parse(row?.answer ?? "{}")).toMatchObject({
    current: { id: moved, version: renamed.version, tier: "library" },
  });
  const kept = await onServer(moved);
  expect(kept).toMatchObject({
    version: renamed.version,
    tier: "library",
    properties: { title: "renamed by B" },
  });
  expect(await held(a, moved)).toMatchObject({
    version: renamed.version,
    tier: "library",
    properties: { title: "renamed by B" },
  });

  // The witness: the same move not queued exact merges onto B's rename.
  expect(
    report.verdicts.find((row) => row.id === merged.id),
    JSON.stringify(report),
  ).toMatchObject({ verdict: "merged" });
  expect(await onServer(witness)).toMatchObject({
    tier: "feed",
    properties: { title: "renamed by B" },
  });

  // A refused write is not sent again, and the copy still holds the server's.
  const again = value(await a.drain());
  expect(again.verdicts.find((row) => row.id === exact.id)).toBeUndefined();
  value(await a.catchUp());
  expect(await held(a, moved)).toMatchObject({
    version: renamed.version,
    tier: "library",
    properties: { title: "renamed by B" },
  });
  expect((await onServer(moved)).version).toBe(renamed.version);
});

it("lands a queued exact edit where nothing moved the item but this copy's own edit ahead of it", async () => {
  const id = await note("own edits");
  const a = await device("own");
  const version = (await held(a, id)).version;

  const first = value(
    await a.update(id, { properties: { title: "first" }, version }),
  );
  const exact = value(
    await a.update(id, {
      properties: { body: "second" },
      version,
      exact: true,
    }),
  );
  expect(exact.body).toMatchObject({ version_match: "exact" });

  const report = value(await a.drain());
  for (const write of [first, exact]) {
    expect(
      report.verdicts.find((row) => row.id === write.id),
      JSON.stringify(report),
    ).toMatchObject({ verdict: "accepted" });
  }
  expect(await onServer(id)).toMatchObject({
    version: version + 2,
    properties: { title: "first", body: "second" },
  });

  // With nothing ahead of it, an exact move to the feed lands too.
  const moved = value(
    await a.update(id, {
      properties: {},
      version: version + 2,
      tier: "feed",
      exact: true,
    }),
  );
  const landed = value(await a.drain());
  expect(
    landed.verdicts.find((row) => row.id === moved.id),
    JSON.stringify(landed),
  ).toMatchObject({ verdict: "accepted" });
  expect((await onServer(id)).tier).toBe("feed");
});

it("refuses a queued exact edit behind this copy's own edit that the server merged with another writer's change", async () => {
  const exactId = await note("merged ahead");
  const witnessId = await note("merged ahead, not exact");
  const a = await device("merged");
  const queued = new Map<string, { first: string; second: string }>();
  for (const id of [exactId, witnessId]) {
    const version = (await held(a, id)).version;
    const first = value(
      await a.update(id, { properties: { title: "first" }, version }),
    );
    const second = value(
      await a.update(id, {
        properties: { body: "second" },
        version,
        exact: id === exactId,
      }),
    );
    queued.set(id, { first: first.id, second: second.id });
    const elsewhere = await client.updateItem(id, {
      occurred_at: "2025-06-01T12:00:00.000Z",
      version,
    });
    expect(elsewhere.ok, JSON.stringify(elsewhere.error)).toBe(true);
  }

  const report = value(await a.drain());
  const verdict = (id: string | undefined) =>
    report.verdicts.find((row) => row.id === id);
  for (const id of [exactId, witnessId]) {
    expect(verdict(queued.get(id)?.first), JSON.stringify(report)).toMatchObject(
      { verdict: "merged" },
    );
  }
  expect(
    verdict(queued.get(exactId)?.second),
    JSON.stringify(report),
  ).toMatchObject({ verdict: "refused", reason: "version_conflict" });
  expect(await onServer(exactId)).toMatchObject({
    occurred_at: "2025-06-01T12:00:00.000Z",
    properties: { title: "first", body: "merged ahead" },
  });
  expect((await held(a, exactId)).properties.body).toBe("merged ahead");

  // The witness: the same edit not queued exact moves onto the merge and lands.
  expect(
    verdict(queued.get(witnessId)?.second),
    JSON.stringify(report),
  ).toMatchObject({ verdict: "accepted" });
  expect((await onServer(witnessId)).properties).toMatchObject({
    title: "first",
    body: "second",
  });
});

it("refuses, queueing nothing, an exact edit on a version older than the copy holds", async () => {
  const id = await note("older version");
  const a = await device("older");
  const read = (await held(a, id)).version;
  const elsewhere = await client.updateItem(id, {
    properties: { title: "elsewhere" },
    version: read,
  });
  expect(elsewhere.ok, JSON.stringify(elsewhere.error)).toBe(true);
  value(await a.catchUp());
  expect((await held(a, id)).version).toBe(read + 1);

  const refused = await a.update(id, {
    properties: { body: "mine" },
    version: read,
    asRead: true,
    exact: true,
  });
  expect(refused.ok).toBe(false);
  if (!refused.ok) {
    expect(refused.refusal).toMatchObject({
      code: "validation",
      local: "version_conflict",
      server: null,
    });
  }
  expect(value(await a.queue())).toHaveLength(0);
  expect((await held(a, id)).properties.body).toBe("older version");

  // The witness: the same edit, said to be read earlier, is queued.
  value(
    await a.update(id, {
      properties: { body: "mine" },
      version: read,
      asRead: true,
    }),
  );
  expect(value(await a.queue())).toHaveLength(1);
});

it("shows the server's item beneath a waiting exact edit the item has moved past", async () => {
  const id = await note("laid exact");
  const a = await device("laid");
  const read = (await held(a, id)).version;

  const exact = value(
    await a.update(id, {
      properties: { body: "mine" },
      version: read,
      exact: true,
    }),
  );
  // The witness: laid over the row as the server holds it, the edit shows.
  value(await a.catchUp());
  expect((await held(a, id)).properties.body).toBe("mine");

  const elsewhere = await client.updateItem(id, {
    properties: { body: "theirs" },
    version: read,
  });
  expect(elsewhere.ok, JSON.stringify(elsewhere.error)).toBe(true);
  value(await a.catchUp());
  expect(await held(a, id)).toMatchObject({
    version: read + 1,
    properties: { body: "theirs" },
  });
  const row = value(await a.queue()).find((queued) => queued.id === exact.id);
  expect(row?.verdict).toBeNull();
});
