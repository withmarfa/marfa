import { describe, it, expect, afterEach, vi } from "vitest";
import {
  answers,
  copyItemEvent,
  copyReplay,
  refusal,
  wireItem,
} from "../../device/marfa-answers.js";
import type { Answer } from "../../device/scripted-server.js";
import type { BindingQueuedWrite } from "../../device/binding-adapter.js";
import { scriptWrites } from "./harness.js";
import {
  bindingHarness,
  createsSent,
  quietly,
  queueNotes,
  takeCreates,
  type Followed,
} from "./binding.shared.js";

/**
 * The queue through the binding: the rules that need two calls on one
 * working copy, one of them held where it reads the server, and the rule
 * about the typed value a binding hands an app. The command runs one call
 * in a process of its own, and prints the stored verdict and reason, so
 * none of them can be reached through it.
 */

let harness: Followed | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const HELD = { id: "01a00000-0000-7000-8000-00000000000a", version: 3 };

function held() {
  return {
    "core.note": [
      {
        item: {
          id: HELD.id,
          version: HELD.version,
          properties: { title: "held", body: "held" },
        },
      },
    ],
  };
}

/** An answer the fixture lets through when it chooses. */
function gate(): { until: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const until = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { until, open };
}

async function queueOf(
  device: Followed["device"],
): Promise<BindingQueuedWrite[]> {
  const queue = await device.queue();
  expect(queue.ok, JSON.stringify(queue)).toBe(true);
  return queue.ok ? queue.value : [];
}

/** The row the server holds once another device has moved it on. */
function movedOn(): Answer {
  return answers.updated(
    wireItem({
      id: HELD.id,
      version: HELD.version + 2,
      properties: { title: "theirs", body: "theirs" },
    }),
  );
}

describe("the queue as a binding shows it", () => {
  it("presents a write held behind one the server has not answered as waiting with no verdict, and gives it a verdict once it is answered", async () => {
    harness = await bindingHarness("binding-shows-waiting");
    const { device, server } = harness;
    const created = await device.createItem({
      type: "core.note",
      properties: { title: "parent", body: "parent" },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) return;
    const edit = await device.updateItem(created.value.itemId ?? "", {
      properties: { title: "child" },
      baseVersion: 0,
    });
    expect(edit.ok, JSON.stringify(edit)).toBe(true);
    if (!edit.ok) return;

    // The create meets a network, so the edit behind it must not go.
    const row = wireItem({
      id: created.value.itemId ?? "",
      properties: { title: "parent", body: "parent" },
    });
    scriptWrites(server, {
      create: [{ kind: "drop" }, answers.created(row)],
      update: [
        answers.updated(
          wireItem({
            id: created.value.itemId ?? "",
            version: 2,
            properties: { title: "child", body: "parent" },
          }),
        ),
      ],
      read: [answers.updated(row)],
    });
    const drained = await device.drain();
    expect(drained.ok && drained.value.held, JSON.stringify(drained)).toBe(1);
    const waiting = (await queueOf(device)).find(
      (row) => row.id === edit.value.id,
    );
    expect(waiting?.dependsOn).toEqual([created.value.id]);
    expect(
      [waiting?.waiting, waiting?.verdict?.verdict],
      "a write held behind another was shown with a verdict, or not shown as waiting",
    ).toEqual([true, undefined]);
    const ahead = (await queueOf(device)).find(
      (row) => row.id === created.value.id,
    );
    expect(
      [ahead?.waiting, ahead?.verdict?.verdict],
      "the write that went out unanswered was shown as waiting",
    ).toEqual([false, undefined]);

    // The witness: once the create is answered the edit goes and has a verdict.
    expect((await device.drain()).ok).toBe(true);
    const settled = (await queueOf(device)).find(
      (entry) => entry.id === edit.value.id,
    );
    expect(
      [settled?.waiting, settled?.verdict?.verdict],
      "the write was still shown as waiting once it was answered",
    ).toEqual([false, "accepted"]);
  });
});

describe("two drains in one process", () => {
  it("makes a drain asked for while another runs wait for it, and send only what is still unanswered", async () => {
    harness = await bindingHarness("binding-drains-one-process");
    const { device, server } = harness;
    const [first, second] = await queueNotes(device, "first", "second");
    const sending = gate();
    takeCreates(server, (take) => [
      (request) => ({
        kind: "gated",
        until: sending.until,
        then: take(request),
      }),
    ]);

    const running = device.drain();
    await vi.waitFor(() => {
      expect(createsSent(server)).toEqual([first]);
    });
    const asked = device.drain();
    await quietly(400);
    expect(
      asked.settled,
      "a drain asked for while another ran did not wait for it",
    ).toBe(false);
    expect(
      createsSent(server),
      "the second drain sent the write the first had in flight",
    ).toEqual([first]);

    sending.open();
    const [one, two] = await Promise.all([running, asked]);
    expect(one.ok && one.value.answered, JSON.stringify(one)).toBe(2);
    expect(
      two.ok && two.value.answered,
      "the second drain reported writes the first had answered, or sent them again",
    ).toBe(0);
    expect(
      createsSent(server),
      "a write was sent by both drains, or one was not sent",
    ).toEqual([first, second]);
  });
});

describe("a withdraw while the copy changes under it", () => {
  /** A write blocked `ancestor_unavailable`, and an edit of another property still waiting behind it. */
  async function blocked(
    label: string,
    read: Answer[],
  ): Promise<{
    first: BindingQueuedWrite;
    second: BindingQueuedWrite;
    harness: Followed;
  }> {
    const own = await bindingHarness(label, { rows: held() });
    harness = own;
    const { device, server } = own;
    const edit = await device.updateItem(HELD.id, {
      properties: { title: "edited" },
      baseVersion: HELD.version,
    });
    expect(edit.ok, JSON.stringify(edit)).toBe(true);
    scriptWrites(server, {
      update: [
        refusal(409, "ancestor_unavailable", "no snapshot of that version"),
        { kind: "drop" },
      ],
      read,
    });
    const drained = await device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    // A second edit goes out and has no answer, so it is still waiting when
    // the first is withdrawn.
    const other = await device.updateItem(HELD.id, {
      properties: { body: "mine" },
      baseVersion: HELD.version,
    });
    expect(other.ok, JSON.stringify(other)).toBe(true);
    expect((await device.drain()).ok).toBe(true);
    const queue = await queueOf(device);
    const first = queue.find(
      (row) => row.id === (edit.ok ? edit.value.id : ""),
    );
    const second = queue.find(
      (row) => row.id === (other.ok ? other.value.id : ""),
    );
    expect(
      [first?.verdict?.verdict, second?.verdict?.verdict],
      "the first write was not blocked, or the second was answered, so nothing below is about a withdraw",
    ).toEqual(["blocked", undefined]);
    if (first === undefined || second === undefined) {
      throw new Error("the queue lost a row");
    }
    return { first, second, harness: own };
  }

  it("keeps the row a catch-up brought while a withdraw's read of it was out, with the writes still waiting laid over it", async () => {
    const reading = gate();
    const setup = await blocked("binding-withdraw-caught-up", [
      { kind: "gated", until: reading.until, then: movedOn() },
    ]);
    const { device, events } = setup.harness;
    events.set(
      copyReplay("11", [
        copyItemEvent(
          "11",
          "item.updated",
          wireItem({
            id: HELD.id,
            version: HELD.version + 3,
            properties: { title: "newer", body: "newer" },
          }),
        ),
      ]),
    );

    const withdrawing = device.withdraw(setup.first.id);
    await vi.waitFor(() => {
      expect(
        setup.harness.server.requests.filter(
          (request) =>
            request.method === "GET" &&
            request.pathname === `/items/${HELD.id}`,
        ),
      ).toHaveLength(1);
    });
    const caught = await device.catchUp();
    expect(caught.ok && caught.value.applied, JSON.stringify(caught)).toBe(1);
    expect(withdrawing.settled).toBe(false);

    reading.open();
    const withdrawn = await withdrawing;
    expect(withdrawn.ok && withdrawn.value, JSON.stringify(withdrawn)).toBe(
      true,
    );
    const row = await device.get(HELD.id);
    expect(row.ok, JSON.stringify(row)).toBe(true);
    if (!row.ok || row.value === null) return;
    expect(
      [row.value.version, row.value.properties],
      "the withdraw put back the row it read, over the one a catch-up brought after, or dropped the write still waiting",
    ).toEqual([HELD.version + 3, { title: "newer", body: "mine" }]);
  });
});

describe("a drain while another call changes the copy", () => {
  it("keeps a row something wrote in the copy while the read after an answer was out and found no row", async () => {
    const own = await bindingHarness("binding-absent-read", { rows: held() });
    harness = own;
    const { device, server, events } = own;
    const reading = gate();
    const edit = await device.updateItem(HELD.id, {
      properties: { title: "edited" },
      baseVersion: HELD.version,
    });
    expect(edit.ok, JSON.stringify(edit)).toBe(true);
    scriptWrites(server, {
      update: [
        answers.updated(
          wireItem({
            id: HELD.id,
            version: HELD.version + 1,
            properties: { title: "edited", body: "held" },
          }),
        ),
      ],
      // The row has gone from the server by the time it is read back.
      read: [
        {
          kind: "gated",
          until: reading.until,
          then: refusal(404, "item_not_found", "Item not found"),
        },
      ],
    });
    events.set(
      copyReplay("11", [
        copyItemEvent(
          "11",
          "item.updated",
          wireItem({
            id: HELD.id,
            version: HELD.version + 3,
            properties: { title: "theirs", body: "theirs" },
          }),
        ),
      ]),
    );

    const draining = device.drain();
    await vi.waitFor(() => {
      expect(
        server.requests.filter(
          (request) =>
            request.method === "GET" &&
            request.pathname === `/items/${HELD.id}`,
        ),
      ).toHaveLength(1);
    });
    const caught = await device.catchUp();
    expect(caught.ok && caught.value.applied, JSON.stringify(caught)).toBe(1);
    expect(draining.settled).toBe(false);

    reading.open();
    const drained = await draining;
    expect(drained.ok && drained.value.answered, JSON.stringify(drained)).toBe(
      1,
    );
    const row = await device.get(HELD.id);
    expect(
      row.ok &&
        row.value !== null && [row.value.version, row.value.properties.title],
      "the drain let go of a row a catch-up wrote while it read, and took the copy back under a change already applied",
    ).toEqual([HELD.version + 3, "theirs"]);
  });

  it("keeps the refusal a withdraw recorded for a write held behind a create while a drain ran, rather than holding the write again", async () => {
    const own = await bindingHarness("binding-drain-keeps-refusal", {
      rows: held(),
    });
    harness = own;
    const { device, server } = own;
    // A create the server will not take, blocked, with an edit held for it.
    const created = await device.createItem({
      type: "core.note",
      properties: { title: "mine", body: "mine" },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) return;
    const local = created.value.itemId ?? "";
    const deleting = gate();
    scriptWrites(server, {
      create: [
        answers.ancestorUnavailable(
          {
            id: local,
            version: 2,
            properties: { title: "gone" },
            tier: "library",
            occurred_at: "2026-01-01T00:00:00.000Z",
            source_id: null,
            type: "core.note",
          },
          0,
        ),
      ],
      read: [refusal(404, "item_not_found", "Item not found")],
    });
    server.answer("DELETE", /^\/items\/[^/]+$/, {
      kind: "gated",
      until: deleting.until,
      then: { kind: "json", status: 200, body: { ok: true } },
    });
    expect((await device.drain()).ok).toBe(true);
    const removed = await device.deleteItem(HELD.id);
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    const edit = await device.updateItem(local, {
      properties: { title: "mine, edited" },
      baseVersion: 0,
    });
    expect(edit.ok, JSON.stringify(edit)).toBe(true);
    if (!edit.ok) return;
    expect(edit.value.dependsOn).toEqual([created.value.id]);

    // The drain sends the delete ahead of the edit and waits for its answer.
    const draining = device.drain();
    await vi.waitFor(() => {
      expect(
        server.requests.filter((request) => request.method === "DELETE"),
      ).toHaveLength(1);
    });
    const withdrawn = await device.withdraw(created.value.id);
    expect(withdrawn.ok && withdrawn.value, JSON.stringify(withdrawn)).toBe(
      true,
    );
    deleting.open();
    const drained = await draining;
    expect(drained.ok, JSON.stringify(drained)).toBe(true);

    const after = (await queueOf(device)).find(
      (row) => row.id === edit.value.id,
    );
    expect(
      [after?.verdict?.verdict, after?.waiting],
      "the drain held the write behind a create the queue no longer holds, over its refusal, and nothing would release it",
    ).toEqual(["refused", false]);
    expect(
      after?.verdict?.verdict === "refused" && after.verdict.refusal,
    ).toMatchObject({
      reason: "the create_item it waits for was withdrawn",
    });
  });
});
