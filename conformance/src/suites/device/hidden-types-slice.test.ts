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
 * (`device/slice-hidden-subtype`), and a copy an earlier release made lets go
 * of the hidden items its slice does not take on its first catch-up
 * (`device/catch-up-lets-go-hidden`).
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

it("lets go of an unpinned hidden item a copy holds on its first catch-up, and keeps a pinned one", async () => {
  harness = await startHarness("hidden-subtype-first-catch-up");
  const { server, device } = harness;
  scriptHydration(server, { head: "10", catalog });
  for (const id of ["s1", "s2"]) {
    server.copyAnswer(
      "GET",
      `/items/${id}`,
      answers.updated(wireItem({ id, type: HIDDEN })),
    );
  }
  server.copyAnswer(
    "GET",
    "/events",
    copyReplay("11", [
      copyItemEvent("11", "item.created", wireItem({ id: "later" })),
    ]),
    copyHeadRead("11"),
  );
  expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
  expect((await device.pin("s1")).ok).toBe(true);
  expect((await device.pin("s2")).ok).toBe(true);
  expect((await device.get("s1")).ok, "the witness is held").toBe(true);

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
  expect(
    (await device.get("s1")).ok,
    "an unpinned hidden item the slice does not take was kept",
  ).toBe(false);
  expect((await device.get("s2")).ok, "a pinned hidden item was let go").toBe(
    true,
  );
});
