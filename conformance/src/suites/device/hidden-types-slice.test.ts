import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
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
 * A slice that names a visible type takes no hidden subtype of it
 * (`device/slice-hidden-subtype`), and a hidden item a copy already holds stays
 * in it and is left out of what the copy lists and searches, as the server
 * leaves it out (`device/read-hidden`), while its updates still reach it
 * (`device/keep-held-hidden`).
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const HIDDEN = "app.other.setting";
const catalog = () => typeCatalog([wireType(HIDDEN, { parent: "core.note" })]);

it("takes no hidden subtype of a type it names by event, and takes the type's own item", async () => {
  harness = await startHarness("hidden-subtype-event");
  const { server, device } = harness;
  scriptHydration(server, { head: "10", catalog });
  server.copyAnswer(
    "GET",
    "/events",
    copyReplay("12", [
      copyItemEvent("11", "item.created", wireItem({ id: "s1", type: HIDDEN })),
      copyItemEvent("12", "item.created", wireItem({ id: "n2" })),
    ]),
    copyHeadRead("12"),
  );
  expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

  const caught = await device.catchUp();
  expect(caught.ok, JSON.stringify(caught)).toBe(true);
  expect((await device.get("n2")).ok, "the type's own item was left out").toBe(
    true,
  );
  expect(
    (await device.get("s1")).ok,
    "a slice naming a visible type took its hidden subtype",
  ).toBe(false);
});

it("keeps a hidden item an earlier release held and applies its update, and lists or finds it only where its exact type is named", async () => {
  harness = await startHarness("hidden-subtype-kept");
  const { server, device } = harness;
  scriptHydration(server, { head: "10", catalog });
  server.copyAnswer(
    "GET",
    "/items/s1",
    answers.updated(wireItem({ id: "s1", type: HIDDEN })),
  );
  server.copyAnswer(
    "GET",
    "/events",
    copyReplay("12", [
      copyItemEvent("11", "item.created", wireItem({ id: "later" })),
      copyItemEvent(
        "12",
        "item.updated",
        wireItem({ id: "s1", type: HIDDEN, version: 2 }),
      ),
    ]),
    copyHeadRead("12"),
  );
  expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
  expect((await device.pin("s1")).ok).toBe(true);

  // A copy an earlier release made held s1, listed and unpinned, by an event.
  const db = new DatabaseSync(device.store);
  try {
    db.prepare("DELETE FROM pins WHERE item_id = 's1'").run();
    db.prepare(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('item_listed/s1', 'true')",
    ).run();
  } finally {
    db.close();
  }

  const caught = await device.catchUp();
  expect(caught.ok, JSON.stringify(caught)).toBe(true);
  expect((await device.get("later")).ok, "the stream was applied").toBe(true);
  const held = await device.get("s1");
  expect(held.ok, "the copy let go of a hidden item it held").toBe(true);
  expect(
    held.ok ? held.value?.version : undefined,
    "the copy missed the update of a hidden item it held",
  ).toBe(2);

  const listed = async (type?: string | string[]) => {
    const answer = await device.list(type === undefined ? {} : { type });
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    return answer.ok ? answer.value.map((item) => item.id) : [];
  };
  const found = async (type?: string) => {
    const answer = await device.search(
      "body",
      type === undefined ? {} : { type },
    );
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    return answer.ok ? answer.value.map((hit) => hit.item.id) : [];
  };
  expect(await listed(HIDDEN), "the witness: its exact type").toContain("s1");
  expect(await found(HIDDEN)).toContain("s1");
  for (const answer of [
    await listed(),
    await listed("core.note"),
    await found(),
    await found("core.note"),
  ]) {
    expect(answer, "the visible witness").not.toHaveLength(0);
    expect(
      answer,
      "a read that names no hidden type answered it",
    ).not.toContain("s1");
  }
  expect(await listed("app.*"), "a wildcard opened a hidden type").toEqual([]);
});
