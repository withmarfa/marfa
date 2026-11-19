import { afterEach, describe, expect, it } from "vitest";
import {
  answers,
  copyItemEvent,
  copyReplay,
  refusal,
  wireItem,
  withMetadata,
} from "../../device/marfa-answers.js";
import type { Answer } from "../../device/scripted-server.js";
import {
  scriptHydration,
  scriptWrites,
  startHarness,
  type Harness,
} from "./harness.js";

/**
 * A server put back to an earlier copy of its database, as the device sees
 * it through a scripted server: a log that reuses the ids it gave after that
 * point, and a write it answered that it no longer holds. The live fixtures
 * in `server-restored-live.test.ts` restore a real server.
 */

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

function lastEventIds(h: Harness): string[] {
  return h.server.requests
    .filter((request) => request.pathname === "/events")
    .map((request) => request.headers["last-event-id"] ?? "(none)");
}

/**
 * A copy hydrated at 10 that has taken event 11, which created `n1`. Each
 * later stream answers what `next` returns.
 */
async function tookEleven(
  label: string,
  next: () => Answer,
): Promise<Harness> {
  harness = await startHarness(label);
  const h = harness;
  scriptHydration(h.server, { head: "10" });
  h.server.copyAnswer(
    "GET",
    "/events",
    copyReplay("11", [
      copyItemEvent("11", "item.created", wireItem({ id: "n1" })),
    ]),
    () => next(),
  );
  expect((await h.device.hydrate(["core.note"], "library")).ok).toBe(true);
  const first = await h.device.catchUp();
  expect(first.ok, JSON.stringify(first)).toBe(true);
  expect(first.ok && first.value.applied).toBe(1);
  return h;
}

describe("a log that holds another event where the copy's last one was", () => {
  it("asks the stream from the event before the last one it took, and takes that one only to compare", async () => {
    const h = await tookEleven("restored-anchor-same", () =>
      copyReplay("11", [
        copyItemEvent("11", "item.created", wireItem({ id: "n1" })),
      ]),
    );
    const again = await h.device.catchUp();
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(
      lastEventIds(h).at(-1),
      "the stream was not asked for the event before the last one the copy took",
    ).toBe("10");
    expect(
      again.ok && again.value.applied,
      "the event the copy took already was applied again",
    ).toBe(0);
    expect(again.ok && again.value.cursor).toBe("11");
  });

  it("ends the catch-up where the log holds another event at the last one it took", async () => {
    // The server was restored to 10 and has since written another item,
    // which its log numbers 11 again.
    const h = await tookEleven("restored-anchor-other", () =>
      copyReplay("11", [
        copyItemEvent("11", "item.created", wireItem({ id: "n2" })),
      ]),
    );
    const again = await h.device.catchUp();
    expect(
      again.ok ? "caught up" : again.refusal.code,
      "a log that numbers another event as the one the copy took was read as the same log",
    ).toBe("copy_expired");
  });
});

describe("a write the server answered and no longer holds", () => {
  /**
   * A copy hydrated at 10 that created an item and drained it, with the
   * server answering a read of that item as `read` says.
   */
  async function drainedCreate(
    label: string,
    read: (id: string) => Answer,
  ): Promise<Harness> {
    harness = await startHarness(label);
    const h = harness;
    scriptHydration(h.server, { head: "10" });
    scriptWrites(h.server, {
      create: [
        (request) => {
          const sent = JSON.parse(request.body) as { id: string };
          return answers.created(
            wireItem({ id: sent.id, version: 1, properties: { title: "kept" } }),
          );
        },
      ],
    });
    expect((await h.device.hydrate(["core.note"], "library")).ok).toBe(true);
    const created = await h.device.create({
      type: "core.note",
      properties: { title: "kept" },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const id = created.ok ? (created.value.item_id ?? "") : "";
    expect((await h.device.drain()).ok).toBe(true);
    h.server.copyAnswer("GET", `/items/${id}`, read(id));
    return h;
  }

  it("ends the catch-up where the server no longer holds an item it accepted from this device", async () => {
    // The witness: a server that holds the item at the version it answered.
    {
      const h = await drainedCreate("restored-receipt-held", (id) => ({
        kind: "json",
        status: 200,
        body: withMetadata(
          wireItem({ id, version: 1, properties: { title: "kept" } }),
        ),
      }));
      const caught = await h.device.catchUp();
      expect(
        caught.ok ? "caught up" : caught.refusal.code,
        "a server that holds what it answered ended the catch-up",
      ).toBe("caught up");
      await h.stop();
      harness = undefined;
    }
    const h = await drainedCreate("restored-receipt-lost", () =>
      refusal(404, "not_found", "no such item"),
    );
    const caught = await h.device.catchUp();
    expect(
      caught.ok ? "caught up" : caught.refusal.code,
      "a server that no longer holds an item it accepted was taken as holding it",
    ).toBe("copy_expired");
  });
});
