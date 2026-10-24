import { describe, it, expect, afterEach } from "vitest";
import {
  startHarness,
  scriptHydration,
  scriptKey,
  type Harness,
} from "./harness.js";
import {
  copyHeldLog,
  copyItemEvent,
  typeCatalog,
  wireItem,
  wireType,
} from "../../device/marfa-answers.js";

/**
 * A slice of every type, declared as `*` alone, for an app and a folder alike
 * (`device/hydrate-every-type`). The listing it reads names no type, which
 * leaves `system.*` out, so a namespace registered after the hydration needs
 * no second one.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const ROWS = {
  "core.note": [{ item: { id: "n1" } }],
  "core.bookmark": [{ item: { id: "b1", type: "core.bookmark" } }],
  "system.connection": [{ item: { id: "s1", type: "system.connection" } }],
};

function listings(h: Harness): string[] {
  return h.server.requests
    .filter((request) => request.pathname === "/items")
    .map((request) => request.query.toString());
}

describe("a slice of every type", () => {
  it("hydrates every type but system.* from the listing naming no type", async () => {
    harness = await startHarness("every-type");
    const { server, device } = harness;
    scriptHydration(server, { head: "10", rows: ROWS });

    const hydrated = await device.hydrate(["*"], "library");
    expect(hydrated.ok, JSON.stringify(hydrated)).toBe(true);
    if (!hydrated.ok) return;
    expect(hydrated.value.types).toEqual(["*"]);
    expect(
      hydrated.value.items,
      "the copy took a system row, or left a type out",
    ).toBe(2);
    for (const query of listings(harness)) {
      expect(
        new URLSearchParams(query).has("type"),
        `the listing named a type: ${query}`,
      ).toBe(false);
    }
    expect((await device.get("n1")).ok).toBe(true);
    expect((await device.get("b1")).ok).toBe(true);
    expect(
      (await device.get("s1")).ok,
      "a slice of every type held a system row",
    ).toBe(false);
    const status = await device.status();
    expect(status.ok && status.value.slice_types).toEqual(["*"]);

    // The witness: the same rows named by type are read by their own
    // listings.
    const named = await device.hydrate(["core.note", "core.bookmark"], "library");
    expect(named.ok && named.value.items).toBe(2);
    expect(
      listings(harness).some((query) => query.includes("type=core.note")),
      "naming the types did not name them in the listing",
    ).toBe(true);
  });

  it("refuses the star beside another type before any request, and takes it said twice", async () => {
    harness = await startHarness("every-type-mixed");
    const { server, device } = harness;
    scriptHydration(server, { head: "10", rows: ROWS });

    for (const types of [
      ["*", "core.note"],
      ["core.note", "*"],
      ["*", "acme.*"],
    ]) {
      const refused = await device.hydrate(types, "library");
      expect(
        refused.ok,
        `hydrating ${JSON.stringify(types)} was accepted, so a slice of every type can carry types that add nothing`,
      ).toBe(false);
      if (!refused.ok) expect(refused.refusal.code).toBe("invalid");
    }
    expect(
      server.requests.map((request) => request.pathname),
      "a refusal went to the server first",
    ).toEqual([]);

    // The witness: the star alone hydrates on the same device.
    expect((await device.hydrate(["*", "*"], "library")).ok).toBe(true);
  });

  it("takes an item of a namespace registered after it hydrated, with no second hydration, and never a system row", async () => {
    harness = await startHarness("every-type-late");
    const { server, device } = harness;
    scriptHydration(server, { head: "10", rows: ROWS });
    // Registered after the hydration: it read the catalog without the type,
    // every read after with it.
    let reads = 0;
    server.copyAnswer("GET", "/types", () => {
      reads += 1;
      return typeCatalog(
        reads > 1 ? [wireType("acme.late", { parent: undefined })] : [],
      );
    });
    scriptKey(server);
    server.copyAnswer(
      "GET",
      "/events",
      copyHeldLog([
        copyItemEvent(
          "11",
          "item.created",
          wireItem({ id: "late", type: "acme.late" }),
        ),
        copyItemEvent(
          "12",
          "item.created",
          wireItem({ id: "feed", type: "system.connection" }),
        ),
      ]),
    );
    expect((await device.hydrate(["*"], "library")).ok).toBe(true);
    const hydrations = listings(harness).length;

    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    expect(
      (await device.get("late")).ok,
      "an item of a namespace registered after the hydration was dropped, so an app holding every type has to hydrate again to see it",
    ).toBe(true);
    expect(
      (await device.get("feed")).ok,
      "a system event entered a slice of every type",
    ).toBe(false);
    expect(
      listings(harness).length,
      "the item arrived by a listing, not by its event",
    ).toBe(hydrations);
    if (caught.ok) expect(caught.value.cursor).toBe("12");
  });

  it("counts every type but system.* as the items expected, and leaves the count out where the server gave none", async () => {
    harness = await startHarness("every-type-expected");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      pageSize: 1,
      drop: () => true,
      rows: ROWS,
    });
    expect((await device.hydrate(["*"], "library")).ok).toBe(false);
    const filling = await device.status();
    expect(filling.ok, JSON.stringify(filling)).toBe(true);
    if (!filling.ok) return;
    expect(filling.value.hydration).toBe("in_progress");
    expect(
      filling.value.items_expected,
      "the count took a system type, or left one out",
    ).toBe(2);
    const counted = server.requests.filter(
      (request) => request.pathname === "/items/stats",
    );
    expect(counted.map((request) => request.query.toString())).toEqual([
      "by=type&tier=library",
    ]);
  });

  it("leaves the expected count out, not zero, where the server did not count", async () => {
    harness = await startHarness("every-type-uncounted");
    const { server, device } = harness;
    server.answer("GET", "/items/stats", {
      kind: "json",
      status: 500,
      body: { error: { code: "internal_error", message: "the count failed" } },
    });
    scriptHydration(server, {
      head: "10",
      pageSize: 1,
      drop: () => true,
      rows: ROWS,
    });
    expect((await device.hydrate(["*"], "library")).ok).toBe(false);
    const filling = await device.status();
    expect(filling.ok, JSON.stringify(filling)).toBe(true);
    if (!filling.ok) return;
    expect("items_expected" in filling.value).toBe(false);
  });

  it("reads the whole slice again when a hydration stopped part way is run again", async () => {
    harness = await startHarness("every-type-interrupted");
    const { server, device } = harness;
    let cut = true;
    scriptHydration(server, {
      head: "10",
      pageSize: 1,
      drop: () => cut,
      rows: ROWS,
    });
    expect((await device.hydrate(["*"], "library")).ok).toBe(false);
    const partial = await device.status();
    expect(partial.ok && partial.value.hydration).toBe("in_progress");
    expect(partial.ok && partial.value.slice_types).toEqual(["*"]);

    cut = false;
    const again = await device.hydrate(["*"], "library");
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!again.ok) return;
    expect(
      [again.value.items, again.value.pages],
      "the second run resumed the first, so the copy is short whatever the first missed",
    ).toEqual([2, 2]);
    const complete = await device.status();
    expect(complete.ok && complete.value.hydration).toBe("complete");
  });
});
