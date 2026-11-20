import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import { createBookmark } from "../../generators/items.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  callTool,
  connectMcp,
  toolError,
  toolResult,
  type McpConnection,
} from "../../utils/mcp.js";

/**
 * `marfa_purge` on a server of its own, so the trash holds only what a test
 * puts there, and the clock and a write's faults can be scripted.
 */
const CONFIRMATION_LIFE_MS = 5 * 60 * 1000;

let server: FreshServer;
let admin: McpConnection;

beforeAll(async () => {
  server = await bootFreshServer("mcp-purge");
  admin = await connectMcp(
    server.apiUrl,
    server.workingKey,
    "2026-07-28",
    "/mcp/admin",
  );
}, FRESH_SERVER_TIMEOUT_MS);

afterEach(async () => {
  await server.clearFault();
});

afterAll(async () => {
  await admin?.close();
  await stopFreshServers();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function owner(): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}

async function note(body: string, tags: string[] = []): Promise<string> {
  const made = await owner().createItem({
    type: "core.note",
    properties: { body },
    tags,
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return made.data.item.id;
}

async function attach(part: string, host: string): Promise<string> {
  const made = await owner().createEdge({
    from_id: part,
    to_id: host,
    edge_type: "attached-to",
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return made.data.edge.id;
}

async function trash(...ids: string[]): Promise<void> {
  for (const id of ids) {
    const done = await owner().deleteItem(id);
    expect(done.status, JSON.stringify(done.error)).toBe(200);
  }
}

/** Every id in the trash, as the owner's key lists it. */
async function binned(): Promise<Set<string>> {
  const listed = await owner().listItems({ state: "trashed", limit: 500 });
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  return new Set(listed.data.data.map((item) => item.id));
}

/** Whether no state holds the item any more. */
async function gone(id: string): Promise<boolean> {
  if ((await binned()).has(id)) return false;
  return (await owner().getItem(id)).status === 404;
}

/** Empties the trash, so each test counts only what it put there. */
async function emptied(): Promise<void> {
  for (const id of await binned()) {
    await owner().purgeItem(id);
  }
  expect((await binned()).size).toBe(0);
}

async function keyFor(
  label: string,
  typePermissions?: Record<string, string>,
): Promise<string> {
  const minted = await owner().createKey({
    label: `mcp-purge-${label}`,
    source: `mcp-purge-${label}`,
    permissions: ["items.purge"],
    ...(typePermissions && {
      type_permissions: typePermissions,
      edge_permissions: { "*": "write" },
    }),
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  return minted.data.key;
}

async function preview(
  args: Record<string, unknown>,
  connection = admin,
): Promise<Record<string, unknown>> {
  return toolResult(await callTool(connection, "marfa_purge", args));
}

describe("marfa_purge previews and purges", () => {
  it("purges nothing when called without a confirmation", async () => {
    const id = await note("previewed only");
    await trash(id);
    const shown = await preview({ ids: [id] });
    expect(shown.ids).toEqual([id]);
    expect(shown.total).toBe(1);
    expect(typeof shown.confirm).toBe("string");
    expect((await binned()).has(id)).toBe(true);
  });

  it("purges the named items, everything their walk takes and what they hold with the confirmation the preview gave", async () => {
    await emptied();
    const host = await note("host of a purge", ["kept-tag"]);
    const edited = await owner().updateItem(host, {
      version: 1,
      properties: { body: "host of a purge, edited" },
    });
    expect(edited.status, JSON.stringify(edited.error)).toBe(200);
    const part = await note("part of a purge");
    const edge = await attach(part, host);
    const other = await note("named beside the host");
    const left = await note("left in the trash");
    await trash(host, other, left);
    const ids = [host, other];

    const shown = await preview({ ids });
    expect(shown.total).toBe(3);
    expect(
      (shown.items as { id: string }[]).map((item) => item.id).sort(),
    ).toEqual([host, part, other].sort());
    expect(shown.edges).toBe(1);
    expect(shown.hidden).toEqual({ items: 0, edges: 0 });
    const held = shown.goes_with as Record<string, number>;
    expect(held.tags).toBe(1);
    // The host's first version, which its edit kept.
    expect(held.versions).toBe(1);

    const done = toolResult(
      await callTool(admin, "marfa_purge", { ids, confirm: shown.confirm }),
    );
    expect(done.purged).toBe(3);
    expect(done.trash_remaining).toBe(1);
    for (const id of [host, part, other]) {
      expect(await gone(id), id).toBe(true);
    }
    expect((await owner().getEdge(edge)).status).toBe(404);
    // The witness that the purge took only the walk.
    expect((await binned()).has(left)).toBe(true);
  });

  it("purges a part shared by two named hosts with them, where naming one host leaves it", async () => {
    const part = await note("part of two hosts");
    const first = await note("first host");
    const second = await note("second host");
    await attach(part, first);
    await attach(part, second);
    await trash(first, second);
    expect((await binned()).has(part)).toBe(true);

    // The witness: one host alone does not take the part it shares.
    const alone = await preview({ ids: [second] });
    expect(alone.total).toBe(1);

    const both = await preview({ ids: [first, second] });
    expect(both.total).toBe(3);
    const done = toolResult(
      await callTool(admin, "marfa_purge", {
        ids: [second, first],
        confirm: both.confirm,
      }),
    );
    expect(done.purged).toBe(3);
    for (const id of [part, first, second]) {
      expect(await gone(id), id).toBe(true);
    }
  });

  it("previews a page of the trash from a trash cursor and purges it on the ids the preview returned", async () => {
    await emptied();
    const ids = [
      await note("page one"),
      await note("page two"),
      await note("page three"),
    ];
    await trash(...ids);
    const first = toolResult(
      await callTool(admin, "marfa_trash", { limit: 1 }),
    );
    const skipped = (first.items as { id: string }[])[0]?.id;
    expect(typeof first.next_cursor).toBe("string");

    const page = await preview({ page: { cursor: first.next_cursor } });
    const named = page.ids as string[];
    expect(named.sort()).toEqual(ids.filter((id) => id !== skipped).sort());
    expect(page.next_cursor).toBeNull();
    const whole = await preview({ page: {} });
    expect((whole.ids as string[]).sort()).toEqual([...ids].sort());

    const refused = toolError(
      await callTool(admin, "marfa_purge", {
        page: {},
        confirm: whole.confirm,
      }),
    );
    expect(refused.code).toBe("validation_error");

    const done = toolResult(
      await callTool(admin, "marfa_purge", {
        ids: named,
        confirm: page.confirm,
      }),
    );
    expect(done.purged).toBe(2);
    expect(done.trash_remaining).toBe(1);
    expect([...(await binned())]).toEqual([skipped]);
  });

  it("answers an empty page of the trash with no confirmation", async () => {
    await emptied();
    const page = await preview({ page: {} });
    expect(page.ids).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.confirm).toBeUndefined();
  });
});

describe("what a marfa_purge confirmation binds", () => {
  it("counts an item and an edge the key cannot read as hidden, and refuses the confirmation once the hidden item leaves the trash", async () => {
    const purger = await connectMcp(
      server.apiUrl,
      await keyFor("notes-only", { "core.note": "write" }),
      "2026-07-28",
      "/mcp/admin",
    );
    try {
      const host = await note("host of a hidden part");
      const made = await owner().createItem(createBookmark());
      expect(made.status, JSON.stringify(made.error)).toBe(201);
      const hidden = made.data.item.id;
      await attach(hidden, host);
      await trash(host);
      expect((await binned()).has(hidden)).toBe(true);

      const shown = await preview({ ids: [host] }, purger);
      expect(shown.total).toBe(2);
      expect(shown.hidden).toEqual({ items: 1, edges: 1 });
      expect(JSON.stringify(shown)).not.toContain(hidden);

      const restored = await owner().restoreItem(hidden);
      expect(restored.status, JSON.stringify(restored.error)).toBe(200);
      const stale = toolError(
        await callTool(purger, "marfa_purge", {
          ids: [host],
          confirm: shown.confirm,
        }),
      );
      expect(stale.code).toBe("confirmation_stale");
      expect((await binned()).has(host)).toBe(true);
      expect(stale.hidden).toEqual({ items: 0, edges: 1 });

      // The witness: the new preview's confirmation purges the host alone.
      const done = toolResult(
        await callTool(purger, "marfa_purge", {
          ids: [host],
          confirm: stale.confirm,
        }),
      );
      expect(done.purged).toBe(1);
      expect(await gone(host)).toBe(true);
      expect((await owner().getItem(hidden)).status).toBe(200);
    } finally {
      await purger.close();
    }
  });

  it("refuses a confirmation when a named item changed since the preview, with a new preview", async () => {
    const id = await note("changed between the calls");
    await trash(id);
    const shown = await preview({ ids: [id] });
    expect((await owner().restoreItem(id)).status).toBe(200);
    const edited = await owner().updateItem(id, {
      version: 1,
      properties: { body: "changed between the calls, edited" },
    });
    expect(edited.status, JSON.stringify(edited.error)).toBe(200);
    await trash(id);
    const stale = toolError(
      await callTool(admin, "marfa_purge", {
        ids: [id],
        confirm: shown.confirm,
      }),
    );
    expect(stale.code).toBe("confirmation_stale");
    expect(stale.message).toContain("This call purged nothing");
    expect((await binned()).has(id)).toBe(true);
    expect(typeof stale.confirm).toBe("string");
    expect(stale.confirm).not.toBe(shown.confirm);

    // The witness: the new preview's confirmation purges it.
    const done = toolResult(
      await callTool(admin, "marfa_purge", {
        ids: [id],
        confirm: stale.confirm,
      }),
    );
    expect(done.purged).toBe(1);
  });

  it("refuses a confirmation when a named item is gone, and purges nothing else it names", async () => {
    const kept = await note("named beside a gone item");
    const purged = await note("purged between the calls");
    await trash(kept, purged);
    const shown = await preview({ ids: [kept, purged] });
    expect((await owner().purgeItem(purged)).status).toBe(200);
    const stale = toolError(
      await callTool(admin, "marfa_purge", {
        ids: [kept, purged],
        confirm: shown.confirm,
      }),
    );
    expect(stale.code).toBe("confirmation_stale");
    expect(stale.confirm).toBeUndefined();
    expect((await binned()).has(kept)).toBe(true);
  });

  it("refuses a confirmation another credential got", async () => {
    const other = await connectMcp(
      server.apiUrl,
      await keyFor("other", { "core.note": "write" }),
      "2026-07-28",
      "/mcp/admin",
    );
    try {
      const id = await note("confirmed by another credential");
      await trash(id);
      const shown = await preview({ ids: [id] }, other);
      const stale = toolError(
        await callTool(admin, "marfa_purge", {
          ids: [id],
          confirm: shown.confirm,
        }),
      );
      expect(stale.code).toBe("confirmation_stale");
      expect(stale.confirm).toBeUndefined();
      expect((await binned()).has(id)).toBe(true);
      // The witness: the credential that got it purges with it.
      const done = toolResult(
        await callTool(other, "marfa_purge", {
          ids: [id],
          confirm: shown.confirm,
        }),
      );
      expect(done.purged).toBe(1);
    } finally {
      await other.close();
    }
  });

  it("refuses a confirmation once five minutes have passed since the preview", async () => {
    const id = await note("kept past the confirmation's life");
    await trash(id);
    const shown = await preview({ ids: [id] });
    await server.advanceClock(CONFIRMATION_LIFE_MS + 1_000);
    const stale = toolError(
      await callTool(admin, "marfa_purge", {
        ids: [id],
        confirm: shown.confirm,
      }),
    );
    expect(stale.code).toBe("confirmation_stale");
    expect(stale.confirm).toBeUndefined();
    expect((await binned()).has(id)).toBe(true);
  });

  it("refuses a confirmation sent with ids its preview did not name before reading them", async () => {
    const id = await note("previewed");
    const unnamed = await note("never previewed");
    await trash(id, unnamed);
    const shown = await preview({ ids: [id] });
    for (const ids of [[unnamed], [id, unnamed], [uuidv7()]]) {
      const stale = toolError(
        await callTool(admin, "marfa_purge", { ids, confirm: shown.confirm }),
      );
      expect(stale.code, JSON.stringify(ids)).toBe("confirmation_stale");
      expect(stale.confirm).toBeUndefined();
    }
    const binnedNow = await binned();
    expect(binnedNow.has(id)).toBe(true);
    expect(binnedNow.has(unnamed)).toBe(true);
  });
});

describe("a marfa_purge confirmation is used once", () => {
  it("purges nothing more on a confirmation an earlier call used, and says it already purged the items", async () => {
    await emptied();
    const id = await note("purged once");
    const left = await note("left in the trash");
    await trash(id, left);
    const shown = await preview({ ids: [id] });
    const first = toolResult(
      await callTool(admin, "marfa_purge", {
        ids: [id],
        confirm: shown.confirm,
      }),
    );
    expect(first.purged).toBe(1);
    const again = toolResult(
      await callTool(admin, "marfa_purge", {
        ids: [id],
        confirm: shown.confirm,
      }),
    );
    expect(again.already_purged).toBe(true);
    expect(again.purged).toBe(1);
    expect(again.trash_remaining).toBe(1);
    expect((await binned()).has(left)).toBe(true);
  });

  it("leaves every item and the confirmation as they were when the confirmed purge fails, and purges them all without the fault", async () => {
    const host = await note("host of a failed purge");
    const part = await note("part of a failed purge");
    const edge = await attach(part, host);
    const other = await note("named beside a failed purge");
    await trash(host, other);
    const ids = [host, other];
    const shown = await preview({ ids });
    expect(shown.total).toBe(3);

    await server.setFault("fail:audit=item.purge");
    const failed = await callTool(admin, "marfa_purge", {
      ids,
      confirm: shown.confirm,
    });
    // The witness that the fault acted inside the purge, after its rows went
    // and before it committed.
    expect(
      (await server.faults()).find((fault) => fault.name === "fail:audit")
        ?.fired,
    ).toBe(1);
    expect(failed.isError).toBe(true);
    const binnedNow = await binned();
    for (const id of [host, part, other]) {
      expect(binnedNow.has(id), id).toBe(true);
    }
    expect((await owner().getEdge(edge)).status).toBe(200);

    await server.clearFault();
    const done = toolResult(
      await callTool(admin, "marfa_purge", { ids, confirm: shown.confirm }),
    );
    expect(done.purged).toBe(3);
    expect(done.already_purged).toBeUndefined();
    for (const id of [host, part, other]) {
      expect(await gone(id), id).toBe(true);
    }
  });
});
