import { describe, it, expect } from "vitest";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import { requireBinary } from "./harness.js";

/**
 * "A copy saves before it has reached a server."
 *
 * An app that has a person's note in its hand when no server is named, or
 * none is reachable, has to be able to keep it: a copy that refuses every
 * write until a first sync has made the person's save depend on a network
 * they were not using. These fixtures run the binary with no server at all.
 */

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

/** A store made by its state report, as a path with no store is refused (45). */
async function offline(label: string): Promise<CliDevice> {
  const device = new CliDevice({
    binary: requireBinary(),
    store: newStore(label),
  });
  value(await device.status());
  return device;
}

const RECIPE = {
  id: "app.recipe",
  fields: {
    title: { type: "string", required: true },
    servings: { type: "number" },
  },
};

describe("a copy no server has been named for", () => {
  it("saves a note against the types Marfa ships, shows it to a read, and queues it", async () => {
    const device = await offline("save-no-server");
    expect(value(await device.status()).hydration).toBe("never");

    const created = value(
      await device.create({
        type: "core.note",
        properties: { title: "Saved offline", body: "No server yet" },
      }),
    );
    expect(created.verdict).toBeNull();
    const id = created.item_id ?? "";
    const shown = value(await device.get(id));
    expect(
      [shown.properties.title, shown.tier],
      "a note saved with no server named was not shown to a read at the tier an app reads",
    ).toEqual(["Saved offline", "library"]);
    expect(
      value(await device.list({ type: "core.note" })).map((row) => row.id),
    ).toEqual([id]);
    expect(value(await device.queue()).map((row) => row.id)).toEqual([
      created.id,
    ]);

    // The witness: a write that breaks a shipped type's rule is refused, so the
    // note above was held to something.
    const refused = await device.create({
      type: "core.note",
      properties: { title: "No body" },
    });
    expect(
      refused.ok ? "queued" : refused.refusal.code,
      "a note missing a required field was queued by a copy that holds the type",
    ).toBe("validation");
  });

  it("knows the types and edge types Marfa ships, and says so of one it has never been told of", async () => {
    const device = await offline("save-shipped-types");
    const types = value(await device.itemTypes());
    expect(types.map((held) => held.id)).toContain("core.note");
    expect(value(await device.edgeType("parent-of")).id).toBe("parent-of");
    const absent = await device.itemType("app.recipe");
    expect(absent.ok ? "answered" : absent.refusal.code).toBe("not_found");
  });

  it("checks a write against the types the app declares, and holds an unknown one back", async () => {
    const device = await offline("save-declared");
    const unknown = await device.create({
      type: "app.recipe",
      properties: { title: "Soup" },
    });
    expect(
      unknown.ok ? "queued" : unknown.refusal.code,
      "a write of a type the copy was never told of was queued",
    ).toBe("unknown_type");

    value(await device.declareTypes([RECIPE]));
    expect(
      value(await device.itemType("app.recipe")).fields.map(
        (field) => field.name,
      ),
    ).toEqual(["servings", "title"]);
    const queued = value(
      await device.create({
        type: "app.recipe",
        properties: { title: "Soup", servings: 4 },
      }),
    );
    expect(queued.kind).toBe("create_item");
    for (const properties of [{}, { title: "Soup", servings: "four" }]) {
      const refused = await device.create({ type: "app.recipe", properties });
      expect(
        refused.ok ? "queued" : refused.refusal.code,
        `${JSON.stringify(properties)} was queued against a type that refuses it`,
      ).toBe("validation");
    }
    // Declaring it again with another rule replaces the first, and a write is
    // held to the one in force.
    value(
      await device.declareTypes([
        {
          id: "app.recipe",
          fields: { title: { type: "number", required: true } },
        },
      ]),
    );
    const renumbered = await device.create({
      type: "app.recipe",
      properties: { title: "Soup" },
    });
    expect(renumbered.ok ? "queued" : renumbered.refusal.code).toBe(
      "validation",
    );
    expect(value(await device.declaredTypes()).map((held) => held.id)).toEqual([
      "app.recipe",
    ]);
  });

  it("holds the app's latest declarations alone", async () => {
    const device = await offline("save-declared-set");
    value(await device.declareTypes([RECIPE]));
    expect(
      value(
        await device.create({
          type: "app.recipe",
          properties: { title: "Soup" },
        }),
      ).kind,
    ).toBe("create_item");
    // The app renames its type. A declaration is the whole set, so the old
    // name is no longer one the copy holds a write to.
    value(await device.declareTypes([{ id: "app.dish", fields: {} }]));
    expect(
      value(await device.declaredTypes()).map((held) => held.id),
      "a type the app no longer declares was still held",
    ).toEqual(["app.dish"]);
    const stale = await device.create({
      type: "app.recipe",
      properties: { title: "Soup" },
    });
    expect(stale.ok ? "queued" : stale.refusal.code).toBe("unknown_type");
    expect((await device.create({ type: "app.dish", properties: {} })).ok).toBe(
      true,
    );
  });

  it("refuses a declaration that names a type of Marfa's, one it cannot read, or a parent it does not know", async () => {
    const device = await offline("save-declare-refused");
    for (const definition of [
      { id: "core.note", fields: {} },
      { id: "system.thing", fields: {} },
      { id: "NotAType" },
      { id: "app.thing", fields: { n: { type: "nonsense" } } },
      { id: "app.child", parent: "app.absent", fields: {} },
    ]) {
      const refused = await device.declareTypes([definition]);
      expect(
        refused.ok ? "declared" : refused.refusal.code,
        `${JSON.stringify(definition)} was declared`,
      ).toBe("invalid");
    }
    expect(value(await device.declaredTypes())).toEqual([]);
    // The witness: a well-formed one is taken.
    value(await device.declareTypes([RECIPE]));
    expect(value(await device.declaredTypes())).toHaveLength(1);
  });
});
