import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { startHarness, scriptHydration, type Harness } from "./harness.js";
import {
  copyItemEvent,
  itemsPage,
  copyReplay,
  typeCatalog,
  wireItem,
} from "../../device/marfa-answers.js";
import type { Outcome } from "../../device/protocol.js";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

function value<T>(outcome: Outcome<T>): T {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  if (!outcome.ok) throw new Error(outcome.refusal.raw);
  return outcome.value;
}

const changedCatalog = () =>
  typeCatalog([{ id: "acme.note", parent: "core.note" }]);
const damage = [
  { name: "malformed JSON", text: '{"title":' },
  { name: "non-object JSON", text: "[1]" },
];

function damageItem(store: string, text: string): void {
  const db = new DatabaseSync(store);
  try {
    db.prepare("UPDATE items SET properties = ? WHERE id = 'damaged'").run(
      text,
    );
  } finally {
    db.close();
  }
}

it.each(damage)(
  "reindexes past $name, preserving its bytes and tags until a later event repairs it",
  async ({ text }) => {
    harness = await startHarness("catalog-damaged");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [
          {
            item: {
              id: "damaged",
              properties: { title: "stalewords", body: "staletext" },
            },
            tags: ["genuinetag"],
          },
          {
            item: {
              id: "healthy",
              properties: { title: "healthywords", body: "healthytext" },
            },
          },
        ],
      },
    });
    let changed = false;
    server.copyAnswer("GET", "/types", () =>
      changed ? changedCatalog() : typeCatalog(),
    );
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [
        copyItemEvent("11", "item.created", wireItem({ id: "neighbor" })),
      ]),
      copyReplay("12", [
        copyItemEvent(
          "12",
          "item.updated",
          wireItem({
            id: "damaged",
            version: 2,
            properties: { title: "repairedwords", body: "repairedtext" },
          }),
          { tags: ["genuinetag"] },
        ),
      ]),
    );
    value(await device.hydrate(["core.note"], "library"));
    const hits = async (query: string) =>
      value(await device.search(query)).map((hit) => hit.item.id);
    expect(await hits("stalewords")).toEqual(["damaged"]);
    expect(await hits("staletext")).toEqual(["damaged"]);
    expect(await hits("genuinetag")).toEqual(["damaged"]);
    expect(await hits("healthywords")).toEqual(["healthy"]);
    const before = value(await device.status()).catalog_version;
    damageItem(device.store, text);
    expect((await device.get("damaged")).ok).toBe(false);
    changed = true;

    expect(value(await device.catchUp()).catalog_changed).toBe(true);

    expect(value(await device.status()).catalog_version).not.toBe(before);
    expect(value(await device.itemType("acme.note")).id).toBe("acme.note");
    expect(value(await device.get("neighbor")).id).toBe("neighbor");
    expect((await device.get("damaged")).ok).toBe(false);
    const stored = new DatabaseSync(device.store, { readOnly: true });
    try {
      expect(
        stored
          .prepare("SELECT properties FROM items WHERE id = 'damaged'")
          .get(),
      ).toEqual({ properties: text });
      expect(
        stored
          .prepare(
            "SELECT title, body, description, name, extra, tags FROM items_fts WHERE rowid = (SELECT seq FROM items WHERE id = 'damaged')",
          )
          .get(),
      ).toEqual({
        title: "",
        body: "",
        description: "",
        name: "",
        extra: "",
        tags: "genuinetag",
      });
    } finally {
      stored.close();
    }
    expect(await hits("stalewords")).toEqual([]);
    expect(await hits("staletext")).toEqual([]);
    expect(await hits("healthywords")).toEqual(["healthy"]);

    value(await device.catchUp());
    expect(value(await device.get("damaged")).version).toBe(2);
    expect(await hits("repairedwords")).toEqual(["damaged"]);
    expect(await hits("genuinetag")).toEqual(["damaged"]);
  },
);

it.each(damage)(
  "hydrates a changed catalog and repairs $name",
  async ({ text }) => {
    harness = await startHarness("hydrate-damaged");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "1",
      rows: { "core.note": [{ item: { id: "damaged" } }] },
    });
    let changed = false;
    server.copyAnswer("GET", "/types", () =>
      changed ? changedCatalog() : typeCatalog(),
    );
    server.copyAnswer("GET", "/items", () =>
      itemsPage([
        {
          item: wireItem({
            id: "damaged",
            version: changed ? 2 : 1,
            properties: {
              title: changed ? "repairedwords" : "original",
              body: "body",
            },
          }),
        },
      ]),
    );
    value(await device.hydrate(["core.note"], "library"));
    const before = value(await device.status()).catalog_version;
    damageItem(device.store, text);
    expect((await device.get("damaged")).ok).toBe(false);
    changed = true;

    value(await device.hydrate(["core.note"], "library"));

    expect(value(await device.status()).catalog_version).not.toBe(before);
    expect(value(await device.itemType("acme.note")).id).toBe("acme.note");
    expect(value(await device.get("damaged")).version).toBe(2);
    expect(value(await device.get("damaged")).properties.title).toBe(
      "repairedwords",
    );
  },
);
