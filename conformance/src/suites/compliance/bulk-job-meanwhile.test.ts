import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { BulkActionJob } from "../../client/types.js";
import { HOLD, queue } from "../../utils/bulk-jobs.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * What a bulk-action job meets when the instance changes between the request
 * that selects its items and the write: an item edited meanwhile, a setting
 * a type move would rewrite made invalid meanwhile, and items whose purge
 * takes far more than themselves. The target's `hold:bulk-job:*` faults stop
 * the worker at a point a case names, so a change lands there rather than at
 * a race against the worker.
 */
let server: FreshServer;
let operator: MarfaClient;
let working: MarfaClient;

/** Every job a body queued, so `afterEach` leaves the worker free. */
const queued: string[] = [];
let counter = 0;
const fresh = (what: string): string => `${what}-${String((counter += 1))}`;

beforeAll(async () => {
  server = await bootFreshServer("bulk-job-meanwhile");
  operator = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
  working = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterEach(async () => {
  await server.clearFault();
  for (const id of queued.splice(0)) {
    await operator.bulkActionCancel(id);
    await operator.pollBulkActionToTerminal(id);
  }
}, 120_000);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/** Types `<ns>.deal`, `<ns>.contract` and `<ns>.other`, each with a `name`. */
async function dealTypes(): Promise<{
  deal: string;
  contract: string;
  other: string;
}> {
  const ns = fresh("move").replace("-", "");
  const types = {
    deal: `${ns}.deal`,
    contract: `${ns}.contract`,
    other: `${ns}.other`,
  };
  for (const id of Object.values(types)) {
    const r = await working.registerType({
      id,
      fields: { name: { type: "string" } },
    } as never);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
  }
  return types;
}

describe("an item changed after its job selected it", () => {
  /** Two items, a job over both held at its claim, and the first item changed by `edit` meanwhile. */
  async function editedWhileHeld(
    make: (tag: string) => Promise<[string, string]>,
    job: (tag: string, ids: [string, string]) => Promise<string>,
    edit: (id: string) => Promise<void>,
  ): Promise<{ tag: string; ids: [string, string]; ended: BulkActionJob }> {
    const tag = fresh("edited");
    const ids = await make(tag);
    await server.setFault(HOLD.claimed);
    const id = await job(tag, ids);
    queued.push(id);
    await server.waitForHold(HOLD.claimed);
    await edit(ids[0]);
    await server.clearFault();
    const ended = await working.pollBulkActionToTerminal(id);
    expect(ended.status, ended.error).toBe("completed");
    return { tag, ids, ended };
  }

  async function notes(
    tag: string,
    state?: "trashed" | "archived",
  ): Promise<[string, string]> {
    const made: string[] = [];
    for (const title of ["first", "second"]) {
      const r = await working.createItem({
        type: "core.note",
        properties: { title, body: tag },
        tags: [tag],
        ...(state && { state }),
      });
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      made.push(r.data.item.id);
    }
    return made as [string, string];
  }

  async function retitle(id: string): Promise<void> {
    const read = await working.getItem(id);
    expect(read.ok, JSON.stringify(read.error)).toBe(true);
    const r = await working.updateItem(id, {
      properties: { title: "the person's" },
      version: read.data.item.version,
    });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
  }

  async function itemOf(id: string) {
    const read = await working.getItem(id);
    expect(read.ok, JSON.stringify(read.error)).toBe(true);
    return read.data;
  }

  /** An item in the bin, which the item door answers 404. */
  async function binned(tag: string, id: string) {
    const listed = await working.listItems({
      state: "trashed",
      tags: [tag],
      limit: 100,
    });
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    return listed.data.data.find((item) => item.id === id);
  }

  /** The witness: the item the person left alone took the job's write, so the job did write. */
  function reportsOnlyTheEdited(
    ended: BulkActionJob,
    edited: string,
    code: string,
  ): void {
    expect(ended.result).toMatchObject({ succeeded: 1, errored: 1 });
    expect(ended.result?.errors).toHaveLength(1);
    expect(ended.result?.errors?.[0]).toMatchObject({ id: edited, code });
  }

  it("leaves an item updated after it was selected and reports it with the code its own update answers (update_properties)", async () => {
    const { ids, ended } = await editedWhileHeld(
      (tag) => notes(tag),
      (tag) =>
        queue(working, {
          action: "update_properties",
          patch: { title: "the job's" },
          filter: { tags: [tag] },
        }),
      retitle,
    );
    reportsOnlyTheEdited(ended, ids[0], "version_conflict");
    expect((await itemOf(ids[0])).item.properties.title).toBe("the person's");
    expect((await itemOf(ids[1])).item.properties.title).toBe("the job's");
  });

  it("leaves an item edited after it was selected and reports it with the code its own tag change answers (update_tags)", async () => {
    const { ids, ended } = await editedWhileHeld(
      (tag) => notes(tag),
      (tag) =>
        queue(working, {
          action: "update_tags",
          add: [`${tag}-marked`],
          filter: { tags: [tag] },
        }),
      retitle,
    );
    reportsOnlyTheEdited(ended, ids[0], "version_conflict");
    const [edited, left] = [await itemOf(ids[0]), await itemOf(ids[1])];
    expect(edited.item.properties.title).toBe("the person's");
    expect(edited.metadata.tags.some((t) => t.endsWith("-marked"))).toBe(false);
    expect(left.metadata.tags.some((t) => t.endsWith("-marked"))).toBe(true);
  });

  it("leaves an item edited after it was selected and reports it with the code its own purge answers (purge)", async () => {
    const { tag, ids, ended } = await editedWhileHeld(
      (tag) => notes(tag, "trashed"),
      (tag) =>
        queue(working, {
          action: "purge",
          confirm: "PURGE",
          filter: { tags: [tag], state: "trashed" },
        }),
      async (id) => {
        expect((await working.transitionItem(id, "active")).ok).toBe(true);
        await retitle(id);
        expect((await working.transitionItem(id, "trashed")).ok).toBe(true);
      },
    );
    reportsOnlyTheEdited(ended, ids[0], "version_conflict");
    const kept = await binned(tag, ids[0]);
    expect(kept?.properties.title).toBe("the person's");
    expect(await binned(tag, ids[1])).toBeUndefined();
  });

  it("leaves an item moved out of its state after it was selected, and reports it invalid_transition (transition)", async () => {
    const { tag, ids, ended } = await editedWhileHeld(
      (tag) => notes(tag, "archived"),
      (tag) =>
        queue(working, {
          action: "transition",
          state: "active",
          filter: { tags: [tag], state: "archived" },
        }),
      async (id) => {
        expect((await working.transitionItem(id, "trashed")).ok).toBe(true);
      },
    );
    reportsOnlyTheEdited(ended, ids[0], "invalid_transition");
    expect(await binned(tag, ids[0])).toBeDefined();
    expect((await itemOf(ids[1])).item.state).toBe("active");
  });

  it("leaves an item moved to a third type after it was selected, and reports it with the code its own move answers (type move)", async () => {
    const types = await dealTypes();
    const { ids, ended } = await editedWhileHeld(
      async () => {
        const made: string[] = [];
        for (const name of ["first", "second"]) {
          const r = await working.createItem({
            type: types.deal,
            properties: { name },
          });
          expect(r.ok, JSON.stringify(r.error)).toBe(true);
          made.push(r.data.item.id);
        }
        return made as [string, string];
      },
      async () => {
        const moved = await working.moveType(types.deal, {
          to: types.contract,
        });
        expect(moved.status, JSON.stringify(moved.error)).toBe(202);
        return (moved.data as BulkActionJob).id;
      },
      async (id) => {
        const read = await itemOf(id);
        const r = await working.updateItem(id, {
          type: types.other,
          retype: true,
          version: read.item.version,
        });
        expect(r.ok, JSON.stringify(r.error)).toBe(true);
      },
    );
    reportsOnlyTheEdited(ended, ids[0], "version_conflict");
    expect((await itemOf(ids[0])).item.type).toBe(types.other);
    expect((await itemOf(ids[1])).item.type).toBe(types.contract);
  });
});

describe("a type move held before its last step", () => {
  it("rewrites no setting, and says why, when the type it moves to is gone by then", async () => {
    const types = await dealTypes();
    const made = await working.createItem({
      type: types.deal,
      properties: { name: "deal" },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    const shown = await working.createView({
      title: "Deals",
      query: { types: [types.deal] },
    });
    expect(shown.status, JSON.stringify(shown.error)).toBe(201);

    await server.setFault(HOLD.finishing);
    const moved = await working.moveType(types.deal, { to: types.contract });
    expect(moved.status, JSON.stringify(moved.error)).toBe(202);
    const id = (moved.data as BulkActionJob).id;
    queued.push(id);
    await server.waitForHold(HOLD.finishing);
    const gone = await working.deleteType(types.contract, true);
    expect(gone.ok, JSON.stringify(gone.error)).toBe(true);
    await server.clearFault();

    const ended = await working.pollBulkActionToTerminal(id);
    expect(ended.status, ended.error).toBe("completed");
    // The witness that the move reached its last step with nothing left to keep it from rewriting.
    expect(ended.result).toMatchObject({
      succeeded: 1,
      remaining: 0,
      remaining_hidden: false,
      settings_rewritten: false,
      settings_error: { code: "unknown_type" },
    });
    const view = await working.getItem(shown.data.item.id);
    expect(view.ok, JSON.stringify(view.error)).toBe(true);
    expect(view.data.item.properties.query).toEqual({ types: [types.deal] });
  });

  it("rewrites none of the settings, and says why, when one of them would be refused by then", async () => {
    const types = await dealTypes();
    const made = await working.createItem({
      type: types.deal,
      properties: { name: "deal" },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    const linked = `${types.deal.split(".")[0]}.linked`;
    const registered = await working.registerEdgeType({
      id: linked,
      cardinality: "many-to-many",
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    // Settings are rewritten in the order they were made, so the valid view
    // is rewritten before the grouped one refuses.
    const valid = await working.createView({
      title: "Deals",
      query: { types: [types.deal] },
    });
    expect(valid.status, JSON.stringify(valid.error)).toBe(201);
    const grouped = await working.createView({
      title: "Deals by link",
      query: { types: [types.deal] },
      group: { by: `edge[${linked}]` },
    });
    expect(grouped.status, JSON.stringify(grouped.error)).toBe(201);
    const hook = await working.createWebhook({
      url: "http://127.0.0.1:9/hook",
      events: ["item.updated"],
      type_filter: types.deal,
    });
    expect(hook.status, JSON.stringify(hook.error)).toBe(201);

    await server.setFault(HOLD.finishing);
    const moved = await working.moveType(types.deal, { to: types.contract });
    expect(moved.status, JSON.stringify(moved.error)).toBe(202);
    const id = (moved.data as BulkActionJob).id;
    queued.push(id);
    await server.waitForHold(HOLD.finishing);
    const gone = await working.deleteEdgeType(linked);
    expect(gone.ok, JSON.stringify(gone.error)).toBe(true);
    await server.clearFault();

    const ended = await working.pollBulkActionToTerminal(id);
    expect(ended.status, ended.error).toBe("completed");
    // The witness that the move reached its last step with every item moved and `to` registered.
    expect(ended.result).toMatchObject({
      succeeded: 1,
      remaining: 0,
      remaining_hidden: false,
      settings_rewritten: false,
      settings_error: { code: "validation_error" },
    });
    for (const view of [valid, grouped]) {
      const read = await working.getItem(view.data.item.id);
      expect(read.ok, JSON.stringify(read.error)).toBe(true);
      expect(read.data.item.properties.query).toEqual({ types: [types.deal] });
    }
    const kept = await working.getWebhook(hook.data.id);
    expect(kept.ok, JSON.stringify(kept.error)).toBe(true);
    expect(kept.data.type_filter).toBe(types.deal);
    expect((await working.deleteWebhook(hook.data.id)).ok).toBe(true);
  });
});

describe("a purge whose items take their parts with them", () => {
  const HOSTS = 100;
  const PARTS = 5;
  const BODY = "x".repeat(1_024);

  /** `HOSTS` trashed notes carrying `tag`, each with `parts` parts that went to the bin with it. */
  async function trashedHosts(tag: string, parts: number): Promise<void> {
    const hosts = await working.bulkItems({
      atomic: true,
      items: Array.from({ length: HOSTS }, (_, at) => ({
        type: "core.note",
        properties: { body: `${tag}-${String(at)}` },
        tags: [tag],
      })),
    });
    expect(hosts.ok, JSON.stringify(hosts.error)).toBe(true);
    const ids = hosts.data.results.map((entry) => entry.id as string);
    for (let from = 0; from < ids.length; from += 50) {
      const page = await working.bulkItems({
        atomic: true,
        items: ids.slice(from, from + 50).flatMap((host) =>
          Array.from({ length: parts }, () => ({
            type: "core.note",
            properties: { body: BODY },
            tags: [`${tag}-part`],
            edges: { "attached-to": [host] },
          })),
        ),
      });
      expect(page.ok, JSON.stringify(page.error)).toBe(true);
    }
    const binned = await working.pollBulkActionToTerminal(
      await queue(working, {
        action: "transition",
        state: "trashed",
        filter: { tags: [tag] },
      }),
    );
    expect(binned.status, binned.error).toBe("completed");
  }

  /** The `to_offset` of each chunk the job wrote, in order. */
  async function chunksOf(id: string): Promise<number[]> {
    const entries = await working.listAudit({
      action: "items.bulk_action.chunk",
      limit: 200,
    });
    expect(entries.ok, JSON.stringify(entries.error)).toBe(true);
    return entries.data.data
      .filter((entry) => entry.resource_id === id)
      .map((entry) => entry.details.to_offset as number)
      .sort((a, b) => a - b);
  }

  /** Whether any part of `tag`'s hosts is still in the bin. */
  async function partsBinned(tag: string): Promise<boolean> {
    const listed = await working.listItems({
      state: "trashed",
      tags: [`${tag}-part`],
      limit: 1,
    });
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    return listed.data.data.length > 0;
  }

  async function purged(tag: string): Promise<BulkActionJob> {
    const ended = await working.pollBulkActionToTerminal(
      await queue(working, {
        action: "purge",
        confirm: "PURGE",
        filter: { tags: [tag], state: "trashed" },
      }),
    );
    expect(ended.status, ended.error).toBe("completed");
    expect(ended).toMatchObject({ matched: HOSTS, succeeded: HOSTS });
    return ended;
  }

  it("purges the hosts and their parts over more than one transaction", async () => {
    const bare = fresh("hosts-bare");
    await trashedHosts(bare, 0);
    // The witness: the same hosts without parts are purged in one chunk.
    expect(await chunksOf((await purged(bare)).id)).toEqual([HOSTS]);

    const tag = fresh("hosts-with-parts");
    await trashedHosts(tag, PARTS);
    expect(await partsBinned(tag)).toBe(true);
    const chunks = await chunksOf((await purged(tag)).id);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.at(-1)).toBe(HOSTS);
    expect(await partsBinned(tag)).toBe(false);
  });
});
