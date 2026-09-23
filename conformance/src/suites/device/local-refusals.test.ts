import { describe, it, expect, afterEach, vi } from "vitest";
import { answers, refusal, wireItem } from "../../device/marfa-answers.js";
import type { DeviceUnderTest } from "../../device/protocol.js";
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

describe("a device refuses a filter it does not implement", () => {
  it("refuses a list filter it does not implement", async () => {
    harness = await hydrated("list-filter");
    const { device } = harness;

    // The control. A listing the device does implement has to answer, or the
    // refusal below is a device that cannot list at all.
    const listed = await device.list({ type: "core.note" });
    expect(listed.ok).toBe(true);
    expect(listed.ok ? listed.value.length : 0).toBe(1);

    const refused = await device.list({
      type: "core.note",
      unsupported: ["--filter", 'title eq "nothing here"'],
    });
    expect(
      refused.ok,
      "a filter the device does not implement was accepted, so the listing answered every row and a caller reads that as a filter that matched",
    ).toBe(false);
    if (!refused.ok) {
      expect(
        refused.refusal.code,
        `the device refused, but not by saying it does not offer the filter: ${refused.refusal.raw}`,
      ).toBe("usage");
    }
  });

  it("refuses a search filter it does not implement", async () => {
    harness = await hydrated("search-filter");
    const { device } = harness;

    const found = await device.search("n1");
    expect(
      found.ok,
      `search itself was refused: ${JSON.stringify(found)}`,
    ).toBe(true);

    const refused = await device.attempt([
      "search",
      "n1",
      "--filter",
      'type eq "core.bookmark"',
    ]);
    expect(
      refused.ok,
      "a search filter the device does not implement was accepted, so the search answered the unfiltered set and reported it as filtered",
    ).toBe(false);
    if (!refused.ok) {
      expect(
        refused.refusal.code,
        `the device refused, but not by saying it does not offer the filter: ${refused.refusal.raw}`,
      ).toBe("usage");
    }
  });
});

describe("a device refuses a write only the server may make", () => {
  it("refuses a local purge", async () => {
    harness = await hydrated("purge");
    // The control, and it is what makes the refusal below mean anything: a
    // subcommand of the same group that does exist. Without it, refusing
    // `items purge` would be satisfied by a binary with no `items` at all.
    const offered = await harness.device.get("n1");
    expect(
      offered.ok,
      `the device offers no \`items\` commands either, so the refusals below say nothing about purging in particular: ${JSON.stringify(offered)}`,
    ).toBe(true);

    for (const command of [
      ["items", "purge", "n1"],
      ["purge", "n1"],
    ]) {
      const refused = await harness.device.attempt(command);
      expect(
        refused.ok,
        `the device offers \`${command.join(" ")}\`, and purging is the server's on a credential holding it: a device that purges locally destroys rows nothing can bring back`,
      ).toBe(false);
      if (!refused.ok) {
        expect(
          refused.refusal.code,
          `the device refused \`${command.join(" ")}\` for some other reason than not offering it: ${refused.refusal.raw}`,
        ).toBe("usage");
      }
    }
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
    const reader = harness.device.reopen({ reader: true });
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
      harness.server.requests.filter(
        (request) => request.pathname === "/events",
      ),
      "a reading handle reached the event stream",
    ).toHaveLength(1);
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
