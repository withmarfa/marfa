import { describe, it, expect, afterEach } from "vitest";
import { startHarness, scriptHydration, type Harness } from "./harness.js";
import {
  answers,
  copyHeadRead,
  copyItemEvent,
  copyReplay,
  typeCatalog,
  wireItem,
  wireType,
} from "../../device/marfa-answers.js";

/**
 * A slice of every type, declared as `*` alone, for an app and a folder alike
 * (`device/hydrate-every-type`). The listing it reads names no type, which
 * leaves `system.*` out.
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
    const named = await device.hydrate(
      ["core.note", "core.bookmark"],
      "library",
    );
    expect(named.ok && named.value.items).toBe(2);
    expect(
      listings(harness).some((query) => query.includes("type=core.note")),
      "naming the types did not name them in the listing",
    ).toBe(true);
  });

  it("refuses the star beside a type that is not a system type before any request, and takes it said twice", async () => {
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
        `hydrating ${JSON.stringify(types)} was accepted, so a slice of every type can carry a type the caller may have meant to name instead`,
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

  it("takes the star beside a system type, and holds that type as well", async () => {
    harness = await startHarness("every-type-beside-system");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      catalog: typeCatalog([wireType("system.folder", { parent: undefined })]),
      rows: {
        ...ROWS,
        "system.folder": [{ item: { id: "f1", type: "system.folder" } }],
      },
    });

    const hydrated = await device.hydrate(["*", "system.folder"], "library");
    expect(hydrated.ok, JSON.stringify(hydrated)).toBe(true);
    expect((await device.get("n1")).ok).toBe(true);
    expect(
      (await device.get("f1")).ok,
      "a system type named beside the star was left out",
    ).toBe(true);
    // The witness: a system type not named stays out.
    expect((await device.get("s1")).ok).toBe(false);
  });

  it("takes no system row by event, but one that is pinned", async () => {
    harness = await startHarness("every-type-no-system");
    const { server, device } = harness;
    scriptHydration(server, { head: "10", rows: ROWS });
    const settings = (version: number, title: string) =>
      wireItem({
        id: "settings",
        type: "system.folder",
        version,
        properties: { title },
      });
    server.copyAnswer(
      "GET",
      "/items/settings",
      answers.updated(settings(1, "pinned")),
    );
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("13", [
        copyItemEvent(
          "11",
          "item.created",
          wireItem({ id: "feed", type: "system.connection" }),
        ),
        copyItemEvent("12", "item.updated", settings(2, "changed")),
        copyItemEvent("13", "item.created", wireItem({ id: "later" })),
      ]),
      copyHeadRead("13"),
    );
    expect((await device.hydrate(["*"], "library")).ok).toBe(true);
    expect((await device.pin("settings")).ok).toBe(true);

    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    // The witness: the stream carried rows a slice of every type takes.
    expect((await device.get("later")).ok).toBe(true);
    expect(
      (await device.get("feed")).ok,
      "a system event entered a slice of every type",
    ).toBe(false);
    const held = await device.get("settings");
    expect(
      held.ok && held.value.properties.title,
      "a pinned system row stopped taking its updates in a slice of every type",
    ).toBe("changed");
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
