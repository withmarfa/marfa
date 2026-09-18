import { describe, it, expect, afterEach } from "vitest";
import { startHarness, scriptHydration, type Harness } from "./harness.js";
import { notWrittenYet, skipIfPending } from "./pending.js";

/**
 * "What a device may never do locally, and must refuse."
 *
 * Every rule here is a refusal, and every one of them names something a
 * previous client did silently. A silently dropped filter answers every row
 * and reads as a filter that matched; a silently dropped tag reads as an item
 * that never had one; a locally resolved conflict reads as agreement. None of
 * them raises anything anywhere, which is why each is written as a refusal
 * rather than as a best effort.
 */

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
  });
});

describe("a device refuses a write only the server may make", () => {
  it("refuses a local purge", async () => {
    harness = await hydrated("purge");
    const { server, device } = harness;

    // The control: the row is there to be purged, so the refusal is about the
    // operation rather than about the row.
    expect((await device.get("n1")).ok).toBe(true);

    const refused = await device.attempt(["items", "purge", "n1"]);
    expect(
      refused.ok,
      "a device purged a row on its own authority, which removes something no other device can get back and which the server never agreed to",
    ).toBe(false);
    expect(
      server.requests.filter((request) => request.pathname.includes("/purge")),
      "the device reached the purge door, so the refusal above is the server's rather than the device's own",
    ).toEqual([]);
    expect(
      (await device.get("n1")).ok,
      "the row is gone from the copy after a refused purge, so the refusal was reported and the removal happened anyway",
    ).toBe(true);
  });

  it("refuses a write to a store bound to another server", async () => {
    harness = await hydrated("bound-store");
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
        expect(refused.refusal.code).toBe("wrong_server");
      }
      expect(
        elsewhere.server.requests,
        "the device read from the second server before noticing the store was not its own",
      ).toEqual([]);
    } finally {
      await elsewhere.stop();
    }
  });

  it("refuses a write from a reading handle", async (context) => {
    skipIfPending(context);
    notWrittenYet("a write from a reading handle");
  });
});

describe("a device refuses to decide what the server decides", () => {
  it("refuses to merge two values for one field", async (context) => {
    skipIfPending(context);
    notWrittenYet("a local merge");
  });

  it("refuses to advance a version of its own accord", async (context) => {
    skipIfPending(context);
    notWrittenYet("a locally advanced version");
  });

  it("refuses to resolve a conflict it was refused", async (context) => {
    skipIfPending(context);
    notWrittenYet("a locally resolved conflict");
  });
});

describe("a device refuses to send less than it was given", () => {
  it("refuses a local create whose tags and edges it cannot queue", async (context) => {
    skipIfPending(context);
    notWrittenYet("tags and edges on a local create");
  });

  it("refuses an update carrying a field it cannot send", async (context) => {
    skipIfPending(context);
    notWrittenYet("a field an update cannot send");
  });
});
