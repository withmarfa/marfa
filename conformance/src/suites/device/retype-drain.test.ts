import { afterEach, describe, expect, it } from "vitest";
import {
  refusal,
  typeCatalog,
  wireItem,
  wireType,
  answers,
} from "../../device/marfa-answers.js";
import type { Outcome } from "../../device/protocol.js";
import type { Responder } from "../../device/scripted-server.js";
import { scriptHydration, startHarness, type Harness } from "./harness.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const TASK = "acme.task";
const RETYPED = "01a00000-0000-7000-8000-0000000000a1";
const BEHIND = "01a00000-0000-7000-8000-0000000000a2";
const AFTER = "01a00000-0000-7000-8000-0000000000a3";

function value<T>(outcome: Outcome<T>): T {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  if (!outcome.ok) throw new Error(outcome.refusal.raw);
  return outcome.value;
}

async function hydrated(label: string): Promise<Harness> {
  const started = await startHarness(label);
  scriptHydration(started.server, {
    head: "10",
    catalog: () => typeCatalog([wireType(TASK, { parent: "core.note" })]),
    rows: {
      "core.note": [
        { item: { id: RETYPED } },
        { item: { id: BEHIND } },
        { item: { id: AFTER } },
      ],
      [TASK]: [],
    },
  });
  value(await started.device.hydrate(["core.note", TASK], "library"));
  return started;
}

/** The writes sent to an item's door, and the reads of it made under the copy's reach. */
function itemCalls(started: Harness, id: string) {
  const asked = started.server.requests.filter(
    (request) => request.pathname === `/items/${id}`,
  );
  return {
    writes: asked.filter((request) => request.method === "PATCH"),
    reads: asked.filter(
      (request) =>
        request.method === "GET" &&
        request.headers["x-marfa-reach"] !== undefined,
    ),
  };
}

function hydrations(started: Harness): number {
  return started.server.requests.filter(
    (request) =>
      request.method === "GET" &&
      request.pathname === "/events" &&
      request.query.get("copy") === "1" &&
      request.headers["last-event-id"] === undefined,
  ).length;
}

/** Both doors answer, and the read of the first is refused under a changed reach. */
function scriptWrites(
  started: Harness,
  type: string,
  ...behind: Responder[]
): void {
  started.server.answer("PATCH", `/items/${RETYPED}`, () =>
    answers.updated(
      wireItem({ id: RETYPED, version: 2, type, properties: { rank: 1 } }),
    ),
  );
  started.server.answer(
    "PATCH",
    `/items/${BEHIND}`,
    ...(behind.length > 0
      ? behind
      : [
          () =>
            answers.updated(
              wireItem({ id: BEHIND, version: 2, properties: { rank: 2 } }),
            ),
        ]),
  );
  started.server.answer(
    "GET",
    `/items/${RETYPED}`,
    refusal(409, "reach_changed", "the reach has changed"),
  );
}

describe("a drain that sends a retype of its own", () => {
  it("sends the writes queued behind it and expires the copy once, at the end", async () => {
    harness = await hydrated("retype-carries-on");
    const { device } = harness;
    scriptWrites(harness, TASK);
    value(
      await device.update(RETYPED, {
        type: TASK,
        version: 1,
        properties: { rank: 1 },
      }),
    );
    value(await device.update(BEHIND, { version: 1, properties: { rank: 2 } }));

    const drained = await device.drain();
    expect(drained.ok, "the drain did not end with the copy expired").toBe(
      false,
    );
    if (!drained.ok) expect(drained.refusal.code).toBe("copy_expired");
    expect(
      value(await device.queue()).map((row) => row.verdict),
      "the write behind the retype was not sent in the same drain",
    ).toEqual(["accepted", "accepted"]);
    expect(itemCalls(harness, BEHIND).writes).toHaveLength(1);
    // The witness is the retype's own read: made, refused, and not what
    // ended the drain. The write behind it left its read unmade.
    expect(itemCalls(harness, RETYPED).reads).toHaveLength(1);
    expect(itemCalls(harness, BEHIND).reads).toHaveLength(0);
    expect(value(await device.status()).hydration).toBe("expired");
    expect(hydrations(harness)).toBe(1);
  });

  it("ends at once where the read of an edit that retypes nothing meets a changed reach", async () => {
    harness = await hydrated("retype-other-read");
    const { device } = harness;
    scriptWrites(harness, "core.note");
    value(
      await device.update(RETYPED, { version: 1, properties: { rank: 1 } }),
    );
    value(await device.update(BEHIND, { version: 1, properties: { rank: 2 } }));

    const drained = await device.drain();
    expect(drained.ok).toBe(false);
    if (!drained.ok) expect(drained.refusal.code).toBe("copy_expired");
    expect(
      value(await device.queue()).map((row) => row.verdict),
      "a write was sent behind one whose read met a reach no retype of the device's own changed",
    ).toEqual(["accepted", null]);
    expect(itemCalls(harness, BEHIND).writes).toHaveLength(0);
    expect(itemCalls(harness, RETYPED).reads).toHaveLength(1);
  });

  it("ends at once where another instance refuses a write behind a retype the server took", async () => {
    harness = await hydrated("retype-instance");
    const { device, server } = harness;
    scriptWrites(
      harness,
      TASK,
      refusal(409, "instance_changed", "another instance at this address"),
    );
    server.answer("PATCH", `/items/${AFTER}`, () =>
      answers.updated(
        wireItem({ id: AFTER, version: 2, properties: { rank: 3 } }),
      ),
    );
    value(
      await device.update(RETYPED, {
        type: TASK,
        version: 1,
        properties: { rank: 1 },
      }),
    );
    value(await device.update(BEHIND, { version: 1, properties: { rank: 2 } }));
    value(await device.update(AFTER, { version: 1, properties: { rank: 3 } }));

    const drained = await device.drain();
    expect(drained.ok).toBe(false);
    if (!drained.ok) {
      expect(drained.refusal.code).toBe("copy_expired");
      expect(
        drained.refusal.raw,
        "the drain ended for the retype, not for the other instance",
      ).toContain("instance_changed");
    }
    expect(
      value(await device.queue()).map((row) => [row.verdict, row.refusals]),
      "a write was sent, or judged, after another instance refused one",
    ).toEqual([
      ["accepted", 0],
      [null, 0],
      [null, 0],
    ]);
    // The witness: the retype deferred the expiry and the drain carried on to
    // the write the other instance refused.
    expect(itemCalls(harness, BEHIND).writes).toHaveLength(1);
    expect(itemCalls(harness, AFTER).writes).toHaveLength(0);
    expect(value(await device.status()).hydration).toBe("expired");
  });

  it("returns the report with the wait the server asked for after a retype, the copy expired", async () => {
    harness = await hydrated("retype-wait");
    const { device } = harness;
    scriptWrites(harness, TASK, {
      kind: "json",
      status: 429,
      body: { error: { code: "rate_limited", message: "slow down" } },
      headers: { "Retry-After": "120" },
    });
    value(
      await device.update(RETYPED, {
        type: TASK,
        version: 1,
        properties: { rank: 1 },
      }),
    );
    value(await device.update(BEHIND, { version: 1, properties: { rank: 2 } }));

    const report = value(await device.drain());
    expect(
      report.retry_after_seconds,
      "the wait the server asked for was lost to the expiry",
    ).toBe(120);
    expect(value(await device.queue()).map((row) => row.verdict)).toEqual([
      "accepted",
      null,
    ]);
    expect(value(await device.status()).hydration).toBe("expired");
    const next = await device.drain();
    expect(next.ok).toBe(false);
    if (!next.ok) expect(next.refusal.code).toBe("copy_expired");
  });

  it("ends with the error of its own where a redirect meets the drain after a retype, the copy expired", async () => {
    harness = await hydrated("retype-redirect");
    const { device } = harness;
    scriptWrites(harness, TASK, {
      kind: "json",
      status: 307,
      body: {},
      contract: "999999",
      headers: { Location: "/next" },
    });
    value(
      await device.update(RETYPED, {
        type: TASK,
        version: 1,
        properties: { rank: 1 },
      }),
    );
    value(await device.update(BEHIND, { version: 1, properties: { rank: 2 } }));

    const drained = await device.drain();
    expect(drained.ok).toBe(false);
    if (!drained.ok) expect(drained.refusal.code).toBe("redirect");
    expect(
      value(await device.status()).hydration,
      "the redirect left the copy current",
    ).toBe("expired");
  });

  it("leaves the copy current where the server refuses every retype", async () => {
    harness = await hydrated("retype-refused");
    const { device, server } = harness;
    server.answer(
      "PATCH",
      `/items/${RETYPED}`,
      refusal(404, "item_not_found", "no such item"),
    );
    server.copyAnswer(
      "GET",
      `/items/${RETYPED}`,
      refusal(404, "item_not_found", "no such item"),
    );
    value(
      await device.update(RETYPED, {
        type: TASK,
        version: 1,
        properties: { rank: 1 },
      }),
    );

    const drained = value(await device.drain());
    expect(drained.verdicts.map((row) => row.verdict)).toEqual(["refused"]);
    expect(
      value(await device.status()).hydration,
      "a refused retype expired the copy",
    ).toBe("complete");
  });

  it("expires the copy where another client changed the reach during a drain whose retypes were all refused", async () => {
    harness = await hydrated("retype-refused-elsewhere");
    const { device, server } = harness;
    server.answer(
      "PATCH",
      `/items/${RETYPED}`,
      refusal(404, "item_not_found", "no such item"),
    );
    // The refusal changed nothing; the read after it meets a reach that
    // another client changed.
    server.answer(
      "GET",
      `/items/${RETYPED}`,
      refusal(409, "reach_changed", "the reach has changed"),
    );
    value(
      await device.update(RETYPED, {
        type: TASK,
        version: 1,
        properties: { rank: 1 },
      }),
    );

    const drained = await device.drain();
    expect(drained.ok).toBe(false);
    if (!drained.ok) expect(drained.refusal.code).toBe("copy_expired");
    expect(value(await device.queue()).map((row) => row.verdict)).toEqual([
      "refused",
    ]);
    expect(itemCalls(harness, RETYPED).reads).toHaveLength(1);
    expect(value(await device.status()).hydration).toBe("expired");
  });
});
