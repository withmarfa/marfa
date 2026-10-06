import { describe, it, expect, afterEach, vi } from "vitest";
import { answers, refusal, wireItem } from "../../device/marfa-answers.js";
import type { DeviceUnderTest, Outcome } from "../../device/protocol.js";
import {
  hydratedHarness,
  scriptHydration,
  scriptWrites,
  startHarness,
  type Harness,
} from "./harness.js";

/**
 * "What a device may never do locally, and must refuse."
 *
 * Every rule here is a refusal, and each is a refusal because the silent
 * version is invisible. A dropped filter answers every row and reads as a
 * filter that matched; a dropped tag reads as an item that never had one; a
 * locally resolved conflict reads as agreement. None of them raises anything
 * anywhere, which is why each is written as a refusal rather than as a best
 * effort.
 */

/** A row the copy already holds, so an update has something to be based on. */
const HELD = { id: "01a00000-0000-7000-8000-00000000000a", version: 3 };

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

async function hydrated(label: string): Promise<Harness> {
  const started = await startHarness(label);
  scriptHydration(started.server, {
    head: "10",
    rows: { "core.note": [{ item: { id: "n1" } }] },
  });
  expect((await started.device.hydrate(["core.note"], "library")).ok).toBe(
    true,
  );
  return started;
}

/**
 * Each expression the server's listing grammar refuses with
 * `validation_error`, beside the reason. An expression the device dropped
 * instead would answer every row, and one it refused some other way would
 * tell a caller something different from what the server tells them.
 */
const OUTSIDE_THE_GRAMMAR: Array<[string, string]> = [
  ['properties.meta.author eq "n1"', "a nested property path"],
  ['title eq "n1"', "a field the grammar does not know"],
  ['tags eq "n1"', "an operator tags do not take"],
  ['edge[parent-of] gt "n1"', "an operator edges do not take"],
  ["state exists", "a presence test on a field every item has"],
  [
    'properties.title eq "n1" AND properties.body eq "x" OR tags exists',
    "AND and OR in one expression",
  ],
  ['properties.title eq "n1" AND', "a logical operator with nothing after it"],
  ['properties.title eq "n1', "an unterminated string"],
  ["properties.title eq n1", "a bare word where a value goes"],
  ["", "an empty expression"],
  [
    Array.from({ length: 11 }, () => "tags exists").join(" AND "),
    "eleven conditions",
  ],
  [
    `properties.title eq "${"x".repeat(2049 - 'properties.title eq ""'.length)}"`,
    "2049 characters",
  ],
  [`properties.rank gt 1${"0".repeat(400)}`, "a number no double holds"],
  ["properties.title eq null", "a null literal after eq"],
  ["properties.title neq null", "a null literal after neq"],
  ["properties.rank gte null", "a null literal after gte"],
  ["properties.title starts_with null", "a null literal after starts_with"],
  ["edge[parent-of] eq null", "a null literal after an edge's eq"],
  ["source_id eq null", "a null literal on a system field"],
  ["tags contains null", "a null literal after tags contains"],
];

/**
 * A refusal refused as the server refuses it: the binary's `validation`
 * class, carrying the server's own `validation_error` beside it, which is
 * what the same expression sent to the server comes back as.
 */
function expectRefusedAsTheServerDoes(
  outcome: Outcome<unknown>,
  why: string,
): void {
  expect(
    outcome.ok,
    `${why} was accepted, so the read answered as though the filter matched`,
  ).toBe(false);
  if (outcome.ok) return;
  const envelope = JSON.parse(outcome.refusal.raw) as {
    error: { code: string; server: { code: string | null } | null };
  };
  expect(
    [envelope.error.code, envelope.error.server?.code],
    `${why} was refused, but not as the server refuses it: ${outcome.refusal.raw}`,
  ).toEqual(["validation", "validation_error"]);
}

describe("a device refuses a filter outside the listing grammar", () => {
  it("refuses a list filter the grammar refuses, as the server does", async () => {
    harness = await hydrated("list-filter");
    const { device } = harness;

    // The witnesses. A filter inside the grammar answers, and narrows: one
    // selects the row and one does not, so the refusals below are the
    // grammar's rather than a device that refuses every filter, and the
    // limits are refused one past where they stop, not at them.
    const matched = await device.list({ filter: 'properties.title eq "n1"' });
    expect(
      matched.ok,
      `a well-formed filter was refused: ${JSON.stringify(matched)}`,
    ).toBe(true);
    expect(matched.ok ? matched.value.map((item) => item.id) : []).toEqual([
      "n1",
    ]);
    const missed = await device.list({ filter: 'properties.title eq "n2"' });
    expect(missed.ok ? missed.value.length : -1).toBe(0);
    const ten = await device.list({
      filter: Array.from({ length: 10 }, () => "tags not_exists").join(" AND "),
    });
    expect(
      ten.ok,
      `ten conditions are within the grammar and were refused: ${JSON.stringify(ten)}`,
    ).toBe(true);
    const longest = await device.list({
      filter: `properties.title eq "${"x".repeat(2048 - 'properties.title eq ""'.length)}"`,
    });
    expect(
      longest.ok,
      `2048 characters are within the grammar and were refused: ${JSON.stringify(longest)}`,
    ).toBe(true);
    const bounded = await device.list({ filter: "properties.rank gt 1" });
    expect(
      bounded.ok,
      `a number a double holds was refused: ${JSON.stringify(bounded)}`,
    ).toBe(true);

    for (const [expression, why] of OUTSIDE_THE_GRAMMAR) {
      expectRefusedAsTheServerDoes(
        await device.list({ filter: expression }),
        why,
      );
    }
  });

  it("refuses a search filter the grammar refuses, as the server does", async () => {
    harness = await hydrated("search-filter");
    const { device } = harness;

    const found = await device.search("n1", {
      filter: 'properties.title eq "n1"',
    });
    expect(
      found.ok,
      `a well-formed search filter was refused: ${JSON.stringify(found)}`,
    ).toBe(true);
    expect(found.ok ? found.value.map((hit) => hit.item.id) : []).toEqual([
      "n1",
    ]);

    for (const [expression, why] of OUTSIDE_THE_GRAMMAR) {
      expectRefusedAsTheServerDoes(
        await device.search("n1", { filter: expression }),
        `on a search, ${why}`,
      );
    }
  });

  it("refuses a search filter the grammar refuses on a search with no words", async () => {
    harness = await hydrated("wordless-search-filter");
    const { device } = harness;

    // The witness: a search with no words answers nothing, and answers it
    // under a well-formed filter, so the refusals below are the filter's.
    const nothing = await device.search(" ", {
      filter: 'properties.title eq "n1"',
    });
    expect(
      nothing.ok,
      `a search with no words was refused: ${JSON.stringify(nothing)}`,
    ).toBe(true);
    expect(nothing.ok ? nothing.value : null).toEqual([]);

    for (const [expression, why] of OUTSIDE_THE_GRAMMAR) {
      expectRefusedAsTheServerDoes(
        await device.search(" ", { filter: expression }),
        `on a search with no words, ${why}`,
      );
    }
  });
});

describe("a device refuses a condition its copy cannot answer as the server does", () => {
  it("refuses a backref condition on a list and a search", async () => {
    harness = await hydrated("backref-filter");
    const { device } = harness;
    // The witness: a refusal the server makes carries its code where the
    // backref refusals below carry none.
    expectRefusedAsTheServerDoes(
      await device.list({ filter: 'title eq "n1"' }),
      "a field the grammar does not know",
    );

    for (const [outbound, inbound] of [
      ["edge[parent-of] exists", "backref[parent-of] exists"],
      [
        'tags exists OR edge[parent-of] neq "n1"',
        'tags exists OR backref[parent-of] neq "n1"',
      ],
    ] as const) {
      // The witness: the same expression over the edges the copy holds.
      const listed = await device.list({ filter: outbound });
      expect(
        listed.ok,
        `${outbound} was refused, so the refusal below is not about the backref: ${JSON.stringify(listed)}`,
      ).toBe(true);
      const searched = await device.search("n1", { filter: outbound });
      expect(searched.ok).toBe(true);

      for (const outcome of [
        await device.list({ filter: inbound }),
        await device.search("n1", { filter: inbound }),
      ]) {
        expect(
          outcome.ok,
          `${inbound} was answered from a copy that holds no edge drawn to its rows from outside the slice`,
        ).toBe(false);
        if (outcome.ok) continue;
        const envelope = JSON.parse(outcome.refusal.raw) as {
          error: { code: string; server?: { code: string | null } | null };
        };
        expect(
          [envelope.error.code, envelope.error.server?.code ?? null],
          `${inbound} was refused as though the server refuses it: ${outcome.refusal.raw}`,
        ).toEqual(["invalid", null]);
      }
    }
  });
});

describe("a device refuses a write only the server may make", () => {
  it("queues no purge, and keeps the row, when the purge cannot be sent", async () => {
    harness = await startHarness("purge");
    scriptHydration(harness.server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "n1", state: "trashed" } }] },
    });
    expect((await harness.device.hydrate(["core.note"], "library")).ok).toBe(
      true,
    );
    // The witness: the row is held in the bin, and nothing is queued, before
    // the purge.
    const bin = await harness.device.list({ state: "trashed" });
    expect(bin.ok && bin.value.map((row) => row.id)).toEqual(["n1"]);
    const before = await harness.device.queue();
    expect(before.ok && before.value).toEqual([]);

    await harness.server.offline();
    const refused = await harness.device.purgeItem("n1");
    await harness.server.online();
    expect(
      refused.ok,
      "a purge the server never received was answered as done",
    ).toBe(false);
    if (!refused.ok) {
      expect(
        refused.refusal.code,
        `a purge that could not reach the server was refused for some other reason: ${refused.refusal.raw}`,
      ).toBe("network");
    }
    const kept = await harness.device.list({ state: "trashed" });
    expect(
      kept.ok && kept.value.map((row) => row.id),
      "the copy let the row go though the server never purged it",
    ).toEqual(["n1"]);
    const after = await harness.device.queue();
    expect(
      after.ok && after.value,
      "a purge the device could not send was held for later",
    ).toEqual([]);

    // A purge is an item's: the binary offers none outside `items`.
    const bare = await harness.device.attempt(["purge", "n1"]);
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.refusal.code).toBe("usage");
  });

  it("refuses a write to a store bound to another server", async () => {
    harness = await hydrated("bound-store");
    const before = await harness.device.status();
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const elsewhere = await startHarness("bound-store-other");
    try {
      scriptHydration(elsewhere.server, { head: "10" });
      const wrong = harness.device.reopen({ url: elsewhere.server.url });
      const refused = await wrong.catchUp();
      expect(
        refused.ok,
        "a store bound to one server took events from another, so one copy carries two datasets and no read can say which server a row came from",
      ).toBe(false);
      if (!refused.ok) {
        expect(
          refused.refusal.code,
          `the device refused for some other reason, so nothing here shows it noticed the store belongs elsewhere: ${refused.refusal.raw}`,
        ).toBe("wrong_server");
      }
      expect(
        elsewhere.server.requests,
        "the device read from the second server before noticing the store was not its own, so a wrong address costs a round trip and puts this dataset into that server's logs",
      ).toEqual([]);

      // And nothing reached the store, which is the half the rule is about:
      // a refusal reported after a row had landed would be a refusal in name.
      const after = await harness!.device.status();
      expect(after.ok).toBe(true);
      if (after.ok) {
        expect(
          [after.value.items, after.value.server_origin],
          "the store changed while refusing a write from another server, so the refusal was reported and the write happened anyway",
        ).toEqual([1, before.value.server_origin]);
      }
    } finally {
      await elsewhere.stop();
    }
  });

  it("refuses a write from a reading handle", async () => {
    harness = await hydratedHarness("reading-handle", {
      rows: { "core.note": [{ item: { id: HELD.id, version: HELD.version } }] },
    });
    // A write the server accepts and never answers, so the drain sending it
    // stays running and holds the store. `catch-up` will not do: it ends
    // when it reaches the head whatever the stream does, so a second
    // command meeting it would be meeting a race rather than a rule.
    const queued = await harness.device.create({
      type: "core.note",
      properties: { title: "held open", body: "held open" },
    });
    expect(
      queued.ok,
      `the fixture could not queue the write whose send holds the store: ${JSON.stringify(queued)}`,
    ).toBe(true);
    scriptWrites(harness.server, { create: [{ kind: "stall" }] });

    const writer = harness.device.hold(["drain"]);
    // Waited for rather than assumed: the claim is taken when the process
    // opens the store, and a fixture that raced it would read the refusals
    // below as a device with no lock at all.
    await vi.waitFor(
      () => {
        expect(
          writer.running(),
          `the writer exited before it could hold anything: ${writer.stderr}`,
        ).toBe(true);
        expect(
          harness?.server.requests.some((request) => request.method === "POST"),
          "the held drain has not reached the server yet, so it may not have opened the store",
        ).toBe(true);
      },
      { timeout: 10_000, interval: 25 },
    );

    const second = harness.device.reopen();
    try {
      await expectRefusedAsReader(
        second,
        writer,
        queued.ok ? queued.value.id : "",
      );
    } finally {
      await writer.stop();
    }
  });
});

describe("a store opened to read writes nothing from the server either", () => {
  it("refuses a hydration, a catch-up and a follow from a reading handle", async () => {
    harness = await hydratedHarness("reading-open-refusals", {
      rows: { "core.note": [{ item: { id: HELD.id, version: HELD.version } }] },
    });
    // Named a server that is not one: a reading handle is refused before
    // any server is resolved, so resolving one cannot fail it, or refresh
    // a kept token for a command that will never send.
    const readsBefore = harness.server.requests.length;
    const reader = harness.device.reopen({
      reader: true,
      url: "not a server url",
    });
    // The witness: the reading open reads, so the refusals below are the
    // handle and not a store it cannot open.
    const listed = await reader.list();
    expect(
      listed.ok,
      `a store opened to read could not be read: ${JSON.stringify(listed)}`,
    ).toBe(true);
    const refusals = {
      hydrate: await reader.hydrate(["core.note"], "library"),
      "catch-up": await reader.catchUp(),
      follow: await reader.follow(1),
    };
    for (const [door, outcome] of Object.entries(refusals)) {
      expect(
        outcome.ok,
        `a reading handle ran a ${door}, which writes the copy the writer holds`,
      ).toBe(false);
      if (!outcome.ok) {
        expect(
          outcome.refusal.code,
          `the ${door} was refused for another reason: ${outcome.refusal.raw}`,
        ).toBe("reading_handle");
      }
    }
    expect(
      harness.server.requests.length,
      "a reading handle reached the server",
    ).toBe(readsBefore);
  });
});

/** Every write door, against a device that is not the writer. */
async function expectRefusedAsReader(
  second: DeviceUnderTest,
  writer: { running: () => boolean },
  /** The one write the fixture queued on purpose, to hold the store open. */
  holding: string,
): Promise<void> {
  const created = await second.create({
    type: "core.note",
    properties: { title: "from a reader", body: "from a reader" },
  });
  expect(
    created.ok,
    "a second opener wrote to a store another process holds the writer handle for, so two processes queue into one file and neither sees the other's rows",
  ).toBe(false);
  const updated = await second.update(HELD.id, {
    properties: { title: "from a reader" },
    version: HELD.version,
  });
  expect(
    updated.ok,
    "a second opener changed a row in a store it does not hold the writer handle for",
  ).toBe(false);
  const drained = await second.drain();
  expect(
    drained.ok,
    "a second opener drained the queue, so it would write verdicts onto rows the writer is still sending",
  ).toBe(false);

  // Reading still works, which is the whole point of it being a handle
  // rather than a refusal to open.
  const read = await second.list();
  expect(
    read.ok,
    `a reading handle could not read, so the second opener is refused rather than limited: ${JSON.stringify(read)}`,
  ).toBe(true);
  // And nothing the reader attempted reached the store.
  const queue = await second.queue();
  expect(queue.ok).toBe(true);
  if (!queue.ok) return;
  expect(
    queue.value.map((row) => row.id),
    "a write from a reading handle was refused and queued anyway, so the refusal is a message and not a rule",
  ).toEqual([holding]);
  // The control on all of it: the writer was still running, so the
  // refusals above are the handle rather than a store that refuses
  // everybody. Read last, because a writer that exited partway through
  // would make the earlier refusals mean nothing.
  expect(
    writer.running(),
    "the process holding the writer handle exited while this ran, so the refusals above were a store with no writer at all rather than a store with another one",
  ).toBe(true);
}

describe("a device refuses to decide what the server decides", () => {
  it("refuses to merge two values for one field", async () => {
    harness = await hydratedHarness("no-merge", {
      rows: {
        "core.note": [
          {
            item: {
              id: HELD.id,
              version: HELD.version,
              properties: { title: "held", body: "the server's line" },
            },
          },
        ],
      },
    });
    const edit = await harness.device.update(HELD.id, {
      properties: { body: "my line" },
      version: HELD.version,
    });
    expect(edit.ok).toBe(true);

    scriptWrites(harness.server, {
      read: [
        answers.updated(
          wireItem({
            id: HELD.id,
            version: HELD.version + 1,
            properties: { title: "held", body: "the server's line" },
          }),
        ),
      ],
      update: [
        answers.updated(
          wireItem({
            id: HELD.id,
            version: HELD.version + 1,
            properties: { title: "held", body: "the server's line" },
          }),
        ),
      ],
    });
    expect((await harness.device.drain()).ok).toBe(true);

    const sent = JSON.parse(
      harness.server.requests.find((request) => request.method === "PATCH")
        ?.body ?? "{}",
    ) as { properties: Record<string, string> };
    // Three values are in play: the one the copy held, the one the caller
    // wrote, and the one the server answered with. A device that merged
    // would produce a fourth, and nothing anywhere would show it: the copy
    // would simply hold a value neither writer ever wrote.
    expect(
      sent.properties.body,
      "the device sent something other than the value it was handed, so it combined its own field with the one the copy held",
    ).toBe("my line");

    const read = await harness.device.get(HELD.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(
      read.value.properties.body,
      "the copy holds a value that is part the caller's and part the server's, which is a value neither of them wrote and no other device will ever agree with",
    ).toBe("the server's line");
  });

  it("refuses to advance a version of its own accord", async () => {
    harness = await hydratedHarness("no-version", {
      rows: { "core.note": [{ item: { id: HELD.id, version: HELD.version } }] },
    });

    // A local create: version 0, which the server never mints. Not 1, which
    // would be a version the device decided the row was at.
    const created = await harness.device.create({
      type: "core.note",
      properties: { title: "local", body: "local" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const fresh = await harness.device.get(created.value.item_id ?? "a");
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(
      fresh.value.version,
      "a row the server has never seen carries a version the server mints, so nothing can tell it from a row the server has answered for",
    ).toBe(0);

    // An update to a held row: the version stays where the server put it
    // until the server answers. A device that advanced it would base its
    // next write on a version that exists nowhere.
    const edit = await harness.device.update(HELD.id, {
      properties: { title: "edited" },
      version: HELD.version,
    });
    expect(edit.ok).toBe(true);
    const pending = await harness.device.get(HELD.id);
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(
      pending.value.version,
      "the device advanced the version of a row nobody has answered for, so the next update is based on a version the server never minted",
    ).toBe(HELD.version);

    // And the server's number is taken when it arrives, which is the
    // control: the version moves, it just does not move here.
    scriptWrites(harness.server, {
      read: [
        answers.updated(
          wireItem({ id: created.value.item_id ?? "a", version: 1 }),
        ),
        answers.updated(wireItem({ id: HELD.id, version: HELD.version + 1 })),
      ],
      create: [
        answers.created(
          wireItem({ id: created.value.item_id ?? "a", version: 1 }),
        ),
      ],
      update: [
        answers.updated(wireItem({ id: HELD.id, version: HELD.version + 1 })),
      ],
    });
    expect((await harness.device.drain()).ok).toBe(true);
    const answered = await harness.device.get(HELD.id);
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    expect(
      answered.value.version,
      "the copy did not take the version the server answered with, so a version only ever comes from nowhere",
    ).toBe(HELD.version + 1);
  });

  it("refuses to resolve a conflict it was refused", async () => {
    harness = await hydratedHarness("no-resolve", {
      rows: {
        "core.note": [
          {
            item: {
              id: HELD.id,
              version: HELD.version,
              properties: { title: "held", body: "held" },
            },
          },
        ],
      },
    });
    const edit = await harness.device.update(HELD.id, {
      properties: { title: "mine", body: "mine" },
      version: HELD.version,
    });
    expect(edit.ok).toBe(true);

    scriptWrites(harness.server, {
      update: [refusal(409, "version_conflict", "the row moved under this")],
    });
    const drained = await harness.device.drain();
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(drained.value.verdicts[0]?.verdict).toBe("blocked");

    // It reports and stops. Nothing is written on the device's authority:
    // not a chosen value, not a version, not a second write.
    const read = await harness.device.get(HELD.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(
      read.value.version,
      "the device settled a conflict by advancing the version itself, and a device that picked a value would have to be believed by every other device",
    ).toBe(HELD.version);

    const before = harness.server.requests.length;
    expect((await harness.device.drain()).ok).toBe(true);
    expect(
      harness.server.requests.length,
      "the device sent a resolution of its own after the server refused to make one",
    ).toBe(before);

    // And the binary offers no door for resolving one by hand.
    const offered = await harness.device.attempt(["resolve", HELD.id]);
    expect(
      offered.ok,
      "the device offers a command for resolving a conflict, which is the server's to do inside its own transaction",
    ).toBe(false);
  });
});

describe("a device refuses to send less than it was given", () => {
  it("refuses a local create whose tags and edges it cannot queue", async () => {
    harness = await hydratedHarness("create-tags-edges", {
      rows: { "core.note": [{ item: { id: HELD.id, version: HELD.version } }] },
    });
    // Tags it can queue: each becomes its own write, waiting on the create.
    // Not dropped, and not folded into the create's body — where one verdict
    // would answer for the row and the tags together.
    const created = await harness.device.create({
      type: "core.note",
      properties: { title: "asked for tags", body: "asked for tags" },
      tags: ["alpha", "beta"],
    });
    expect(
      created.ok,
      `a create naming tags was refused outright: ${JSON.stringify(created)}`,
    ).toBe(true);
    if (!created.ok) return;

    const queue = await harness.device.queue();
    expect(queue.ok).toBe(true);
    if (!queue.ok) return;
    expect(
      queue.value.filter((row) => row.kind === "add_tag").map((row) => row.tag),
      "the create dropped the tags it was asked for and answered as though it had not been asked, which is the one failure nothing anywhere reports",
    ).toEqual(["alpha", "beta"]);

    // An edge it cannot queue from this door: the create offers no way to
    // name one, so a caller naming one is refused rather than having it
    // quietly ignored. A door that accepted the flag and did nothing with it
    // is exactly what this statement forbids.
    const withEdge = await harness.device.attempt([
      "items",
      "create",
      "--type",
      "core.note",
      "--properties",
      '{"title":"t","body":"b"}',
      "--edge",
      `core.references:${HELD.id}`,
    ]);
    expect(
      withEdge.ok,
      "the create took an edge it has no way to queue, so the edge was accepted and dropped and the caller was told the create succeeded",
    ).toBe(false);
    if (!withEdge.ok) {
      expect(
        withEdge.refusal.code,
        `the create refused the edge for some other reason than not offering it: ${withEdge.refusal.raw}`,
      ).toBe("usage");
    }
    // And the refusal left nothing behind, which is what refusing the create
    // rather than part of it means.
    const after = await harness.device.queue();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(
      after.value.length,
      "the refused create queued something anyway, so a drain would send a row the caller was told was refused",
    ).toBe(queue.value.length);
  });

  it("refuses an update carrying a field it cannot send", async () => {
    harness = await hydratedHarness("no-dropped-field", {
      rows: { "core.note": [{ item: { id: HELD.id, version: HELD.version } }] },
    });
    // A property this build has never heard of, beside one it has. The
    // rule is that neither is dropped: a device that quietly sent only the
    // fields it knew would answer as though it had not been asked for the
    // other, and nothing anywhere would say so.
    const edit = await harness.device.update(HELD.id, {
      properties: {
        title: "known",
        a_field_this_build_never_heard_of: { nested: [1, 2, 3] },
      },
      version: HELD.version,
    });
    expect(
      edit.ok,
      `an update carrying an unrecognized field was refused outright, which is allowed — but then it must say so rather than refusing as usage: ${JSON.stringify(edit)}`,
    ).toBe(true);

    scriptWrites(harness.server, {
      read: [
        answers.updated(wireItem({ id: HELD.id, version: HELD.version + 1 })),
      ],
      update: [
        answers.updated(wireItem({ id: HELD.id, version: HELD.version + 1 })),
      ],
    });
    expect((await harness.device.drain()).ok).toBe(true);
    const sent = JSON.parse(
      harness.server.requests.find((request) => request.method === "PATCH")
        ?.body ?? "{}",
    ) as { properties: Record<string, unknown> };
    expect(
      sent.properties.a_field_this_build_never_heard_of,
      "the device dropped a field it did not recognize and sent the rest, so a caller is told their update landed and one of their fields is gone",
    ).toEqual({ nested: [1, 2, 3] });
    expect(
      sent.properties.title,
      "the recognized field went missing too, so this says nothing about the unrecognized one",
    ).toBe("known");
  });
});

describe("a device holds an edge only from a row it holds", () => {
  it("refuses a local edge from a row the copy does not hold", async () => {
    harness = await startHarness("edge-source-unheld");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "1",
      rows: { "core.note": [{ item: { id: HELD.id, version: HELD.version } }] },
      edges: { "parent-of": [] },
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    // The witness: an edge from a row the copy holds is queued and held, so
    // the refusal below is about the source and not about edges at all.
    const outward = await device.createEdge({
      source: HELD.id,
      target: "elsewhere",
      type: "references",
    });
    expect(outward.ok, JSON.stringify(outward)).toBe(true);
    const before = await device.queue();
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const inward = await device.createEdge({
      source: "elsewhere",
      target: HELD.id,
      type: "references",
    });
    expect(
      inward.ok,
      "the copy took an edge from a row it does not hold, which no catch-up would ever keep current",
    ).toBe(false);
    if (!inward.ok) {
      expect(
        inward.refusal.code,
        `the edge was refused for some other reason than its source: ${inward.refusal.raw}`,
      ).toBe("invalid");
    }
    const after = await device.queue();
    expect(after.ok).toBe(true);
    expect(
      after.ok ? after.value.length : -1,
      "the refused edge was queued anyway, so a drain would send what the caller was told was refused",
    ).toBe(before.value.length);
    const to = await device.edgesTo(HELD.id);
    expect(to.ok, JSON.stringify(to)).toBe(true);
    expect(
      to.ok ? to.value : [],
      "the refused edge is held all the same",
    ).toEqual([]);

    // A type the slice holds whole is held whatever its source, so the same
    // edge of that type is taken.
    expect(
      (
        await device.hydrate(["core.note"], "library", {
          edgeTypes: ["parent-of"],
        })
      ).ok,
    ).toBe(true);
    const whole = await device.createEdge({
      source: "elsewhere",
      target: HELD.id,
      type: "parent-of",
    });
    expect(
      whole.ok,
      `an edge of a type the slice holds whole was refused for its source: ${JSON.stringify(whole)}`,
    ).toBe(true);
    const held = await device.edgesTo(HELD.id);
    expect(held.ok ? held.value.map((edge) => edge.edge_type) : []).toEqual([
      "parent-of",
    ]);
  });
});
