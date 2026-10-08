import { describe, it, expect, afterEach } from "vitest";
import {
  answers,
  copyItemEvent,
  edgeEvent,
  refusal,
  copyReplay,
  wireEdge,
  wireItem,
} from "../../device/marfa-answers.js";
import type { DrainReport } from "../../device/protocol.js";
import {
  hydratedHarness,
  scriptHydration,
  scriptWrites,
  startHarness,
} from "./harness.js";
import type { Harness, ScriptedWrites } from "./harness.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/**
 * "The server answers with a verdict."
 *
 * Six verdicts, and the set is closed. An open set means a default branch in
 * practice, and a default branch is where a refusal becomes a retry and a
 * merge becomes a silent overwrite. The three a successful answer can carry
 * are told apart by one field rather than by comparing rows, because every
 * answer carries fields the server stamped and the device never sent.
 */

const SIX = [
  "accepted",
  "merged",
  "conflicted",
  "refused",
  "blocked",
  "dead",
] as const;

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

/** Queue one update to the held row and drain once. */
async function updateAndDrain(
  harness: Harness,
  update: ScriptedWrites["update"],
  read?: ScriptedWrites["read"],
): Promise<DrainReport> {
  const edit = await harness.device.update(HELD.id, {
    properties: { title: "edited", body: "edited" },
    version: HELD.version,
  });
  expect(
    edit.ok,
    `the fixture could not queue the update it is about to drain: ${JSON.stringify(edit)}`,
  ).toBe(true);
  scriptWrites(harness.server, { update, read });
  const drained = await harness.device.drain();
  expect(
    drained.ok,
    `the drain refused rather than answering the write: ${JSON.stringify(drained)}`,
  ).toBe(true);
  if (!drained.ok) throw new Error("unreachable: the assertion above threw");
  expect(
    drained.value.verdicts.length,
    "the drain reported no verdict at all, so there is nothing below to read",
  ).toBe(1);
  return drained.value;
}

describe("the set is closed", () => {
  it("answers every write with one of the six verdicts", async () => {
    harness = await hydratedHarness("verdicts-closed", { rows: held() });
    const reached = new Set<string>();

    // One answer per verdict, each the answer its statement names. Driven
    // through the device rather than asserted about a table, because the
    // question is what the device does with an answer and not what a list
    // in the source says.
    const cases: Array<{
      update: ScriptedWrites["update"];
      read?: ScriptedWrites["read"];
      expected: string;
    }> = [
      {
        update: [answers.updated(wireItem({ id: HELD.id, version: 4 }))],
        read: [answers.updated(wireItem({ id: HELD.id, version: 4 }))],
        expected: "accepted",
      },
      {
        update: [
          answers.resolved(wireItem({ id: HELD.id, version: 4 }), {
            title: "last_writer_wins",
          }),
        ],
        read: [answers.updated(wireItem({ id: HELD.id, version: 4 }))],
        expected: "merged",
      },
      {
        update: [
          answers.resolved(
            wireItem({ id: HELD.id, version: 4 }),
            { body: "keep_both_copies" },
            "01a00000-0000-7000-8000-0000000000bb",
          ),
        ],
        read: [answers.updated(wireItem({ id: HELD.id, version: 4 }))],
        expected: "conflicted",
      },
      {
        update: [refusal(403, "forbidden", "this key may not write core.note")],
        read: [
          answers.updated(wireItem({ id: HELD.id, version: HELD.version })),
        ],
        expected: "refused",
      },
      {
        update: [
          refusal(409, "ancestor_unavailable", "no snapshot of that version"),
        ],
        expected: "blocked",
      },
    ];

    for (const scenario of cases) {
      const own = await hydratedHarness(`verdicts-${scenario.expected}`, {
        rows: held(),
      });
      try {
        const report = await updateAndDrain(
          own,
          scenario.update,
          scenario.read,
        );
        expect(
          report.verdicts[0]?.verdict,
          `an answer the contract says is ${scenario.expected} was read as something else, so a caller acts on the wrong one`,
        ).toBe(scenario.expected);
        reached.add(scenario.expected);
      } finally {
        await own.stop();
      }
    }

    // `dead` needs the ceiling, which is five counted refusals rather than
    // one answer, so it is reached here rather than in the table above.
    const dying = await hydratedHarness("verdicts-dead", { rows: held() });
    try {
      const edit = await dying.device.update(HELD.id, {
        properties: { title: "dying" },
        version: HELD.version,
      });
      expect(edit.ok).toBe(true);
      scriptWrites(dying.server, {
        update: [{ kind: "json", status: 200, body: "not json at all" }],
      });
      let last: DrainReport | undefined;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const drained = await dying.device.drain();
        expect(drained.ok).toBe(true);
        if (drained.ok) last = drained.value;
      }
      expect(
        last?.verdicts[0]?.verdict,
        "five counted refusals did not reach the ceiling, so `dead` is a verdict nothing reaches",
      ).toBe("dead");
      reached.add("dead");
    } finally {
      await dying.stop();
    }

    expect(
      [...reached].sort(),
      "the device cannot reach every verdict the contract names, so one of the six is a promise nothing keeps",
    ).toEqual([...SIX].sort());
  });

  it("tells the three successful verdicts apart by the resolution the answer carries", async () => {
    // The same row, the same version, the same fields on the way back. The
    // only thing that differs is what the answer reports about resolving,
    // which is the statement: a device reads that rather than comparing the
    // row it got against the row it imagined.
    const row = wireItem({
      id: HELD.id,
      version: 4,
      properties: { title: "identical", body: "identical" },
    });
    const cases: Array<[string, ScriptedWrites["update"]]> = [
      ["accepted", [answers.updated(row)]],
      ["merged", [answers.resolved(row, { title: "last_writer_wins" })]],
      [
        "conflicted",
        [
          answers.resolved(
            row,
            { body: "keep_both_copies" },
            "01a00000-0000-7000-8000-0000000000bb",
          ),
        ],
      ],
    ];
    for (const [expected, update] of cases) {
      const own = await hydratedHarness(`verdicts-apart-${expected}`, {
        rows: held(),
      });
      try {
        const report = await updateAndDrain(own, update, [
          answers.updated(row),
        ]);
        expect(
          report.verdicts[0]?.verdict,
          `three answers carrying the same row were not told apart by the resolution each reported, so a merge reads as a plain success and a caller never learns their value was changed`,
        ).toBe(expected);
      } finally {
        await own.stop();
      }
    }
  });
});

describe("the server took the write", () => {
  it("accepted: adopts the row the server returned", async () => {
    harness = await hydratedHarness("verdicts-accepted", { rows: held() });
    const report = await updateAndDrain(
      harness,
      [
        answers.updated(
          wireItem({
            id: HELD.id,
            version: 9,
            properties: { title: "the server's", body: "the server's" },
            source: "another-device",
            updated_at: "2026-09-19T11:00:00.000Z",
          }),
        ),
      ],
      [
        answers.updated(
          wireItem({
            id: HELD.id,
            version: 9,
            properties: { title: "the server's", body: "the server's" },
            source: "another-device",
            updated_at: "2026-09-19T11:00:00.000Z",
          }),
        ),
      ],
    );
    expect(report.verdicts[0]?.verdict).toBe("accepted");

    const read = await harness.device.get(HELD.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // The version and the stamped fields both, because those are the ones
    // the device never sent: a copy that kept its own is a copy of a row
    // the server never wrote.
    expect(
      read.value.version,
      "the copy kept its own version after an accepted write, so the next update is based on a version the server never minted",
    ).toBe(9);
    expect(read.value.properties.title).toBe("the server's");
    expect(
      read.value.source,
      "the copy kept its own source, so a field the server stamps was overwritten by one the device made up",
    ).toBe("another-device");
  });

  it("accepted: takes an upsert and a replayed repeat as accepted", async () => {
    harness = await hydratedHarness("verdicts-upsert", { rows: held() });
    const created = await harness.device.create({
      type: "core.note",
      properties: { title: "by natural key", body: "by natural key" },
      source: "folder",
      sourceId: "note.md",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // A natural-key upsert: the server answers 200 with the row it already
    // held, under a different id than the one this device minted.
    const theirs = "01a00000-0000-7000-8000-0000000000cc";
    scriptWrites(harness.server, {
      create: [
        {
          kind: "json",
          status: 200,
          body: bodyOf(answers.created(wireItem({ id: theirs, version: 5 }))),
          headers: { "Idempotency-Replayed": "true" },
        },
      ],
      read: [answers.updated(wireItem({ id: theirs, version: 5 }))],
    });
    const drained = await harness.device.drain();
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(
      drained.value.verdicts[0]?.verdict,
      "an upsert answered from the server's record was read as something other than accepted, and the row it returned is the truth whatever the device held",
    ).toBe("accepted");
    expect(
      drained.value.verdicts[0]?.replayed,
      "the device did not report that the answer came from the record, so nothing tells a caller their write had already landed",
    ).toBe(true);

    const adopted = await harness.device.get(theirs);
    expect(
      adopted.ok,
      "the copy did not take the row the server returned, so an upsert leaves the device holding a row that exists nowhere",
    ).toBe(true);
  });

  it.each(["an upsert under another id", "a repeat acknowledged in its body"])(
    "accepted: takes %s as accepted",
    async (shape) => {
      harness = await hydratedHarness("verdicts-upsert-alone", {
        rows: held(),
      });
      const keyed = shape === "an upsert under another id";
      const created = await harness.device.create({
        type: "core.note",
        properties: { title: "made", body: "made" },
        ...(keyed ? { source: "folder", sourceId: "alone.md" } : {}),
      });
      if (!created.ok) throw new Error(JSON.stringify(created));
      const id = keyed
        ? "01a00000-0000-7000-8000-0000000000cd"
        : (created.value.item_id ?? "");
      const row = wireItem({ id, version: keyed ? 5 : 1 });
      scriptWrites(harness.server, {
        create: [
          {
            kind: "json",
            status: 200,
            body: {
              ...bodyOf(answers.created(row)),
              ...(keyed ? {} : { acknowledged: true }),
            },
          },
        ],
        read: [answers.updated(row)],
      });
      const drained = await harness.device.drain();
      expect(drained.ok, JSON.stringify(drained)).toBe(true);
      if (!drained.ok) return;
      expect(
        [
          drained.value.verdicts[0]?.verdict,
          drained.value.verdicts[0]?.replayed,
        ],
        `${shape} was not taken as accepted`,
      ).toEqual(["accepted", !keyed]);
    },
  );

  it("merged: adopts the row a resolution returned", async () => {
    harness = await hydratedHarness("verdicts-merged", { rows: held() });
    const report = await updateAndDrain(
      harness,
      [
        answers.resolved(
          wireItem({
            id: HELD.id,
            version: 5,
            properties: { title: "mine", body: "theirs, kept" },
          }),
          { body: "last_writer_wins" },
        ),
      ],
      [
        answers.updated(
          wireItem({
            id: HELD.id,
            version: 5,
            properties: { title: "mine", body: "theirs, kept" },
          }),
        ),
      ],
    );
    expect(report.verdicts[0]?.verdict).toBe("merged");
    expect(
      report.verdicts[0]?.merged_fields,
      "the device did not report which fields the server resolved, so a caller is told their write was merged and not what was merged into it",
    ).toEqual(["body"]);

    const read = await harness.device.get(HELD.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // Both halves of the returned row, because the point of a merge is that
    // the row carries the device's field and the other writer's.
    expect(read.value.properties.title).toBe("mine");
    expect(
      read.value.properties.body,
      "the copy kept the body it sent rather than the merged one, so the other writer's change is lost on this device and present on every other",
    ).toBe("theirs, kept");
  });

  it("holds the row a fresh read returns where it differs from the row the answer carried", async () => {
    harness = await hydratedHarness("verdicts-fresh-read", { rows: held() });
    const report = await updateAndDrain(
      harness,
      [
        answers.updated(
          wireItem({
            id: HELD.id,
            version: 4,
            properties: { title: "the answer's", body: "held" },
          }),
        ),
      ],
      // Another device wrote between the answer and the read.
      [
        answers.updated(
          wireItem({
            id: HELD.id,
            version: 5,
            properties: { title: "the read's", body: "held" },
          }),
        ),
      ],
    );
    expect(report.verdicts[0]?.verdict).toBe("accepted");
    const read = await harness.device.get(HELD.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(
      [read.value.version, read.value.properties.title],
      "the copy took the row the answer carried over the row the read after it returned",
    ).toEqual([5, "the read's"]);
  });

  it("conflicted: names the sibling the server wrote", async () => {
    harness = await hydratedHarness("verdicts-conflicted", { rows: held() });
    const sibling = "01a00000-0000-7000-8000-0000000000bb";
    const report = await updateAndDrain(
      harness,
      [
        answers.resolved(
          wireItem({
            id: HELD.id,
            version: 5,
            properties: { title: "held", body: "the server's" },
          }),
          { body: "keep_both_copies" },
          sibling,
        ),
      ],
      [
        answers.updated(
          wireItem({
            id: HELD.id,
            version: 5,
            properties: { title: "held", body: "the server's" },
          }),
        ),
      ],
    );
    expect(report.verdicts[0]?.verdict).toBe("conflicted");
    expect(
      report.verdicts[0]?.conflicted_copy_id,
      "the verdict does not name the sibling, and no route reports what a write created: without this the losing edit exists and nothing can reach it",
    ).toBe(sibling);

    const queue = await harness.device.queue();
    expect(queue.ok).toBe(true);
    if (!queue.ok) return;
    expect(
      queue.value[0]?.conflicted_copy_id,
      "the queue does not carry the sibling the drain reported, so a caller who missed the drain's output cannot find it",
    ).toBe(sibling);
  });

  it("conflicted: the sibling reaches the copy with a later event, not with the answer", async () => {
    harness = await startHarness("verdicts-conflicted-later");
    const { server, device } = harness;
    const sibling = "01a00000-0000-7000-8000-0000000000bb";
    scriptHydration(server, { head: "1", rows: held() });
    // The catch-up after the drain reads this: the server logs the sibling
    // as a create of its own, in the same transaction as the update.
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("2", [
        copyItemEvent(
          "2",
          "item.created",
          wireItem({
            id: sibling,
            properties: { title: "edited", body: "edited" },
          }),
          { tags: ["conflicted-copy"] },
        ),
      ]),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const report = await updateAndDrain(
      harness,
      [
        answers.resolved(
          wireItem({
            id: HELD.id,
            version: 5,
            properties: { title: "held", body: "the server's" },
          }),
          { body: "keep_both_copies" },
          sibling,
        ),
      ],
      [
        answers.updated(
          wireItem({
            id: HELD.id,
            version: 5,
            properties: { title: "held", body: "the server's" },
          }),
        ),
      ],
    );
    expect(report.verdicts[0]?.conflicted_copy_id).toBe(sibling);

    // The answer names the sibling and carries only the row written to, so
    // a read of the sibling straight after the drain races the stream. The
    // read after the catch-up below is the witness that the copy can hold
    // it.
    const before = await device.get(sibling);
    expect(
      before.ok,
      "the copy held the sibling before any event brought it, so it was made up from an answer that carries only the row written to",
    ).toBe(false);
    if (!before.ok) expect(before.refusal.code).toBe("not_held");

    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    const after = await device.get(sibling);
    expect(
      after.ok,
      "the sibling's event was caught up and the copy still does not hold it, so the losing edit is named by the verdict and reachable nowhere",
    ).toBe(true);
    if (!after.ok) return;
    expect(after.value.properties.body).toBe("edited");
    expect(after.value.tags).toEqual(["conflicted-copy"]);
  });
});

/** The body of a scripted JSON answer. */
function bodyOf(answer: ReturnType<typeof answers.created>): unknown {
  if (answer.kind !== "json") throw new Error("a json answer has a body");
  return answer.body;
}

describe("a write the server took is settled once", () => {
  it("sends nothing again for a write answered accepted, merged or conflicted", async () => {
    const row = wireItem({ id: HELD.id, version: 4 });
    for (const [expected, update] of [
      ["accepted", [answers.updated(row)]],
      ["merged", [answers.resolved(row, { title: "last_writer_wins" })]],
      [
        "conflicted",
        [
          answers.resolved(
            row,
            { body: "keep_both_copies" },
            "01a00000-0000-7000-8000-0000000000bb",
          ),
        ],
      ],
    ] as Array<[string, ScriptedWrites["update"]]>) {
      const own = await hydratedHarness(`verdicts-once-${expected}`, {
        rows: held(),
      });
      try {
        const first = await updateAndDrain(own, update, [answers.updated(row)]);
        expect(first.verdicts[0]?.verdict).toBe(expected);
        const again = await own.device.drain();
        expect(again.ok, JSON.stringify(again)).toBe(true);
        if (!again.ok) return;
        expect(
          again.value.verdicts,
          `a write answered ${expected} was settled again by a later drain`,
        ).toEqual([]);
        expect(
          own.server.requests.filter((request) => request.method === "PATCH"),
          `a write answered ${expected} was sent again`,
        ).toHaveLength(1);
      } finally {
        await own.stop();
      }
    }
  });

  it("keeps an accepted write accepted, counts nothing and reads it again at the next drain when the read after it fails", async () => {
    harness = await hydratedHarness("verdicts-read-fails", { rows: held() });
    const { device, server } = harness;
    const edited = await device.update(HELD.id, {
      properties: { title: "edited" },
      version: HELD.version,
    });
    expect(edited.ok, JSON.stringify(edited)).toBe(true);
    const landed = wireItem({
      id: HELD.id,
      version: 4,
      properties: { title: "edited", body: "held" },
    });
    const made = new Map<string, ReturnType<typeof wireItem>>();
    scriptWrites(server, {
      update: [answers.updated(landed)],
      read: [
        { kind: "drop" },
        (request) => {
          const id = request.pathname.split("/").at(-1) ?? "";
          const row = id === HELD.id ? landed : made.get(id);
          return row === undefined
            ? refusal(404, "item_not_found", "no such item")
            : answers.updated(row);
        },
      ],
      create: [
        (request) => {
          const sent = JSON.parse(request.body) as { id: string };
          const row = wireItem({ id: sent.id });
          made.set(sent.id, row);
          return answers.created(row);
        },
      ],
    });
    const first = await device.drain();
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(
      first.value.verdicts.map((verdict) => [
        verdict.verdict,
        verdict.refusals,
      ]),
      "a write the server took lost its verdict, or was counted against, because the read after it failed",
    ).toEqual([["accepted", 0]]);
    expect(first.value.unavailable).toMatch(/could not be reached/);
    const queue = await device.queue();
    expect(queue.ok && queue.value.map((row) => row.verdict)).toEqual([
      "accepted",
    ]);

    // A write queued now goes only once the read owed has been made.
    const behind = await device.create({
      type: "core.note",
      properties: { title: "behind", body: "behind" },
    });
    expect(behind.ok, JSON.stringify(behind)).toBe(true);
    const sentBefore = server.requests.length;
    const second = await device.drain();
    expect(second.ok, JSON.stringify(second)).toBe(true);
    const after = server.requests
      .slice(sentBefore)
      .map((request) => `${request.method} ${request.pathname}`)
      .filter((sent) => sent !== "GET /");
    expect(
      after.indexOf(`GET /items/${HELD.id}`),
      "the next drain sent a write before it made the read the accepted write was owed",
    ).toBeLessThan(after.indexOf("POST /items"));
    expect(after.indexOf(`GET /items/${HELD.id}`)).toBeGreaterThanOrEqual(0);
    expect(
      server.requests.filter((request) => request.method === "PATCH"),
      "the accepted write was sent again when its read was retried",
    ).toHaveLength(1);
    const read = await device.get(HELD.id);
    expect(
      read.ok && [read.value.version, read.value.properties.title],
    ).toEqual([4, "edited"]);
  });
});

describe("a conflicted copy names its original", () => {
  const SIBLING = "01a00000-0000-7000-8000-0000000000bb";
  const LINK = "01a00000-0000-7000-8000-0000000000ec";
  const link = (original: string) =>
    wireEdge({
      id: LINK,
      source_id: SIBLING,
      target_id: original,
      edge_type: "derived-from",
    });

  /** Reads the copy's link from both ends, in the store as `device` opens it. */
  async function expectLinked(
    device: Harness["device"],
    original: string,
    when: string,
  ): Promise<void> {
    const from = await device.edgesFrom(SIBLING);
    expect(from.ok, JSON.stringify(from)).toBe(true);
    if (!from.ok) return;
    expect(
      from.value.map((edge) => `${edge.edge_type} ${edge.target_id}`),
      `${when}: the copy holds the conflicted copy and not its link to the original, so an app cannot show the two together`,
    ).toEqual([`derived-from ${original}`]);
    const to = await device.edgesTo(original);
    expect(to.ok, JSON.stringify(to)).toBe(true);
    if (!to.ok) return;
    expect(
      to.value.map((edge) => edge.source_id),
      `${when}: the original does not answer the copy made from it`,
    ).toEqual([SIBLING]);
  }

  it("holds the link with the sibling after the verdict's catch-up, and after the store is reopened", async () => {
    harness = await startHarness("verdicts-conflicted-link");
    const { server, device } = harness;
    scriptHydration(server, { head: "1", rows: held() });
    // The server logs the sibling, then its link to the original, then the
    // original's update, all from the one transaction.
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("4", [
        copyItemEvent(
          "2",
          "item.created",
          wireItem({
            id: SIBLING,
            properties: { title: "edited", body: "edited" },
          }),
          { tags: ["conflicted-copy"] },
        ),
        edgeEvent("3", "edge.created", link(HELD.id)),
        copyItemEvent(
          "4",
          "item.updated",
          wireItem({
            id: HELD.id,
            version: 5,
            properties: { title: "held", body: "the server's" },
          }),
        ),
      ]),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const report = await updateAndDrain(
      harness,
      [
        answers.resolved(
          wireItem({
            id: HELD.id,
            version: 5,
            properties: { title: "held", body: "the server's" },
          }),
          { body: "keep_both_copies" },
          SIBLING,
        ),
      ],
      [
        answers.updated(
          wireItem({
            id: HELD.id,
            version: 5,
            properties: { title: "held", body: "the server's" },
          }),
        ),
      ],
    );
    expect(report.verdicts[0]?.conflicted_copy_id).toBe(SIBLING);
    // The witness: before the catch-up the copy holds no link, so the one
    // after it came with the sibling's events.
    const before = await device.edgesTo(HELD.id);
    expect(before.ok && before.value).toEqual([]);

    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    await expectLinked(device, HELD.id, "after the catch-up");
    await expectLinked(device.reopen(), HELD.id, "after a reopen");
  });

  it("holds the link a catch-up brings where the copy does not hold the original", async () => {
    harness = await startHarness("verdicts-conflicted-link-unheld");
    const { server, device } = harness;
    const unheld = "01a00000-0000-7000-8000-0000000000ef";
    scriptHydration(server, { head: "1", rows: {} });
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("3", [
        copyItemEvent(
          "2",
          "item.created",
          wireItem({ id: SIBLING, properties: { title: "t", body: "lost" } }),
          { tags: ["conflicted-copy"] },
        ),
        edgeEvent("3", "edge.created", link(unheld)),
      ]),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    const original = await device.get(unheld);
    expect(original.ok).toBe(false);
    await expectLinked(device, unheld, "after the catch-up");
    await expectLinked(device.reopen(), unheld, "after a reopen");
  });

  it("holds the link a hydration reads with the sibling, where the copy does not hold the original", async () => {
    harness = await startHarness("verdicts-conflicted-link-hydrated");
    const { server, device } = harness;
    const unheld = "01a00000-0000-7000-8000-0000000000ef";
    scriptHydration(server, {
      head: "1",
      rows: {
        "core.note": [
          {
            item: {
              id: SIBLING,
              properties: { title: "t", body: "lost" },
              edges: {
                "derived-from": { data: [link(unheld)], next_cursor: null },
              },
            },
            tags: ["conflicted-copy"],
          },
        ],
      },
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const original = await device.get(unheld);
    expect(original.ok).toBe(false);
    await expectLinked(device, unheld, "after the hydration");
    await expectLinked(device.reopen(), unheld, "after a reopen");
  });
});

describe("the server did not take the write", () => {
  it("refused: carries the server's code and is not sent again", async () => {
    harness = await hydratedHarness("verdicts-refused", { rows: held() });
    const report = await updateAndDrain(
      harness,
      [refusal(403, "type_forbidden", "this key may not write core.note")],
      // The read a refusal is reconciled against: the server's row, which
      // still carries what it held before the write it declined.
      [
        answers.updated(
          wireItem({
            id: HELD.id,
            version: HELD.version,
            properties: { title: "held", body: "held" },
          }),
        ),
      ],
    );
    expect(report.verdicts[0]?.verdict).toBe("refused");
    expect(
      report.verdicts[0]?.reason,
      "the verdict does not carry the server's own code, so a caller is told the write failed and not what the server said",
    ).toBe("type_forbidden");
    const queued = await harness.device.queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      JSON.parse(queued.value[0]?.answer ?? "null"),
      "the queue does not keep the server's refusal whole",
    ).toEqual({
      error: {
        code: "type_forbidden",
        message: "this key may not write core.note",
      },
    });

    // Not sent again, and the copy is put back to what the server holds.
    const sentBefore = harness.server.requests.filter(
      (request) => request.method === "PATCH",
    ).length;
    expect((await harness.device.drain()).ok).toBe(true);
    expect(
      harness.server.requests.filter((request) => request.method === "PATCH")
        .length,
      "a refused write went out again, so the device is asking a server to change its mind about a refusal no retry changes",
    ).toBe(sentBefore);

    const read = await harness.device.get(HELD.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(
      read.value.properties.title,
      "the copy kept the edit the server refused, and a refusal produces no event, so every later read of that row would answer a change that never happened",
    ).toBe("held");
  });

  it("refused: preserves the local row until a fresh read succeeds at the next drain", async () => {
    harness = await hydratedHarness("verdicts-refused-unread", {
      rows: held(),
    });
    const report = await updateAndDrain(
      harness,
      [refusal(403, "type_forbidden", "this key may not write core.note")],
      // The first read meets a server that cannot answer; the next is the
      // row as another device has since left it.
      [
        refusal(503, "write_contention", "the write lock is busy"),
        answers.updated(
          wireItem({
            id: HELD.id,
            version: HELD.version + 1,
            properties: { title: "theirs", body: "held" },
          }),
        ),
      ],
    );
    expect(report.verdicts[0]?.verdict).toBe("refused");

    const unread = await harness.device.get(HELD.id);
    expect(unread.ok).toBe(true);
    if (!unread.ok) return;
    expect(
      unread.value.properties.title,
      "the failed read changed local content before a certified response could reconcile the settled refusal",
    ).toBe("edited");

    const again = await harness.device.drain();
    expect(again.ok).toBe(true);
    const read = await harness.device.get(HELD.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(
      read.value.properties.title,
      "the read-back that failed was never tried again, so the copy stays on a row the server moved past until something else touches it",
    ).toBe("theirs");
    expect(read.value.version).toBe(HELD.version + 1);
    expect(
      harness.server.requests.filter(
        (request) =>
          request.method === "GET" && request.pathname === `/items/${HELD.id}`,
      ).length,
      "the owed read-back went out more than once after it was answered",
    ).toBe(2);
  });

  it("refused: takes a read-back answered 400 invalid_id as the server holding no such row", async () => {
    harness = await hydratedHarness("verdicts-refused-invalid-id", {
      rows: held(),
    });
    const created = await harness.device.create({
      type: "core.note",
      properties: { title: "never lands", body: "never lands" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.item_id ?? "a";
    const shown = await harness.device.get(id);
    expect(
      shown.ok,
      "the fixture's create was not shown to a read before the drain, so a row gone after it proves nothing",
    ).toBe(true);

    scriptWrites(harness.server, {
      create: [refusal(400, "invalid_id", "the id is not a UUIDv7")],
      read: [refusal(400, "invalid_id", "the id is not a UUIDv7")],
    });
    const drained = await harness.device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    if (!drained.ok) return;
    expect(drained.value.verdicts.map((verdict) => verdict.verdict)).toEqual([
      "refused",
    ]);

    const gone = await harness.device.get(id);
    expect(
      gone.ok ? "held" : gone.refusal.code,
      "the read-back refused for its id was read as a failure, so the row the create showed stays in the copy",
    ).toBe("not_held");
    const discarded = await harness.device.discard(created.value.id);
    expect(discarded.ok).toBe(true);
    if (discarded.ok)
      expect(
        discarded.value,
        "a discard of the refused create was refused while its read-back stayed owed",
      ).toBe(true);
    expect(await harness.device.queue()).toMatchObject({ ok: true, value: [] });
  });

  it.each([
    ["404 item_not_found", refusal(404, "item_not_found", "Item not found")],
    [
      "403 type_not_permitted",
      refusal(403, "type_not_permitted", "this key may not read core.note"),
    ],
  ])(
    "refused: lets the row go where the read-back is answered %s",
    async (_status, read) => {
      harness = await hydratedHarness("verdicts-refused-read-gone", {
        rows: held(),
      });
      const created = await harness.device.create({
        type: "core.note",
        properties: { title: "never lands", body: "never lands" },
      });
      if (!created.ok) throw new Error(JSON.stringify(created));
      const id = created.value.item_id ?? "";
      // The witness: the row was shown before the drain.
      expect((await harness.device.get(id)).ok).toBe(true);
      scriptWrites(harness.server, {
        create: [refusal(400, "invalid_properties", "body is required")],
        read: [read],
      });
      const drained = await harness.device.drain();
      expect(drained.ok && drained.value.verdicts[0]?.verdict).toBe("refused");
      const gone = await harness.device.get(id);
      expect(
        gone.ok ? "held" : gone.refusal.code,
        "a read-back saying the server holds no row the key reads left the refused create's row in the copy",
      ).toBe("not_held");
    },
  );

  it("refused: keeps the row the copy holds where the read-back answers an older one", async () => {
    // The copy holds the row as a later write stamped it, which a follow on
    // the same core can bring between the read-back and its write. The
    // version alone cannot order the two: a transition, a delete, a restore
    // and a tag write leave it where it was.
    harness = await hydratedHarness("verdicts-refused-older", {
      rows: {
        "core.note": [
          {
            item: {
              id: HELD.id,
              version: HELD.version,
              updated_at: "2026-03-02T00:00:00.000Z",
              properties: { title: "held", body: "held" },
            },
          },
        ],
      },
    });
    const report = await updateAndDrain(
      harness,
      [refusal(403, "type_forbidden", "this key may not write core.note")],
      [
        answers.updated(
          wireItem({
            id: HELD.id,
            version: HELD.version,
            updated_at: "2026-03-01T00:00:00.000Z",
            properties: { title: "stale", body: "stale" },
          }),
        ),
      ],
    );
    expect(report.verdicts[0]?.verdict).toBe("refused");
    const read = await harness.device.get(HELD.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(
      read.value.properties.title,
      "a read-back stamped before the row the copy holds was written over it, which rolls the copy back under a change whose event is already behind the cursor",
    ).toBe("held");
    expect(read.value.updated_at).toBe("2026-03-02T00:00:00.000Z");
  });

  it("refused: reads the server's code, message, fields and missing grant into the refusal", async () => {
    harness = await hydratedHarness("verdicts-refused-typed", {
      rows: {
        "core.note": [
          { item: { id: "a", version: 1 } },
          { item: { id: "b", version: 1 } },
        ],
      },
    });
    for (const id of ["a", "b"]) {
      const edit = await harness.device.update(id, {
        properties: { title: `edited ${id}` },
        version: 1,
      });
      expect(edit.ok).toBe(true);
    }
    scriptWrites(harness.server, {
      update: [
        refusal(400, "invalid_properties", "Invalid properties", {
          // The second entry names no property, so it is no field's.
          errors: [{ field: "title", message: "Too long" }, { message: "Bad" }],
        }),
        refusal(403, "type_not_permitted", "this key may not write core.note", {
          grant: { kind: "type", name: "core.note", level: "write" },
        }),
      ],
      read: [
        answers.updated(wireItem({ id: "a", version: 1 })),
        answers.updated(wireItem({ id: "b", version: 1 })),
      ],
    });
    const drained = await harness.device.drain();
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    const [fields, grant] = drained.value.verdicts;
    expect(
      fields?.refusal,
      "the drain reported a refusal as a code alone, so an app has to decode the server's text to say which field was wrong",
    ).toEqual({
      reason: "invalid_properties",
      code: "invalid_properties",
      message: "Invalid properties",
      fields: [{ field: "title", message: "Too long" }],
      trashed: false,
      grant: null,
    });
    expect(grant?.item_id).toBe("b");
    expect(
      grant?.refusal?.grant,
      "a refusal naming the grant the key lacks did not say which",
    ).toEqual({ kind: "type", name: "core.note", level: "write" });

    const queue = await harness.device.queue();
    expect(queue.ok).toBe(true);
    if (!queue.ok) return;
    expect(
      queue.value.map((row) => row.refusal),
      "the queue does not read the refusal it holds the way the drain reported it",
    ).toEqual(drained.value.verdicts.map((verdict) => verdict.refusal));
    expect(queue.value.map((row) => row.refusal?.code)).toEqual([
      "invalid_properties",
      "type_not_permitted",
    ]);
  });

  it("refused: says when the row a write named is in the bin", async () => {
    harness = await hydratedHarness("verdicts-refused-trashed", {
      rows: {
        "core.note": [
          { item: { id: "binned", version: 1 } },
          { item: { id: "gone", version: 1 } },
        ],
      },
    });
    for (const id of ["binned", "gone"]) {
      const edit = await harness.device.update(id, {
        properties: { title: `edited ${id}` },
        version: 1,
      });
      expect(edit.ok).toBe(true);
    }
    scriptWrites(harness.server, {
      update: [
        refusal(404, "item_not_found", "Item binned not found", {
          trashed: true,
        }),
        // The witness: the same refusal naming no bin is not one.
        refusal(404, "item_not_found", "Item gone not found"),
      ],
      read: [refusal(404, "item_not_found", "not found")],
    });
    const drained = await harness.device.drain();
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(
      drained.value.verdicts.map((verdict) => verdict.refusal?.trashed),
      "a refusal saying the row is in the bin read the same as one for a row that is gone, so nothing offers to restore it with the edit",
    ).toEqual([true, false]);
  });

  it("blocked: is passed over by a drain and reported with its reason", async () => {
    harness = await hydratedHarness("verdicts-blocked", { rows: held() });
    const report = await updateAndDrain(harness, [
      refusal(409, "ancestor_unavailable", "no snapshot of that version"),
    ]);
    expect(report.verdicts[0]?.verdict).toBe("blocked");
    expect(report.verdicts[0]?.reason).toBe("ancestor_unavailable");
    expect(
      report.verdicts[0]?.refusals,
      "a blocked write was counted toward the ceiling, and a block is not a failure: it would die waiting for a person",
    ).toBe(0);

    // Passed over by the next drain rather than retried.
    const before = harness.server.requests.length;
    const again = await harness.device.drain();
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(
      harness.server.requests.length,
      "a blocked write was sent again, and the same request is refused identically however often anyone sends it",
    ).toBe(before);
    expect(
      again.value.answered,
      "the drain counted a blocked row as sent, so its own report disagrees with what went out",
    ).toBe(0);

    // And the queue still reports it, which is how a person finds it.
    const queue = await harness.device.queue();
    expect(queue.ok).toBe(true);
    if (!queue.ok) return;
    expect(
      queue.value[0]?.reason,
      "the queue does not say why the row is stopped, so a caller sees a write that never moves and no reason",
    ).toBe("ancestor_unavailable");
  });

  it("dead: is terminal once the ceiling is reached", async () => {
    harness = await hydratedHarness("verdicts-dead", { rows: held() });
    const edit = await harness.device.update(HELD.id, {
      properties: { title: "dying" },
      version: HELD.version,
    });
    expect(edit.ok).toBe(true);

    // A 200 whose body will not read: a failure a further attempt might
    // clear, which is the one class the ceiling exists for.
    scriptWrites(harness.server, {
      update: [{ kind: "json", status: 200, body: "not json at all" }],
    });
    const counts: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const drained = await harness.device.drain();
      expect(drained.ok).toBe(true);
      if (drained.ok) counts.push(drained.value.verdicts[0]?.refusals ?? -1);
    }
    expect(
      counts,
      "the refusals were not counted one per answer, so the ceiling is reached at some number other than five",
    ).toEqual([1, 2, 3, 4, 5]);

    const queue = await harness.device.queue();
    expect(queue.ok).toBe(true);
    if (!queue.ok) return;
    expect(
      queue.value[0]?.verdict,
      "five counted refusals did not kill the write, so a device retries a failure that never clears forever",
    ).toBe("dead");

    // Terminal: a further drain does not send it.
    const before = harness.server.requests.length;
    expect((await harness.device.drain()).ok).toBe(true);
    expect(
      harness.server.requests.length,
      "a dead write was sent again, so the ceiling stops nothing",
    ).toBe(before);
  });
});

describe("a verdict is reported, not acted on", () => {
  it("reports a conflict rather than resolving it", async () => {
    harness = await hydratedHarness("verdicts-report", { rows: held() });
    const envelope = refusal(
      409,
      "version_conflict",
      "the row moved under this write",
    );
    const report = await updateAndDrain(harness, [envelope]);
    expect(
      report.verdicts[0]?.verdict,
      "a conflict the server declined to resolve was settled by the device, and a device that picked a value would have to be believed by every other device, which nothing makes them do",
    ).toBe("blocked");
    expect(report.verdicts[0]?.reason).toBe("conflict_unresolved");

    // The copy is untouched: no merge, no version minted, nothing written
    // on the device's own authority.
    const read = await harness.device.get(HELD.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(
      read.value.version,
      "the device advanced the version of a row the server refused to change, which is a version it minted",
    ).toBe(HELD.version);

    // And the envelope is kept whole, because what a device reports has to
    // be what it was told.
    const queue = await harness.device.queue();
    expect(queue.ok).toBe(true);
    if (!queue.ok) return;
    expect(
      queue.value[0]?.answer,
      "the server's envelope was not kept, so a caller reading the queue is told a verdict and not the answer it came from",
    ).toContain("version_conflict");
  });

  it("refuses the writes that were waiting on a create the server refused", async () => {
    harness = await hydratedHarness("verdicts-dependants", { rows: held() });
    const created = await harness.device.create({
      type: "core.note",
      properties: { title: "never lands", body: "never lands" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.item_id ?? "a";
    const edit = await harness.device.update(id, {
      properties: { title: "waiting" },
      version: 0,
    });
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;

    scriptWrites(harness.server, {
      create: [refusal(400, "invalid_properties", "body is required")],
      // The create was refused, so the server holds no such row.
      read: [refusal(404, "item_not_found", "no such item")],
    });
    const drained = await harness.device.drain();
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;

    const byId = new Map(
      drained.value.verdicts.map((verdict) => [verdict.id, verdict]),
    );
    expect(byId.get(created.value.id)?.verdict).toBe("refused");
    expect(
      byId.get(edit.value.id)?.verdict,
      "a write waiting on a create the server never accepted was left queued or sent, and there is no row for it to be written to",
    ).toBe("refused");
    expect(
      byId.get(edit.value.id)?.reason,
      "the dependant's reason does not name the write that was refused, so a caller is told this row failed and not why",
    ).toContain("create_item");
    expect(
      byId.get(edit.value.id)?.refusal,
      "a refusal the drain made carries parts only a server's envelope can",
    ).toEqual({
      reason: byId.get(edit.value.id)?.reason,
      code: null,
      message: null,
      fields: [],
      trashed: false,
      grant: null,
    });
    expect(
      harness.server.requests.some((request) => request.method === "PATCH"),
      "the dependant went to the server although its create was refused",
    ).toBe(false);
  });

  it("answers about whole fields, never about part of one", async () => {
    harness = await hydratedHarness("verdicts-whole", { rows: held() });
    const edit = await harness.device.update(HELD.id, {
      properties: { body: "line one\nline two\nmine" },
      version: HELD.version,
    });
    expect(edit.ok).toBe(true);

    const sent = JSON.parse(
      await (async () => {
        scriptWrites(harness!.server, {
          read: [
            answers.updated(
              wireItem({
                id: HELD.id,
                version: 4,
                properties: { body: "line one\nline two\ntheirs" },
              }),
            ),
          ],
          update: [
            answers.resolved(
              wireItem({
                id: HELD.id,
                version: 4,
                properties: { body: "line one\nline two\ntheirs" },
              }),
              { body: "last_writer_wins" },
            ),
          ],
        });
        expect((await harness!.device.drain()).ok).toBe(true);
        return (
          harness!.server.requests.find((request) => request.method === "PATCH")
            ?.body ?? "{}"
        );
      })(),
    ) as { properties: Record<string, string> };

    // What went out is the caller's value whole. A device that had merged
    // inside the field would send something neither the caller nor the
    // server wrote, and whether a body is ever merged line by line is not
    // settled — so a device that assumed it were would be guessing.
    expect(
      sent.properties.body,
      "the device sent something other than the whole value it was handed, so it merged inside a field on its own authority",
    ).toBe("line one\nline two\nmine");

    const read = await harness.device.get(HELD.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(
      read.value.properties.body,
      "the copy holds a body that is part the server's and part its own, which is a value neither of them ever wrote",
    ).toBe("line one\nline two\ntheirs");
  });
});
