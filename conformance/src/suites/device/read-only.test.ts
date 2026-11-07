import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Harness,
  hydratedHarness,
  scriptHydration,
  scriptWrites,
  startHarness,
} from "./harness.js";
import {
  answers,
  bulkGetOf,
  certifiedRead,
  copyHeadRead,
  copyHeldLog,
  copyItemEvent,
  copyReplay,
  type WireItemOptions,
  wireItem,
} from "../../device/marfa-answers.js";
import { BUILT_FOR, type Responder } from "../../device/scripted-server.js";

/**
 * An item's `read_only` as a working copy holds it. The server's answer for a
 * row is scripted here; what it works out from a connector registration is the
 * server's own chapter (`items.md`).
 */

const NOTE = { type: "core.note", source: "connector.calendar" };
const MINUTE = 60;

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

function withStore(path: string, change: (store: DatabaseSync) => void): void {
  const store = new DatabaseSync(path);
  try {
    change(store);
  } finally {
    store.close();
  }
}

/** Says the copy last read `read_only` this many minutes ago. */
function lastRead(device: Harness["device"], minutes: number): void {
  const at = Math.floor(Date.now() / 1000) - minutes * MINUTE;
  withStore(device.store, (store) => {
    store
      .prepare("UPDATE meta SET value = ? WHERE key = 'read_only_read_at'")
      .run(String(at));
  });
}

/** What a build from before the field left: no column and nothing read. */
function fromBeforeTheField(device: Harness["device"]): void {
  withStore(device.store, (store) => {
    store.exec(
      "DROP INDEX items_read_only; ALTER TABLE items DROP COLUMN read_only; DELETE FROM meta WHERE key = 'read_only_read_at';",
    );
  });
}

/** A copy hydrated from `items`, whose catch-ups read `events` in turn. */
async function followedBy(
  label: string,
  items: WireItemOptions[],
  ...events: Responder[]
): Promise<Harness> {
  const started = await startHarness(label);
  scriptHydration(started.server, {
    head: "1",
    rows: { "core.note": items.map((item) => ({ item })) },
  });
  started.server.copyAnswer("GET", "/events", ...events);
  const hydrated = await started.device.hydrate(["core.note"], "library");
  if (!hydrated.ok) {
    await started.stop();
    throw new Error(JSON.stringify(hydrated.refusal));
  }
  return started;
}

/** Answers the next read of `read_only` with these rows. */
function readAnswers(
  server: Harness["server"],
  ...rows: Array<Record<string, unknown>>
): void {
  server.answer("POST", "/items/bulk-get", () =>
    bulkGetOf(
      rows.map((row) => certifiedRead(answers.updated(row), BUILT_FOR)),
      { withReach: true, system: false },
    ),
  );
}

/** The ids each read of `read_only` asked for. */
function looks(server: Harness["server"]): string[][] {
  return server.requests
    .filter(
      (request) =>
        request.method === "POST" && request.pathname === "/items/bulk-get",
    )
    .map((request) => (JSON.parse(request.body) as { ids: string[] }).ids);
}

async function readOnlyOf(
  device: Harness["device"],
  id: string,
): Promise<boolean> {
  const row = await device.get(id);
  if (!row.ok) throw new Error(JSON.stringify(row.refusal));
  return row.value.read_only;
}

describe("an item's read_only in a working copy", () => {
  it("takes read_only from a hydration and from a later frame", async () => {
    harness = await followedBy(
      "read-only-frames",
      [
        { id: "held", ...NOTE, read_only: true },
        { id: "open", ...NOTE, read_only: false },
      ],
      copyReplay("3", [
        copyItemEvent(
          "2",
          "item.updated",
          wireItem({ id: "held", ...NOTE, version: 2, read_only: false }),
        ),
        copyItemEvent(
          "3",
          "item.updated",
          wireItem({ id: "open", ...NOTE, version: 2, read_only: true }),
        ),
      ]),
    );
    const { device } = harness;
    expect(await readOnlyOf(device, "held")).toBe(true);
    expect(await readOnlyOf(device, "open")).toBe(false);

    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    expect(await readOnlyOf(device, "held")).toBe(false);
    expect(await readOnlyOf(device, "open")).toBe(true);
  });

  it("answers false for a row whose answer leaves read_only out", async () => {
    harness = await hydratedHarness("read-only-left-out", {
      rows: {
        "core.note": [
          { item: { id: "older", read_only: null } },
          // The witness: a row the same hydration took true, so a false on the
          // other row is the field's absence and not a copy that holds nothing.
          { item: { id: "newer", read_only: true } },
        ],
      },
    });
    expect(await readOnlyOf(harness.device, "older")).toBe(false);
    expect(await readOnlyOf(harness.device, "newer")).toBe(true);
  });

  it("answers false for a row saved here until the server answers", async () => {
    harness = await hydratedHarness("read-only-saved-here", {
      rows: { "core.note": [{ item: { id: "n1", read_only: true } }] },
    });
    const { server, device } = harness;
    const made = await device.create({
      type: "core.note",
      properties: { title: "Made here", body: "not sent" },
    });
    if (!made.ok) throw new Error(JSON.stringify(made.refusal));
    const id = String(made.value.item_id ?? made.value.target_id);
    expect(await readOnlyOf(device, id)).toBe(false);

    const answered = wireItem({ id, read_only: true });
    scriptWrites(server, {
      create: [answers.created(answered)],
      read: [answers.updated(answered)],
    });
    const drained = await device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    expect(await readOnlyOf(device, id)).toBe(true);
  });

  it("opens a copy made before read_only with its unsent work, and takes the answer at the next sync", async () => {
    harness = await hydratedHarness("read-only-older-copy", {
      rows: {
        "core.note": [
          { item: { id: "edited", ...NOTE, read_only: true } },
          { item: { id: "plain", ...NOTE, read_only: true } },
        ],
      },
    });
    const { server, device } = harness;
    const edit = await device.update("edited", {
      properties: { title: "unsent", body: "unsent" },
      version: 1,
    });
    expect(edit.ok, JSON.stringify(edit)).toBe(true);
    const made = await device.create({
      type: "core.note",
      properties: { title: "Made here", body: "not sent" },
    });
    if (!made.ok) throw new Error(JSON.stringify(made.refusal));
    const id = String(made.value.item_id ?? made.value.target_id);
    fromBeforeTheField(device);

    // Before any sync, nothing has answered, and the rows read false.
    expect(await readOnlyOf(device, "plain")).toBe(false);
    const before = await device.queue();
    expect(before.ok && before.value.length).toBe(2);

    readAnswers(server, wireItem({ id: "plain", ...NOTE, read_only: true }));
    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);

    expect(await readOnlyOf(device, "plain")).toBe(true);
    expect(await readOnlyOf(device, "edited")).toBe(true);
    expect(await readOnlyOf(device, id)).toBe(false);
    const after = await device.queue();
    expect(after.ok && after.value.map((write) => write.id)).toEqual(
      before.ok && before.value.map((write) => write.id),
    );
    const edited = await device.get("edited");
    expect(edited.ok && edited.value.properties.title).toBe("unsent");
  });

  it("holds every row of a source and type to one row's answer, with no event", async () => {
    harness = await hydratedHarness("read-only-refresh", {
      rows: {
        "core.note": [
          { item: { id: "n1", ...NOTE } },
          { item: { id: "n2", ...NOTE } },
          { item: { id: "n3", ...NOTE } },
          // The witness: a row of another source, which the answer leaves as it was.
          { item: { id: "mine", type: "core.note" } },
        ],
      },
    });
    const { server, device } = harness;
    lastRead(device, 16);
    readAnswers(
      server,
      wireItem({ id: "n1", ...NOTE, read_only: true }),
      wireItem({ id: "mine", type: "core.note" }),
    );
    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);

    const asked = looks(server);
    expect(asked).toHaveLength(1);
    expect(
      asked[0],
      "a read asked for more than one row of a pair",
    ).toHaveLength(2);
    for (const id of ["n1", "n2", "n3"]) {
      const row = await device.get(id);
      expect(row.ok && row.value.read_only, id).toBe(true);
      expect(row.ok && row.value.version, id).toBe(1);
    }
    expect(await readOnlyOf(device, "mine")).toBe(false);
  });

  it("asks nothing within 15 minutes of its last read, and asks again after them", async () => {
    harness = await followedBy(
      "read-only-interval",
      [{ id: "n1", ...NOTE }],
      copyHeadRead("1"),
    );
    const { server, device } = harness;

    lastRead(device, 14);
    expect((await device.catchUp()).ok).toBe(true);
    expect(looks(server)).toHaveLength(0);

    lastRead(device, 16);
    readAnswers(server, wireItem({ id: "n1", ...NOTE, read_only: true }));
    expect((await device.catchUp()).ok).toBe(true);
    expect(looks(server)).toHaveLength(1);
    expect(await readOnlyOf(device, "n1")).toBe(true);

    // The read it just made is the one the next catch-up counts from.
    expect((await device.catchUp()).ok).toBe(true);
    expect(looks(server)).toHaveLength(1);
  });

  it("holds rows to the answer once a held stream reaches the head", async () => {
    harness = await followedBy(
      "read-only-follow",
      [
        { id: "n1", ...NOTE },
        { id: "n2", ...NOTE },
      ],
      copyHeldLog([]),
    );
    const { server, device } = harness;
    lastRead(device, 16);
    readAnswers(server, wireItem({ id: "n1", ...NOTE, read_only: true }));

    const followed = await device.follow(2);
    if (!followed.ok) throw new Error(JSON.stringify(followed.refusal));
    expect(await readOnlyOf(device, "n1")).toBe(true);
    expect(await readOnlyOf(device, "n2")).toBe(true);
    const told = followed.value.changes.filter(
      (change) => change.event === "item.updated",
    );
    expect(told).toHaveLength(1);
    expect(told[0]?.item_id).toBeNull();
  });

  it("keeps an edit waiting on a row whose read_only moves", async () => {
    harness = await hydratedHarness("read-only-under-edit", {
      rows: { "core.note": [{ item: { id: "n1", ...NOTE } }] },
    });
    const { server, device } = harness;
    const edit = await device.update("n1", {
      properties: { title: "unsent", body: "unsent" },
      version: 1,
    });
    if (!edit.ok) throw new Error(JSON.stringify(edit.refusal));
    lastRead(device, 16);
    readAnswers(server, wireItem({ id: "n1", ...NOTE, read_only: true }));
    expect((await device.catchUp()).ok).toBe(true);

    const row = await device.get("n1");
    expect(row.ok && row.value.read_only).toBe(true);
    expect(row.ok && row.value.properties.title).toBe("unsent");
    const queue = await device.queue();
    expect(queue.ok && queue.value.map((write) => write.id)).toEqual([
      edit.value.id,
    ]);
  });

  it("finishes a catch-up whose read of read_only fails, keeping what it holds and asking again", async () => {
    harness = await followedBy(
      "read-only-no-answer",
      [{ id: "n1", ...NOTE, read_only: true }],
      copyReplay("2", [
        copyItemEvent(
          "2",
          "item.created",
          wireItem({ id: "n2", ...NOTE, read_only: true }),
        ),
      ]),
      copyHeadRead("2"),
    );
    const { server, device } = harness;
    lastRead(device, 16);
    server.answer("POST", "/items/bulk-get", {
      kind: "json",
      status: 500,
      body: { error: { code: "internal", message: "no" } },
    });
    readAnswers(server, wireItem({ id: "n1", ...NOTE, read_only: false }));
    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    // The witness that the sync itself finished: its event landed and its
    // cursor moved.
    expect(caught.ok && caught.value.cursor).toBe("2");
    expect(await readOnlyOf(device, "n2")).toBe(true);
    expect(await readOnlyOf(device, "n1")).toBe(true);

    expect((await device.catchUp()).ok).toBe(true);
    expect(looks(server)).toHaveLength(2);
    expect(await readOnlyOf(device, "n1")).toBe(false);
  });

  it("sends an edit of a read-only row, and holds the answer's read_only", async () => {
    harness = await hydratedHarness("read-only-edit", {
      rows: { "core.note": [{ item: { id: "n1", ...NOTE, read_only: true } }] },
    });
    const { server, device } = harness;
    const edit = await device.update("n1", {
      properties: { title: "edited", body: "edited" },
      version: 1,
    });
    expect(edit.ok, JSON.stringify(edit)).toBe(true);

    const answered = wireItem({
      id: "n1",
      ...NOTE,
      version: 2,
      properties: { title: "edited", body: "edited" },
      read_only: true,
    });
    scriptWrites(server, {
      update: [answers.updated(answered)],
      read: [answers.updated(answered)],
    });
    const drained = await device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    expect(drained.ok && drained.value.verdicts.map((v) => v.verdict)).toEqual([
      "accepted",
    ]);
    expect(
      server.requests.some(
        (request) =>
          request.method === "PATCH" && request.pathname.includes("n1"),
      ),
      "the edit of a read-only row never reached the server",
    ).toBe(true);
    const row = await device.get("n1");
    expect(row.ok && row.value.properties.title).toBe("edited");
    expect(row.ok && row.value.read_only).toBe(true);
  });
});
