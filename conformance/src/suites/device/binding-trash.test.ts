import { afterEach, describe, expect, it } from "vitest";
import {
  SCRIPTED_INSTANCE,
  answers,
  refusal,
  wireItem,
  type WireItemOptions,
} from "../../device/marfa-answers.js";
import type {
  BindingItem,
  BindingTrashPreview,
} from "../../device/binding-adapter.js";
import {
  BUILT_FOR,
  type Answer,
  type RecordedRequest,
} from "../../device/scripted-server.js";
import { scriptWrites } from "./harness.js";
import { bindingHarness, type Followed } from "./binding.shared.js";

/**
 * A several-item trash through the binding (the device chapter's
 * `device/trash-*` statements): the preview, the trash the server accepts,
 * and every refusal the copy makes before or after sending it. The command
 * line has no several-item trash, so only the binding reaches it.
 */

let harness: Followed | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const NAMED = "01900000-0000-7000-8000-0000000000b1";
const ALSO = "01900000-0000-7000-8000-0000000000b2";
const TAKEN = "01900000-0000-7000-8000-0000000000b3";
const KEEP = "01900000-0000-7000-8000-0000000000b4";
const UNHELD = "01900000-0000-7000-8000-0000000000b5";
const DIGEST = "a".repeat(64);

interface Holding {
  harness: Followed;
  /** The rows the server holds, which an accepted trash moves to the bin. */
  rows: Array<{ item: WireItemOptions }>;
  /** What the server answers each preview with. */
  preview: Answer;
  /** What the server answers each trash with. */
  trash: (request: RecordedRequest) => Answer;
  /** Moves the instance at the copy's origin to another one. */
  replace: () => void;
}

/** A copy holding four active notes, each at version 1. */
async function holding(label: string): Promise<Holding> {
  const rows = [NAMED, ALSO, TAKEN, KEEP].map((id) => ({
    item: { id, version: 1 } as WireItemOptions,
  }));
  let instance = SCRIPTED_INSTANCE;
  const unscripted = refusal(500, "internal_error", "no answer was scripted");
  const held: Omit<Holding, "harness"> = {
    rows,
    preview: unscripted,
    trash: () => unscripted,
    replace: () => {
      instance = "00000000-0000-7000-8000-0000000000ff";
    },
  };
  const started = await bindingHarness(label, {
    instance: () => instance,
    items: { "core.note": rows },
    setup: ({ server }) => {
      server.copyAnswer("GET", "/", () =>
        answers.root(Number(BUILT_FOR), instance),
      );
      server.answer("POST", "/items/trash-preview", () => held.preview);
      server.answer("POST", "/items/trash", (request) => held.trash(request));
    },
  });
  harness = started;
  return Object.assign(held, { harness: started });
}

function rowOf(rows: Holding["rows"], request: RecordedRequest) {
  const id = decodeURIComponent(request.pathname.split("/")[2] ?? "");
  const row = rows.find((candidate) => candidate.item.id === id);
  if (row === undefined) throw new Error(`no row ${id} is scripted`);
  return row;
}

/** Takes an edit as the server does, a version on, and reads the row back. */
function scriptEdits(held: Holding): void {
  scriptWrites(held.harness.server, {
    update: [
      (request) => {
        const row = rowOf(held.rows, request);
        row.item.version = (row.item.version ?? 1) + 1;
        row.item.properties = {
          title: "edited",
          body: `body of ${row.item.id}`,
        };
        return answers.updated(wireItem(row.item));
      },
    ],
    read: [
      (request) => answers.updated(wireItem(rowOf(held.rows, request).item)),
    ],
  });
}

/** The server's preview of `named`, each taking what `takes` lists for it. */
function previewAnswer(
  named: string[],
  takes: Record<string, string[]> = {},
  truncated: string[] = [],
  versionOf: (id: string) => number = () => 1,
): Answer {
  const items = named.map((id) => ({
    id,
    type: "core.note",
    version: versionOf(id),
    takes: (takes[id] ?? []).map((taken) => ({
      id: taken,
      type: "core.note",
      version: versionOf(taken),
    })),
    count: 1 + (takes[id] ?? []).length,
    ...(truncated.includes(id) ? { truncated: true } : {}),
  }));
  return {
    kind: "json",
    status: 200,
    body: {
      items,
      count: items.reduce((sum, item) => sum + item.count, 0),
      digest: DIGEST,
    },
  };
}

/**
 * Answers a trash as the server does: each of `ids` goes to the bin a
 * version on, so the copy's bin read finds it there.
 */
function accepting(rows: Holding["rows"], ids: string[]): Holding["trash"] {
  return () => {
    for (const row of rows) {
      if (ids.includes(row.item.id)) {
        row.item.state = "trashed";
        row.item.version = (row.item.version ?? 1) + 1;
      }
    }
    return { kind: "json", status: 200, body: { ok: true } };
  };
}

async function previewed(
  held: Holding,
  named: string[],
  takes: Record<string, string[]> = {},
  truncated: string[] = [],
): Promise<BindingTrashPreview> {
  held.preview = previewAnswer(
    named,
    takes,
    truncated,
    (id) => held.rows.find((row) => row.item.id === id)?.item.version ?? 1,
  );
  const preview = await held.harness.device.previewTrash(named);
  expect(preview.ok, JSON.stringify(preview)).toBe(true);
  if (!preview.ok) throw new Error("the preview was refused");
  return preview.value;
}

function sent(held: Holding, pathname: string): RecordedRequest[] {
  return held.harness.server.requests.filter(
    (request) => request.method === "POST" && request.pathname === pathname,
  );
}

/** The state and version the copy shows `id` at, in the bin or out of it. */
async function stateOf(
  held: Holding,
  id: string,
): Promise<[string, number] | null> {
  const listed = await held.harness.device.call<{ items: BindingItem[] }>(
    "list",
    { allStates: true },
  );
  expect(listed.ok, JSON.stringify(listed)).toBe(true);
  const item = listed.ok
    ? listed.value.items.find((row) => row.id === id)
    : undefined;
  return item === undefined ? null : [item.state, item.version];
}

async function queued(held: Holding): Promise<string[]> {
  const queue = await held.harness.device.queue();
  expect(queue.ok, JSON.stringify(queue)).toBe(true);
  return queue.ok ? queue.value.map((write) => write.id) : [];
}

/** Queues an edit to `id` and answers the write's id. */
async function edit(held: Holding, id: string): Promise<string> {
  const edited = await held.harness.device.updateItem(id, {
    properties: { title: "edited" },
    baseVersion: 1,
  });
  expect(edited.ok, JSON.stringify(edited)).toBe(true);
  if (!edited.ok) throw new Error("the edit was refused");
  return edited.value.id;
}

describe("a device shows an accepted several-item trash in the copy", () => {
  it("shows every named and taken item it holds in the bin at the server's version once the trash is accepted", async () => {
    const held = await holding("trash-accepted");
    const preview = await previewed(held, [NAMED, ALSO, UNHELD], {
      [NAMED]: [TAKEN],
    });
    expect(preview.count).toBe(4);
    expect(preview.items.map((item) => item.id)).toEqual([NAMED, ALSO, UNHELD]);
    expect(preview.items[0]?.takes.map((taken) => taken.id)).toEqual([TAKEN]);
    // The witness: the preview moved nothing, in the copy or on the server.
    for (const id of [NAMED, ALSO, TAKEN])
      expect(await stateOf(held, id)).toEqual(["active", 1]);

    held.trash = accepting(held.rows, [NAMED, ALSO, TAKEN]);
    const trashed = await held.harness.device.trashItems(preview);
    expect(trashed.ok, JSON.stringify(trashed)).toBe(true);

    const trashes = sent(held, "/items/trash");
    expect(trashes).toHaveLength(1);
    expect(JSON.parse(trashes[0]!.body)).toEqual({
      ids: [NAMED, ALSO, UNHELD],
      digest: DIGEST,
    });
    expect(trashes[0]!.headers["idempotency-key"]).toBeTruthy();
    expect(trashes[0]!.headers["x-marfa-instance-id"]).toBe(SCRIPTED_INSTANCE);
    for (const id of [NAMED, ALSO, TAKEN])
      expect(await stateOf(held, id), id).toEqual(["trashed", 2]);
    expect(await stateOf(held, KEEP)).toEqual(["active", 1]);
    expect(
      await stateOf(held, UNHELD),
      "the copy took a row it never held",
    ).toBeNull();
    expect(await queued(held)).toEqual([]);
  });
});

describe("a device keeps the copy when the server refuses a several-item trash", () => {
  it("leaves the copy and the queue as they were and answers the server's own error when the server refuses the trash", async () => {
    for (const [status, code] of [
      [409, "trash_plan_changed"],
      [400, "edge_constraint_violation"],
    ] as const) {
      const held = await holding(`trash-refused-${code}`);
      const waiting = await edit(held, KEEP);
      const preview = await previewed(held, [NAMED], { [NAMED]: [TAKEN] });
      held.trash = () => refusal(status, code, "refused");
      const refused = await held.harness.device.trashItems(preview);
      expect(refused.ok, "a refused trash was taken as done").toBe(false);
      if (!refused.ok)
        expect(refused.refusal.server).toMatchObject({ status, code });
      // The witness: the trash was sent, so the server's answer is what kept
      // the copy.
      expect(sent(held, "/items/trash")).toHaveLength(1);
      for (const id of [NAMED, TAKEN])
        expect(await stateOf(held, id), id).toEqual(["active", 1]);
      expect(await queued(held)).toEqual([waiting]);
      await held.harness.stop();
      harness = undefined;
    }
  });
});

describe("a device sends no several-item trash while a write to its items waits", () => {
  it("refuses the trash invalid, sending nothing, while a write to a named item has no answer yet", async () => {
    const held = await holding("trash-waiting-named");
    const unrelated = await edit(held, KEEP);
    const preview = await previewed(held, [NAMED], { [NAMED]: [TAKEN] });
    const waiting = await edit(held, NAMED);

    const refused = await held.harness.device.trashItems(preview);
    expect(refused.ok, "a trash went out ahead of a write to its item").toBe(
      false,
    );
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("invalid");
      expect(refused.refusal.raw).toContain(waiting);
      expect(refused.refusal.raw).not.toContain(unrelated);
    }
    expect(sent(held, "/items/trash")).toEqual([]);
    expect(await queued(held)).toEqual([unrelated, waiting]);
    expect(await stateOf(held, NAMED)).toEqual(["active", 1]);

    // The witness: once a drain has the write answered, the items previewed
    // again are trashed.
    scriptEdits(held);
    const drained = await held.harness.device.drain();
    expect(drained.ok && drained.value.answered, JSON.stringify(drained)).toBe(
      2,
    );
    const again = await previewed(held, [NAMED], { [NAMED]: [TAKEN] });
    held.trash = accepting(held.rows, [NAMED, TAKEN]);
    const trashed = await held.harness.device.trashItems(again);
    expect(trashed.ok, JSON.stringify(trashed)).toBe(true);
    expect(await stateOf(held, NAMED)).toEqual(["trashed", 3]);
  });

  it("refuses the trash invalid, sending nothing, while a write to a taken item is dead", async () => {
    const held = await holding("trash-dead-taken");
    const preview = await previewed(held, [NAMED], { [NAMED]: [TAKEN] });
    const dead = await edit(held, TAKEN);
    // A key the server reports in flight counts at every drain, and the
    // fifth makes the write dead.
    scriptWrites(held.harness.server, {
      update: [
        refusal(409, "idempotency_key_in_flight", "The key is in flight"),
      ],
    });
    for (let pass = 0; pass < 5; pass += 1)
      expect((await held.harness.device.drain()).ok).toBe(true);
    const queue = await held.harness.device.queue();
    expect(
      queue.ok &&
        queue.value.map((write) => [write.id, write.verdict?.verdict]),
    ).toEqual([[dead, "dead"]]);

    const refused = await held.harness.device.trashItems(preview);
    expect(refused.ok, "a trash went out over a dead write").toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("invalid");
      expect(refused.refusal.raw).toContain(dead);
      expect(
        refused.refusal.raw,
        "the refusal does not name a command that clears a dead write",
      ).toContain("withdraw");
    }
    expect(sent(held, "/items/trash")).toEqual([]);
    expect(await queued(held)).toEqual([dead]);

    // The witness: once the command the refusal names takes the write out,
    // the same trash goes.
    scriptWrites(held.harness.server, {
      read: [answers.updated(wireItem({ id: TAKEN, version: 1 }))],
    });
    const withdrawn = await held.harness.device.withdraw(dead);
    expect(withdrawn.ok, JSON.stringify(withdrawn)).toBe(true);
    held.trash = accepting(held.rows, [NAMED, TAKEN]);
    const trashed = await held.harness.device.trashItems(preview);
    expect(trashed.ok, JSON.stringify(trashed)).toBe(true);
    expect(await stateOf(held, TAKEN)).toEqual(["trashed", 2]);
  });

  it("refuses a trash whose preview was cut while a write to any item waits, sending nothing", async () => {
    const held = await holding("trash-waiting-cut");
    const unrelated = await edit(held, KEEP);
    const cut = await previewed(held, [NAMED], { [NAMED]: [TAKEN] }, [NAMED]);
    expect(cut.items[0]?.truncated).toBe(true);

    const refused = await held.harness.device.trashItems(cut);
    expect(
      refused.ok,
      "a trash went out though its preview could not rule the write out",
    ).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("invalid");
      expect(refused.refusal.raw).toContain(unrelated);
    }
    expect(sent(held, "/items/trash")).toEqual([]);
    expect(await queued(held)).toEqual([unrelated]);

    // The witness: the same items, previewed whole, are trashed while that
    // write still waits.
    const whole = await previewed(held, [NAMED], { [NAMED]: [TAKEN] });
    held.trash = accepting(held.rows, [NAMED, TAKEN]);
    const trashed = await held.harness.device.trashItems(whole);
    expect(trashed.ok, JSON.stringify(trashed)).toBe(true);
    expect(await queued(held)).toEqual([unrelated]);
  });
});

describe("a device bounds the items a preview or a several-item trash names", () => {
  it("refuses a preview or a trash of no item or of more than 20 distinct items, sending nothing", async () => {
    const held = await holding("trash-bounds");
    const many = Array.from(
      { length: 21 },
      (_, n) => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    );
    for (const ids of [[], many]) {
      const refused = await held.harness.device.previewTrash(ids);
      expect(refused.ok, `a preview of ${ids.length} items was asked`).toBe(
        false,
      );
      if (!refused.ok) {
        expect(refused.refusal.code).toBe("validation");
        expect(refused.refusal.raw).toContain("validation_error");
      }
    }
    expect(sent(held, "/items/trash-preview")).toEqual([]);

    for (const ids of [[], many]) {
      const refused = await held.harness.device.trashItems({
        items: ids.map((id) => ({
          id,
          type: "core.note",
          version: 1,
          takes: [],
          count: 1,
          truncated: false,
        })),
        count: ids.length,
        digest: DIGEST,
      });
      expect(refused.ok, `a trash of ${ids.length} items was sent`).toBe(false);
      if (!refused.ok) {
        expect(refused.refusal.code).toBe("validation");
        expect(refused.refusal.raw).toContain("validation_error");
      }
    }
    expect(sent(held, "/items/trash")).toEqual([]);

    // The witness: 20 distinct items, one of them named twice, are asked
    // for, each once.
    const twenty = [...many.slice(0, 20), many[0]!];
    held.preview = previewAnswer(many.slice(0, 20));
    const preview = await held.harness.device.previewTrash(twenty);
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    const previews = sent(held, "/items/trash-preview");
    expect(previews).toHaveLength(1);
    expect(JSON.parse(previews[0]!.body)).toEqual({ ids: many.slice(0, 20) });
  });
});

describe("a device keeps the copy when a several-item trash cannot be sent", () => {
  it("refuses a preview and a trash network while the server cannot be reached, keeping the copy and the queue", async () => {
    const held = await holding("trash-unsent");
    const waiting = await edit(held, KEEP);
    const preview = await previewed(held, [NAMED], { [NAMED]: [TAKEN] });
    held.trash = accepting(held.rows, [NAMED, TAKEN]);
    await held.harness.server.offline();
    const unpreviewed = await held.harness.device.previewTrash([NAMED]);
    const untrashed = await held.harness.device.trashItems(preview);
    await held.harness.server.online();
    expect(unpreviewed.ok, "a preview answered with no server").toBe(false);
    if (!unpreviewed.ok) expect(unpreviewed.refusal.code).toBe("network");
    expect(untrashed.ok, "a trash that was never sent was taken as done").toBe(
      false,
    );
    if (!untrashed.ok) expect(untrashed.refusal.code).toBe("network");
    for (const id of [NAMED, TAKEN])
      expect(await stateOf(held, id), id).toEqual(["active", 1]);
    expect(await queued(held)).toEqual([waiting]);

    // The witness: the same trash, once the server is back, goes and is
    // shown.
    const trashed = await held.harness.device.trashItems(preview);
    expect(trashed.ok, JSON.stringify(trashed)).toBe(true);
    expect(await stateOf(held, NAMED)).toEqual(["trashed", 2]);
  });
});

describe("a device confirms the instance before a preview or a several-item trash", () => {
  it("asks no preview of another instance at the copy's origin, and expires the copy", async () => {
    const held = await holding("trash-preview-other-instance");
    held.preview = previewAnswer([NAMED]);
    held.replace();
    const refused = await held.harness.device.previewTrash([NAMED]);
    expect(refused.ok, "a preview was asked of another instance").toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("copy_expired");
    expect(sent(held, "/items/trash-preview")).toEqual([]);
    const status = await held.harness.device.status();
    expect(status.ok ? status.value.hydration : status).toBe("expired");
  });

  it("sends no trash to another instance at the copy's origin, and expires the copy", async () => {
    const held = await holding("trash-other-instance");
    const preview = await previewed(held, [NAMED]);
    held.trash = accepting(held.rows, [NAMED]);
    held.replace();
    const refused = await held.harness.device.trashItems(preview);
    expect(refused.ok, "a trash was sent to another instance").toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("copy_expired");
    expect(sent(held, "/items/trash")).toEqual([]);
    const status = await held.harness.device.status();
    expect(status.ok ? status.value.hydration : status).toBe("expired");
  });
});

describe("a device keeps the copy while a several-item trash's outcome is unknown", () => {
  it("keeps the copy and refuses network when a trash that was sent is never answered", async () => {
    const held = await holding("trash-unanswered");
    const preview = await previewed(held, [NAMED], { [NAMED]: [TAKEN] });
    held.trash = () => ({ kind: "drop" });
    const refused = await held.harness.device.trashItems(preview);
    expect(refused.ok, "a trash nobody answered was taken as done").toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("network");
    expect(
      sent(held, "/items/trash"),
      "the trash never left the device",
    ).toHaveLength(1);
    for (const id of [NAMED, TAKEN])
      expect(await stateOf(held, id), id).toEqual(["active", 1]);
    expect(await queued(held)).toEqual([]);
  });
});
