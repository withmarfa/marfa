import { afterEach, describe, expect, it } from "vitest";
import {
  answers,
  copyItemEvent,
  copyReplay,
  edgeEvent,
  refusal,
  wireEdge,
  wireItem,
  writeAnswers,
} from "../../device/marfa-answers.js";
import type { SseFrame } from "../../device/scripted-server.js";
import { scriptHydration, scriptWrites, startHarness } from "./harness.js";
import type { Harness } from "./harness.js";

/**
 * A row or an edge this device removed stays out of the copy until the copy
 * reads the event of that removal (`device/deleted-stays-gone`,
 * `device/deleted-edge-stays-gone`). An event older than the removal can
 * still be ahead of the cursor when the server accepts it, and applied as it
 * stands it puts the removed thing back.
 *
 * Every device command is a fresh process, so each catch-up here is also a
 * reopen of the copy.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const GONE = "01900000-0000-7000-8000-0000000000b1";
const STAYS = "01900000-0000-7000-8000-0000000000b2";
const THIRD = "01900000-0000-7000-8000-0000000000b3";

/** A copy following the log from event 10, which answers each catch-up with
 *  the frames `events` holds at the time. */
async function following(
  label: string,
  rows: Array<{ id: string; state?: "active" | "trashed"; version?: number }>,
  events: { frames: SseFrame[] },
  edges?: Array<{ id: string; source_id: string; target_id: string }>,
): Promise<Harness> {
  const started = await startHarness(label);
  scriptHydration(started.server, {
    head: "10",
    rows: { "core.note": rows.map((item) => ({ item })) },
    edges: edges === undefined ? undefined : { references: edges },
    replay: () => {
      const last = events.frames.at(-1)?.id ?? "10";
      return copyReplay(last, events.frames);
    },
  });
  const hydrated = await started.device.hydrate(
    ["core.note"],
    "library",
    edges === undefined ? undefined : { edgeTypes: ["references"] },
  );
  expect(hydrated.ok, JSON.stringify(hydrated)).toBe(true);
  return started;
}

/** Whether the copy holds the row, in the bin or out of it. */
async function holds(started: Harness, id: string): Promise<boolean> {
  if ((await started.device.get(id)).ok) return true;
  const trashed = await started.device.list({ state: "trashed" });
  expect(trashed.ok, JSON.stringify(trashed)).toBe(true);
  return trashed.ok && trashed.value.some((row) => row.id === id);
}

async function edgesFrom(started: Harness, id: string): Promise<string[]> {
  const edges = await started.device.edgesFrom(id);
  expect(edges.ok, JSON.stringify(edges)).toBe(true);
  return edges.ok ? edges.value.map((edge) => edge.id).sort() : [];
}

async function caughtUp(started: Harness): Promise<void> {
  const caught = await started.device.catchUp();
  expect(caught.ok, JSON.stringify(caught)).toBe(true);
}

describe("a row this device purged stays gone until the purge's event", () => {
  const events = { frames: [] as SseFrame[] };
  const gone = (version: number, title: string) =>
    wireItem({
      id: GONE,
      state: "trashed",
      version,
      properties: { title, body: "" },
    });
  const stays = (version: number) => wireItem({ id: STAYS, version });

  async function purged(label: string): Promise<Harness> {
    events.frames = [];
    const started = await following(
      label,
      [
        { id: GONE, state: "trashed", version: 3 },
        { id: STAYS, version: 1 },
        { id: THIRD },
      ],
      events,
      [{ id: "drawn", source_id: STAYS, target_id: GONE }],
    );
    // The witness: the copy holds the row in the bin, and an edge to it,
    // before the purge.
    expect(await holds(started, GONE)).toBe(true);
    expect(await edgesFrom(started, STAYS)).toEqual(["drawn"]);
    started.server.answer("POST", `/items/${GONE}/purge`, writeAnswers.ok());
    const purge = await started.device.purgeItem(GONE);
    expect(purge.ok, JSON.stringify(purge)).toBe(true);
    expect(await holds(started, GONE)).toBe(false);
    expect(await edgesFrom(started, STAYS)).toEqual([]);
    return started;
  }

  it("keeps the row out through an older event read after the purge", async () => {
    harness = await purged("gone-older-event");
    // A change made before the purge, still ahead of the cursor when the
    // purge was accepted, with a change to another row as the witness that
    // the catch-up applied what it read.
    events.frames = [
      copyItemEvent("11", "item.updated", gone(3, "before the purge")),
      copyItemEvent("12", "item.updated", stays(2)),
    ];
    // A copy that lets the row back in reads it whole as it enters.
    harness.server.copyAnswer(
      "GET",
      `/items/${GONE}`,
      answers.updated(gone(3, "before the purge")),
    );
    await caughtUp(harness);
    expect(
      await holds(harness, STAYS),
      "the catch-up applied nothing, so nothing here is about the purged row",
    ).toBe(true);
    const witness = await harness.device.get(STAYS);
    expect(witness.ok && witness.value.version).toBe(2);
    expect(
      await holds(harness, GONE),
      "an event older than the purge put the purged row back",
    ).toBe(false);

    // A later command opens the copy again and still keeps it out.
    await caughtUp(harness);
    expect(await holds(harness, GONE)).toBe(false);
  });

  it("keeps out an older event for an edge at either end of the row", async () => {
    harness = await purged("gone-older-edge");
    const edge = (id: string, target: string, version: number) =>
      wireEdge({
        id,
        source_id: STAYS,
        target_id: target,
        edge_type: "references",
        version,
      });
    events.frames = [
      edgeEvent("11", "edge.updated", edge("drawn", GONE, 2)),
      edgeEvent("12", "edge.created", edge("other", THIRD, 1)),
    ];
    await caughtUp(harness);
    // The witness: an edge between two rows the copy holds was applied.
    expect(
      await edgesFrom(harness, STAYS),
      "an event older than the purge put back an edge to the purged row",
    ).toEqual(["other"]);
  });

  it("shows a row made again under the id once the purge's event is read", async () => {
    harness = await purged("gone-restored");
    events.frames = [
      copyItemEvent("11", "item.purged", gone(3, "before the purge")),
      copyItemEvent(
        "12",
        "item.created",
        wireItem({
          id: GONE,
          version: 1,
          properties: { title: "again", body: "" },
        }),
      ),
    ];
    await caughtUp(harness);
    expect(
      await holds(harness, GONE),
      "a row made under the id after the purge's event stayed hidden",
    ).toBe(true);
  });
});

describe("an edge this device deleted stays gone until the delete's event", () => {
  const events = { frames: [] as SseFrame[] };
  const link = (version: number) =>
    wireEdge({
      id: "link",
      source_id: STAYS,
      target_id: GONE,
      edge_type: "references",
      version,
    });

  async function deleted(label: string): Promise<Harness> {
    events.frames = [];
    const started = await following(
      label,
      [{ id: STAYS }, { id: GONE }],
      events,
      [{ id: "link", source_id: STAYS, target_id: GONE }],
    );
    // The witness: the copy held the edge before the delete.
    expect(await edgesFrom(started, STAYS)).toEqual(["link"]);
    const queued = await started.device.deleteEdge("link");
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    scriptWrites(started.server, { edges: [writeAnswers.ok()] });
    started.server.copyAnswer(
      "GET",
      "/edges/link",
      refusal(404, "edge_not_found", "no edge link"),
    );
    const drained = await started.device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    const queue = await started.device.queue();
    expect(
      queue.ok && queue.value.map((row) => [row.kind, row.verdict]),
    ).toEqual([["delete_edge", "accepted"]]);
    expect(await edgesFrom(started, STAYS)).toEqual([]);
    return started;
  }

  it("keeps the edge out through an older event read after the delete was answered", async () => {
    harness = await deleted("edge-gone-older-event");
    events.frames = [
      edgeEvent("11", "edge.updated", link(2)),
      edgeEvent(
        "12",
        "edge.created",
        wireEdge({
          id: "other",
          source_id: STAYS,
          target_id: GONE,
          edge_type: "references",
        }),
      ),
    ];
    await caughtUp(harness);
    const held = await edgesFrom(harness, STAYS);
    expect(
      held,
      "the catch-up applied nothing, so nothing here is about the deleted edge",
    ).toContain("other");
    expect(
      held,
      "an event older than the delete put the deleted edge back",
    ).not.toContain("link");
  });

  it("shows an edge made again under the id once the delete's event is read", async () => {
    harness = await deleted("edge-gone-restored");
    events.frames = [
      edgeEvent("11", "edge.deleted", link(1)),
      edgeEvent("12", "edge.created", link(1)),
    ];
    await caughtUp(harness);
    expect(
      await edgesFrom(harness, STAYS),
      "an edge made under the id after the delete's event stayed hidden",
    ).toEqual(["link"]);
  });
});
