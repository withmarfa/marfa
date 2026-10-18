import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { ApiKeyRequest, BulkActionJob } from "../../client/types.js";
import {
  HOLD,
  idsWith,
  jobOf,
  queue,
  rowsAndChunk,
  seed,
} from "../../utils/bulk-jobs.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * A bulk-action job held where the target can hold it, and then changed
 * around: its key revoked or narrowed, a lever moved, the job canceled. The
 * target's `hold:bulk-job:*` faults stop the worker at the start of a job and
 * between its chunks, and a request that selects a job's items before its last
 * check, so what a fixture changes lands at a point it names rather than at a
 * race against the worker.
 *
 * **Independent of the chunk size.** The contract states none, so the
 * fixture learns it (`rowsAndChunk`) and seeds rows enough that a job takes
 * more than one chunk.
 */
let server: FreshServer;
let operator: MarfaClient;
let working: MarfaClient;
let learned: { rows: number; chunk: number };
/** The source whose items a source filter shows. */
const SHOWN = "shown";

/** Every job a body queued, so `afterEach` leaves the worker free. */
const queued: string[] = [];
let counter = 0;
const fresh = (what: string): string => `${what}-${String((counter += 1))}`;

beforeAll(async () => {
  server = await bootFreshServer("bulk-job-holds");
  operator = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
  working = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  learned = await rowsAndChunk(working);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterEach(async () => {
  await server.clearFault();
  for (const id of queued.splice(0)) {
    await operator.bulkActionCancel(id);
    await operator.pollBulkActionToTerminal(id);
  }
  expect((await operator.updateConfig({})).status).toBe(200);
}, 120_000);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/** A job of `client`, remembered for `afterEach`. */
async function start(
  client: MarfaClient,
  input: Parameters<typeof queue>[1],
): Promise<string> {
  const id = await queue(client, input);
  queued.push(id);
  return id;
}

/** A key of its own, holding what `request` names, and a client over it. */
async function keyHolding(
  label: string,
  request: Partial<ApiKeyRequest>,
): Promise<{ client: MarfaClient; id: string }> {
  const name = fresh(label);
  const minted = await working.createKey({
    label: name,
    source: name,
    type_permissions: { "core.note": "write" },
    ...request,
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  return {
    client: new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: minted.data.key,
    }),
    id: minted.data.id,
  };
}

/** Waits until the worker has gone through every job queued before this. */
async function workerCaughtUp(): Promise<void> {
  const id = await queue(working, {
    action: "update_tags",
    add: ["caught-up"],
    filter: { tags: [fresh("matches-no-item")] },
  });
  expect((await working.pollBulkActionToTerminal(id)).status).toBe("completed");
}

/** A job over `rows` held after its first chunk, with the chunk's counters. */
async function heldBetweenChunks(
  client: MarfaClient,
  input: (tag: string) => Parameters<typeof queue>[1],
  tag: string,
): Promise<{ id: string; job: BulkActionJob }> {
  await server.setFault(HOLD.betweenChunks);
  const id = await start(client, input(tag));
  await server.waitForHold(HOLD.betweenChunks);
  const job = await jobOf(client, id);
  expect(job.status).toBe("in_progress");
  // The witness that a chunk was written and more are left to hold between.
  expect(job.processed).toBeGreaterThan(0);
  expect(job.processed).toBeLessThan(job.matched);
  return { id, job };
}

describe("a job held and released", () => {
  it("writes every item and ends completed, so what the cases below hold back is the case's own doing", async () => {
    const tag = fresh("released");
    await seed(working, tag, learned.rows);
    const { id, job } = await heldBetweenChunks(
      working,
      (t) => ({
        action: "update_tags",
        add: [`${t}-done`],
        filter: { tags: [t] },
      }),
      tag,
    );
    expect(await idsWith(working, `${tag}-done`)).toHaveLength(job.processed);
    await server.clearFault();
    const ended = await working.pollBulkActionToTerminal(id);
    expect(ended).toMatchObject({
      status: "completed",
      matched: learned.rows,
      processed: learned.rows,
      succeeded: learned.rows,
      errored: 0,
    });
    expect(await idsWith(working, `${tag}-done`)).toHaveLength(learned.rows);
  });
});

describe("the selection of a job", () => {
  /** The request selects, is held before its last check, and the key's levers
   *  are moved before it is let go. */
  async function selectedWhileMoved(
    lever: ApiKeyRequest["enforcement_override"],
  ) {
    const tag = fresh("selection");
    await seed(await writerOf(SHOWN), tag, 3);
    const holder = await keyHolding("selection", {
      enforcement_override: {
        source_filter: { types: ["core.note"], sources: [SHOWN] },
      },
    });
    await server.setFault(HOLD.selected);
    const request = holder.client.bulkAction({
      action: "update_tags",
      add: [`${tag}-done`],
      filter: { tags: [tag] },
    });
    await server.waitForHold(HOLD.selected);
    if (lever !== undefined) {
      const moved = await operator.updateKey(holder.id, {
        enforcement_override: lever,
      });
      expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    }
    await server.clearFault(HOLD.selected);
    const answer = await request;
    if (answer.status === 202) queued.push((answer.data as BulkActionJob).id);
    return answer;
  }

  it("is let through when nothing moved while it was held", async () => {
    const answer = await selectedWhileMoved(undefined);
    expect(answer.status, JSON.stringify(answer.error)).toBe(202);
  });

  it.each([
    [
      "narrows to hide a matched item",
      { source_filter: { types: ["core.note"], sources: ["elsewhere"] } },
    ],
    [
      "changes to another that hides none",
      {
        source_filter: {
          types: ["core.note"],
          sources: [SHOWN, "elsewhere"],
        },
      },
    ],
  ] satisfies [string, NonNullable<ApiKeyRequest["enforcement_override"]>][])(
    "is answered 403 forbidden, without a count or ids, when the key's source filter %s while it selects",
    async (_what, lever) => {
      const answer = await selectedWhileMoved(lever);
      expect(answer.status, JSON.stringify(answer.data)).toBe(403);
      expect(answer.error?.error.code).toBe("forbidden");
      expect(Object.keys(answer.data as object)).toEqual(["error"]);
      expect(JSON.stringify(answer.data)).not.toMatch(/matched|"ids"/);
    },
  );
});

describe("canceling a job", () => {
  it("ends a job that is queued canceled, and the worker passes it by", async () => {
    const holdTag = fresh("holds-the-worker");
    await seed(working, holdTag, 3);
    await server.setFault(HOLD.claimed);
    const holdId = await start(working, {
      action: "update_tags",
      add: [`${holdTag}-done`],
      filter: { tags: [holdTag] },
    });
    await server.waitForHold(HOLD.claimed);

    const tag = fresh("queued-cancel");
    await seed(working, tag, 3);
    const id = await start(working, {
      action: "update_tags",
      add: [`${tag}-done`],
      filter: { tags: [tag] },
    });
    expect((await jobOf(working, id)).status).toBe("queued");

    const canceled = await working.bulkActionCancel(id);
    expect(canceled.status, JSON.stringify(canceled.error)).toBe(200);
    expect(canceled.data.status).toBe("canceled");
    expect((await jobOf(working, id)).status).toBe("canceled");
    // The cancel ended the queued job and left the one holding the worker.
    expect((await jobOf(working, holdId)).status).toBe("in_progress");

    await server.clearFault();
    await workerCaughtUp();
    // The witness that the worker could have written: the job it held did.
    expect(await idsWith(working, `${holdTag}-done`)).toHaveLength(3);
    expect(await idsWith(working, `${tag}-done`)).toEqual([]);
    expect(await jobOf(working, id)).toMatchObject({
      status: "canceled",
      processed: 0,
    });
  });

  it("ends a job the worker has taken and not yet written canceled, and it stays so when the worker goes on", async () => {
    const tag = fresh("claimed-cancel");
    await seed(working, tag, 3);
    await server.setFault(HOLD.claimed);
    const id = await start(working, {
      action: "update_tags",
      add: [`${tag}-done`],
      filter: { tags: [tag] },
    });
    await server.waitForHold(HOLD.claimed);
    expect((await jobOf(working, id)).status).toBe("in_progress");

    const canceled = await working.bulkActionCancel(id);
    expect(canceled.status, JSON.stringify(canceled.error)).toBe(200);
    expect(canceled.data.status).toBe("canceled");

    await server.clearFault();
    await workerCaughtUp();
    expect(await jobOf(working, id)).toMatchObject({
      status: "canceled",
      processed: 0,
      succeeded: 0,
    });
    expect(await idsWith(working, `${tag}-done`)).toEqual([]);
  });

  it("ends a running job canceled, keeps what it wrote, and stays canceled whatever its next chunk would do", async () => {
    const tag = fresh("running-cancel");
    await seed(working, tag, learned.rows);
    const { id, job: held } = await heldBetweenChunks(
      working,
      (t) => ({
        action: "update_tags",
        add: [`${t}-done`],
        filter: { tags: [t] },
      }),
      tag,
    );
    const kept = await idsWith(working, `${tag}-done`);
    expect(kept).toHaveLength(held.processed);

    const canceled = await working.bulkActionCancel(id);
    expect(canceled.status, JSON.stringify(canceled.error)).toBe(200);
    expect(canceled.data.status).toBe("canceled");
    expect(await idsWith(working, `${tag}-done`)).toEqual(kept);

    await server.clearFault();
    await workerCaughtUp();
    const final = await jobOf(working, id);
    expect(final).toMatchObject({
      status: "canceled",
      processed: held.processed,
      succeeded: held.succeeded,
      errored: 0,
    });
    // Nothing the worker had in hand when the cancel came was written, and
    // every item the job had written is still written.
    expect((await idsWith(working, `${tag}-done`)).sort()).toEqual(
      [...kept].sort(),
    );
  });
});

describe("a credential that changes while its job runs", () => {
  it("fails the job, writes nothing more and says the credential no longer authenticates, once the key is revoked", async () => {
    const tag = fresh("revoked");
    await seed(working, tag, learned.rows);
    const holder = await keyHolding("revoked", {});
    const { id, job: held } = await heldBetweenChunks(
      holder.client,
      (t) => ({
        action: "update_tags",
        add: [`${t}-done`],
        filter: { tags: [t] },
      }),
      tag,
    );
    const revoked = await operator.revokeKey(holder.id);
    expect(revoked.status, JSON.stringify(revoked.error)).toBe(200);
    await server.clearFault();

    const failed = await operator.pollBulkActionToTerminal(id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/credential/i);
    expect(failed.error).toMatch(/no longer authenticates/);
    expect(failed.error).toMatch(/nothing further/);
    expect(failed.succeeded).toBe(held.succeeded);
    // What the first chunk wrote stays, and the rest is untouched.
    expect(await idsWith(working, `${tag}-done`)).toHaveLength(held.processed);
  });

  it("fails a purge, writes nothing more and says the key no longer holds items.purge, once the permission is taken", async () => {
    const tag = fresh("purge-lost");
    await seed(working, tag, learned.rows);
    const binned = await working.bulkAction({
      action: "transition",
      state: "trashed",
      filter: { tags: [tag] },
    });
    expect(binned.status, JSON.stringify(binned.error)).toBe(202);
    expect(
      (
        await working.pollBulkActionToTerminal(
          (binned.data as BulkActionJob).id,
        )
      ).status,
    ).toBe("completed");

    const holder = await keyHolding("purge-lost", {
      permissions: ["items.purge"],
    });
    const { id, job: held } = await heldBetweenChunks(
      holder.client,
      (t) => ({
        action: "purge",
        confirm: "PURGE",
        filter: { tags: [t], state: "trashed" },
      }),
      tag,
    );
    const lost = await operator.updateKey(holder.id, { permissions: [] });
    expect(lost.status, JSON.stringify(lost.error)).toBe(200);
    await server.clearFault();

    const failed = await operator.pollBulkActionToTerminal(id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/items\.purge/);
    expect(failed.succeeded).toBe(held.succeeded);
    const left = await working.listItems({
      tags: [tag],
      state: "trashed",
      limit: 200,
    });
    let remaining = left.data.data.length;
    let cursor = left.data.next_cursor ?? undefined;
    while (cursor !== undefined) {
      const page = await working.listItems({
        tags: [tag],
        state: "trashed",
        limit: 200,
        cursor,
      });
      remaining += page.data.data.length;
      cursor = page.data.next_cursor ?? undefined;
    }
    // The first chunk was purged, and the rows after it are still in the bin.
    expect(held.succeeded).toBeGreaterThan(0);
    expect(remaining).toBe(learned.rows - held.succeeded);
  });

  it("ends a failed job with the result it had gathered: the ids it changed, the errors it reported and its counts", async () => {
    // Bookmarks outnumber notes, so the notes a chunk changes stay within the
    // hundred ids a result lists whatever the chunk size.
    const tag = fresh("failed-result");
    const notes = Math.ceil(learned.rows / 4);
    const bookmarks = learned.rows - notes;
    expect(notes).toBeGreaterThan(0);
    // Interleaved, so the first chunk holds both whatever order it takes them in.
    await seed(working, tag, notes + bookmarks, {
      type: (at) => (at % 4 === 0 ? "core.note" : "core.bookmark"),
    });
    const holder = await keyHolding("failed-result", {
      type_permissions: { "core.note": "write", "core.bookmark": "write" },
    });

    // The key may no longer write bookmarks when the job's first chunk runs,
    // and is revoked once that chunk is written.
    await server.setFault(HOLD.claimed);
    await server.setFault(HOLD.betweenChunks);
    const id = await start(holder.client, {
      action: "update_tags",
      add: [`${tag}-done`],
      filter: { tags: [tag] },
    });
    await server.waitForHold(HOLD.claimed);
    const narrowed = await operator.updateKey(holder.id, {
      type_permissions: { "core.note": "write", "core.bookmark": "read" },
    });
    expect(narrowed.status, JSON.stringify(narrowed.error)).toBe(200);
    await server.clearFault(HOLD.claimed);
    await server.waitForHold(HOLD.betweenChunks);
    const held = await jobOf(holder.client, id);
    expect(held.processed).toBeGreaterThan(0);
    expect(held.succeeded).toBeGreaterThan(0);
    expect(held.succeeded).toBeLessThanOrEqual(100);
    expect(held.errored).toBeGreaterThan(0);

    expect((await operator.revokeKey(holder.id)).status).toBe(200);
    await server.clearFault();
    const failed = await operator.pollBulkActionToTerminal(id);
    expect(failed.status).toBe("failed");

    const changed = await idsWith(working, `${tag}-done`);
    expect(changed).toHaveLength(held.succeeded);
    expect(failed.result).toMatchObject({
      matched: learned.rows,
      succeeded: held.succeeded,
      errored: held.errored,
    });
    expect([...(failed.result?.ids ?? [])].sort()).toEqual([...changed].sort());
    const errors = failed.result?.errors ?? [];
    expect(errors.length).toBeGreaterThan(0);
    for (const entry of errors) {
      expect(entry.code).toBe("type_not_permitted");
      expect(changed).not.toContain(entry.id);
    }
  });
});

describe("a key's types that change while its job runs", () => {
  /** A job over notes and bookmarks whose key has its bookmarks changed
   *  before the first chunk, then run to the end. */
  async function runWithBookmarks(
    typePermissions: Record<string, string>,
  ): Promise<{
    job: BulkActionJob;
    noteIds: string[];
    bookmarkIds: string[];
    marker: string;
  }> {
    const tag = fresh("type-lost");
    await seed(working, tag, 3);
    await seed(working, tag, 3, { type: "core.bookmark" });
    const holder = await keyHolding("type-lost", {
      type_permissions: { "core.note": "write", "core.bookmark": "write" },
    });
    await server.setFault(HOLD.claimed);
    const marker = `${tag}-done`;
    const id = await start(holder.client, {
      action: "update_tags",
      add: [marker],
      filter: { tags: [tag] },
    });
    await server.waitForHold(HOLD.claimed);
    const changed = await operator.updateKey(holder.id, {
      type_permissions: typePermissions,
    });
    expect(changed.status, JSON.stringify(changed.error)).toBe(200);
    await server.clearFault();
    const job = await operator.pollBulkActionToTerminal(id);
    const all = await idsWith(working, tag);
    const bookmarkIds = (
      await working.listItems({
        tags: [tag],
        type: "core.bookmark",
        limit: 200,
      })
    ).data.data.map((item) => item.id);
    return {
      job,
      noteIds: all.filter((item) => !bookmarkIds.includes(item)),
      bookmarkIds,
      marker,
    };
  }

  it("reports an item of a type it may still read, and no longer write, as type_not_permitted, and goes on", async () => {
    const { job, noteIds, bookmarkIds, marker } = await runWithBookmarks({
      "core.note": "write",
      "core.bookmark": "read",
    });
    expect(job).toMatchObject({
      status: "completed",
      succeeded: 3,
      errored: 3,
    });
    expect((job.result?.errors ?? []).map((entry) => entry.id).sort()).toEqual(
      [...bookmarkIds].sort(),
    );
    for (const entry of job.result?.errors ?? []) {
      expect(entry.code).toBe("type_not_permitted");
    }
    expect((await idsWith(working, marker)).sort()).toEqual(
      [...noteIds].sort(),
    );
  });

  it("reports an item of a type it may no longer read as item_not_found, naming no type, and goes on", async () => {
    const { job, noteIds, bookmarkIds, marker } = await runWithBookmarks({
      "core.note": "write",
    });
    expect(job).toMatchObject({
      status: "completed",
      succeeded: 3,
      errored: 3,
    });
    const errors = job.result?.errors ?? [];
    expect(errors.map((entry) => entry.id).sort()).toEqual(
      [...bookmarkIds].sort(),
    );
    for (const entry of errors) {
      expect(entry.code).toBe("item_not_found");
      expect(JSON.stringify(entry)).not.toContain("core.bookmark");
    }
    expect((await idsWith(working, marker)).sort()).toEqual(
      [...noteIds].sort(),
    );
  });
});

const LEVERS: [
  string,
  (keyId: string) => Promise<{ status: number; error?: unknown }>,
][] = [
  [
    "the key's own",
    async (keyId: string) =>
      operator.updateKey(keyId, {
        enforcement_override: {
          source_filter: { types: ["core.note"], sources: [SHOWN] },
        },
      }),
  ],
  [
    "the instance's",
    async () =>
      operator.updateConfig({
        enforcement: {
          source_filter: { types: ["core.note"], sources: [SHOWN] },
        },
      }),
  ],
];

describe("a source filter that comes to hide items while its job runs", () => {
  it.each(LEVERS)(
    "reports a hidden item as item_not_found, naming no type, and goes on (%s lever)",
    async (_which, narrow) => {
      const tag = fresh("source-hidden");
      await seed(await writerOf(SHOWN), tag, 3);
      await seed(await writerOf("hidden"), tag, 3);

      const hidden = (
        await working.listItems({ tags: [tag], source: "hidden", limit: 200 })
      ).data.data.map((item) => item.id);
      expect(hidden).toHaveLength(3);
      const holder = await keyHolding("source-hidden", {});
      await server.setFault(HOLD.claimed);
      const marker = `${tag}-done`;
      const id = await start(holder.client, {
        action: "update_tags",
        add: [marker],
        filter: { tags: [tag] },
      });
      await server.waitForHold(HOLD.claimed);
      const narrowed = await narrow(holder.id);
      expect(narrowed.status, JSON.stringify(narrowed.error)).toBe(200);
      await server.clearFault();

      const job = await operator.pollBulkActionToTerminal(id);
      expect(job).toMatchObject({
        status: "completed",
        succeeded: 3,
        errored: 3,
      });
      const errors = job.result?.errors ?? [];
      expect(errors.map((entry) => entry.id).sort()).toEqual(
        [...hidden].sort(),
      );
      for (const entry of errors) {
        expect(entry.code).toBe("item_not_found");
        expect(JSON.stringify(entry)).not.toContain("core.note");
      }
      // The instance's own lever would hide the rows from this read too.
      expect((await operator.updateConfig({})).status).toBe(200);
      const written = await idsWith(working, marker);
      expect(written).toHaveLength(3);
      for (const id of written) expect(hidden).not.toContain(id);
    },
  );
});

/** The key that writes under `name`, minted once: a source belongs to one key. */
const writers = new Map<string, MarfaClient>();
async function writerOf(name: string): Promise<MarfaClient> {
  const known = writers.get(name);
  if (known !== undefined) return known;
  const minted = await working.createKey({
    label: `${name}-writer`,
    source: name,
    type_permissions: { "core.note": "write" },
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  const client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: minted.data.key,
  });
  writers.set(name, client);
  return client;
}

describe("a strict mode that is set while its job waits", () => {
  const PATCH = { not_a_real_field: "x" };

  it("is asked of every row the job writes, as it stands then", async () => {
    const tag = fresh("strict-set");
    await seed(working, tag, 3);
    // The witness: with the lever off the patch lands, so what refuses the
    // rows below is the lever.
    const before = await queue(working, {
      action: "update_properties",
      patch: PATCH,
      filter: { tags: [tag] },
    });
    expect((await working.pollBulkActionToTerminal(before)).status).toBe(
      "completed",
    );
    const first = await working.getItem((await idsWith(working, tag))[0]!);
    expect(first.data.item.properties.not_a_real_field).toBe("x");

    const other = fresh("strict-set-held");
    await seed(working, other, 3);
    await server.setFault(HOLD.claimed);
    const id = await start(working, {
      action: "update_properties",
      patch: PATCH,
      filter: { tags: [other] },
    });
    await server.waitForHold(HOLD.claimed);
    const set = await operator.updateConfig({
      enforcement: { strict_mode: { types: ["core.note"] } },
    });
    expect(set.status, JSON.stringify(set.error)).toBe(200);
    await server.clearFault();

    const job = await working.pollBulkActionToTerminal(id);
    expect(job).toMatchObject({
      status: "completed",
      succeeded: 0,
      errored: 3,
    });
    for (const entry of job.result?.errors ?? []) {
      expect(entry.code).toBe("invalid_properties");
      expect(entry.details?.code).toBe("unknown_property");
    }
    for (const item of await idsWith(working, other)) {
      expect(
        (await working.getItem(item)).data.item.properties.not_a_real_field,
      ).toBeUndefined();
    }
  });

  it("is asked for the credential as it stands then, so a key loosened while the job waits writes its rows", async () => {
    expect(
      (
        await operator.updateConfig({
          enforcement: { strict_mode: { types: ["core.note"] } },
        })
      ).status,
    ).toBe(200);
    const tag = fresh("strict-key");
    await seed(working, tag, 3);
    const holder = await keyHolding("strict-key", {});
    // The witness: the instance's lever refuses the patch for this key.
    const refused = await queue(holder.client, {
      action: "update_properties",
      patch: PATCH,
      filter: { tags: [tag] },
    });
    expect(await holder.client.pollBulkActionToTerminal(refused)).toMatchObject(
      { status: "completed", succeeded: 0, errored: 3 },
    );

    await server.setFault(HOLD.claimed);
    const id = await start(holder.client, {
      action: "update_properties",
      patch: PATCH,
      filter: { tags: [tag] },
    });
    await server.waitForHold(HOLD.claimed);
    const loosened = await operator.updateKey(holder.id, {
      enforcement_override: { strict_mode: { types: [] } },
    });
    expect(loosened.status, JSON.stringify(loosened.error)).toBe(200);
    await server.clearFault();

    const job = await holder.client.pollBulkActionToTerminal(id);
    expect(job).toMatchObject({
      status: "completed",
      succeeded: 3,
      errored: 0,
    });
    for (const item of await idsWith(working, tag)) {
      expect(
        (await working.getItem(item)).data.item.properties.not_a_real_field,
      ).toBe("x");
    }
  });
});
