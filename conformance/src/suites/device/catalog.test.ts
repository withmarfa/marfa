import { describe, it, expect, afterEach } from "vitest";
import { startHarness, scriptHydration, type Harness } from "./harness.js";
import {
  edgeType,
  edgeTypeCatalog,
  heldLog,
  liveReplay,
  typeCatalog,
} from "../../device/marfa-answers.js";
import type {
  EdgeType,
  ItemType,
  Outcome,
  TypeField,
} from "../../device/protocol.js";

/**
 * "A working copy holds the catalog it reads its rows by."
 *
 * An app shows an item by its type's fields and an edge by its type's names,
 * and a copy that can only answer that with the server reachable is a copy
 * that cannot show a row offline. So the copy keeps both catalogs, reads them
 * locally, says plainly when it has none, and lets a caller learn that they
 * changed.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** A type an instance registered, as the listing answers it: declared, with
 *  no display hints of its own, so everything but its own fields is
 *  inherited. */
const RECIPE = {
  id: "acme.recipe",
  parent: "core.note",
  label: "Family recipe",
  version: 0,
  fields: {
    servings: {
      type: "number",
      description: "How many it feeds",
      required: true,
    },
    cuisine: { type: "string", enum_values: ["thai", "french"] },
  },
};

const MENTOR = edgeType("mentor-of", {
  label: "Mentor of",
  cardinality: "one-to-many",
  source_type_constraints: ["core.note"],
  property_schema: { since: { type: "string", description: "When it began" } },
  reverse_name: "mentored-by",
  written_at: "target",
});

function value<T>(outcome: Outcome<T>, what: string): T {
  expect(outcome.ok, `${what}: ${JSON.stringify(outcome)}`).toBe(true);
  if (!outcome.ok) throw new Error(what);
  return outcome.value;
}

function byName(fields: TypeField[]): Record<string, TypeField> {
  return Object.fromEntries(fields.map((field) => [field.name, field]));
}

describe("The type catalog a working copy holds", () => {
  it("reads a registered type with its label and inherited fields, and an edge type's reverse name, from the copy alone", async () => {
    harness = await startHarness("catalog-offline");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "1",
      catalog: typeCatalog([RECIPE]),
      edgeTypes: edgeTypeCatalog([MENTOR]),
    });
    value(await device.hydrate(["core.note"], "library"), "the hydration");

    const asked = server.requests.length;
    const local = device.reopen({ url: undefined, key: undefined });
    const types = value(await local.itemTypes(), "the list of item types");
    const recipe = value(await local.itemType("acme.recipe"), "acme.recipe");
    const edges = value(await local.edgeTypes(), "the list of edge types");
    const mentor = value(await local.edgeType("mentor-of"), "mentor-of");
    const parent = value(await local.edgeType("parent-of"), "parent-of");
    expect(
      server.requests.length,
      "a read of the catalog went to the server, so it answers nothing offline",
    ).toBe(asked);

    expect(
      types.map((type) => type.id).sort(),
      "the list does not hold the server's types, the registered one among them",
    ).toEqual(
      [
        "acme.recipe",
        "core.bookmark",
        "core.event",
        "core.file",
        "core.file.image",
        "core.highlight",
        "core.note",
      ].sort(),
    );
    expect(
      types.find((type) => type.id === "acme.recipe"),
      "the list and the read by id answer the same type differently",
    ).toEqual(recipe);

    const recipeRead: Omit<ItemType, "fields"> = {
      id: "acme.recipe",
      label: "Family recipe",
      description: null,
      parent: "core.note",
      version: 0,
      title_field: "title",
      body_field: "body",
      link_field: null,
      roles: [],
      compatible_with: [],
    };
    const { fields, ...rest } = recipe;
    expect(
      rest,
      "the registered type did not reach the caller as the server holds it, its display hints inherited from its parent",
    ).toEqual(recipeRead);
    const named = byName(fields);
    expect(
      Object.keys(named).sort(),
      "the type's fields are not its own beside the ones it inherits",
    ).toEqual(["body", "cuisine", "language", "notes", "servings", "title"]);
    expect(named.servings).toEqual({
      name: "servings",
      type: "number",
      required: true,
      description: "How many it feeds",
      declared_by: "acme.recipe",
      definition: RECIPE.fields.servings,
    });
    expect(
      named.cuisine?.definition,
      "a field's definition did not reach the caller whole",
    ).toEqual(RECIPE.fields.cuisine);
    expect(
      named.body,
      "an inherited field does not say which type declares it",
    ).toEqual({
      name: "body",
      type: "string",
      required: true,
      description: "The note text",
      declared_by: "core.note",
      definition: {
        type: "string",
        description: "The note text",
        required: true,
      },
    });

    expect(
      edges.map((type) => type.id).sort(),
      "the list does not hold the server's edge types, the registered one among them",
    ).toEqual(
      [
        "about",
        "attached-to",
        "authored-by",
        "derived-from",
        "in-collection",
        "in-folder",
        "in-thread",
        "mentor-of",
        "parent-of",
        "references",
        "supersedes",
      ].sort(),
    );
    const mentorRead: EdgeType = {
      id: "mentor-of",
      label: "Mentor of",
      description: null,
      cardinality: "one-to-many",
      reverse_name: "mentored-by",
      written_at: "target",
      source_type_constraints: ["core.note"],
      target_type_constraints: ["*"],
      cascade_on_delete: "orphan",
      properties: [
        {
          name: "since",
          type: "string",
          required: false,
          description: "When it began",
          declared_by: "mentor-of",
          definition: { type: "string", description: "When it began" },
        },
      ],
      shipped: false,
    };
    expect(
      mentor,
      "the registered edge type, its reverse name and the end that writes it did not reach the caller unchanged",
    ).toEqual(mentorRead);
    expect(
      [parent.reverse_name, parent.written_at, parent.shipped],
      "a shipped edge type's reverse name did not reach the caller",
    ).toEqual(["child-of", "target", true]);
  });

  it("refuses every catalog read on a copy that has never held a catalog, rather than answering no types", async () => {
    harness = await startHarness("catalog-never");
    const { server, device } = harness;
    // The state report makes the store without hydrating it (45).
    const status = value(await device.status(), "the state report");
    expect(status.hydration).toBe("never");
    expect(
      status.catalog_version,
      "a copy that has never read a catalog reports a version of one",
    ).toBeNull();

    for (const [what, read] of [
      ["the item types", () => device.itemTypes()],
      ["core.note", () => device.itemType("core.note")],
      ["the edge types", () => device.edgeTypes()],
      ["parent-of", () => device.edgeType("parent-of")],
    ] as const) {
      const refused = await read();
      expect(
        refused.ok ? "answered" : refused.refusal.code,
        `a read of ${what} on a copy with no catalog answered as if the instance had none`,
      ).toBe("no_catalog");
    }

    // The witness: the same reads answer once a hydration has read one.
    scriptHydration(server, { head: "1" });
    value(await device.hydrate(["core.note"], "library"), "the hydration");
    expect(value(await device.itemTypes(), "the item types")).not.toEqual([]);
    expect(value(await device.edgeType("parent-of"), "parent-of").id).toBe(
      "parent-of",
    );
  });

  it("refuses a type the copy's catalog does not hold, naming it", async () => {
    harness = await startHarness("catalog-absent");
    const { server, device } = harness;
    scriptHydration(server, { head: "1" });
    value(await device.hydrate(["core.note"], "library"), "the hydration");

    value(await device.itemType("core.note"), "the witness, core.note");
    const absent = await device.itemType("acme.absent");
    expect(absent.ok ? "answered" : absent.refusal.code).toBe("not_found");
    expect(absent.ok ? "" : absent.refusal.raw).toContain("acme.absent");
    const absentEdge = await device.edgeType("absent-of");
    expect(absentEdge.ok ? "answered" : absentEdge.refusal.code).toBe(
      "not_found",
    );
    expect(absentEdge.ok ? "" : absentEdge.refusal.raw).toContain("absent-of");
  });

  it("moves the catalog version when a catch-up reads a changed catalog, and only then", async () => {
    harness = await startHarness("catalog-version");
    const { server, device } = harness;
    let registered = false;
    scriptHydration(server, {
      head: "1",
      catalog: typeCatalog(),
      edgeTypes: () => edgeTypeCatalog(registered ? [MENTOR] : []),
    });
    server.answer("GET", "/types", () =>
      typeCatalog(registered ? [RECIPE] : []),
    );
    server.answer("GET", "/events", liveReplay("1", []));
    value(await device.hydrate(["core.note"], "library"), "the hydration");
    const hydrated = value(await device.status(), "the state report");
    expect(
      typeof hydrated.catalog_version,
      "a hydrated copy reports no catalog version",
    ).toBe("number");

    value(await device.catchUp(), "a catch-up against the same catalog");
    expect(
      value(await device.status(), "the state report").catalog_version,
      "a refresh that changed nothing moved the version, so a caller would read the catalog again for nothing",
    ).toBe(hydrated.catalog_version);

    registered = true;
    value(await device.catchUp(), "a catch-up against a changed catalog");
    const changed = value(await device.status(), "the state report");
    expect(
      changed.catalog_version,
      "a refresh that changed the catalog left the version where it was, so a caller is never told",
    ).not.toBe(hydrated.catalog_version);
    expect(
      value(await device.itemType("acme.recipe"), "acme.recipe").label,
    ).toBe("Family recipe");
    expect(
      value(await device.edgeType("mentor-of"), "mentor-of").reverse_name,
    ).toBe("mentored-by");
  });

  it("tells a held stream's caller when it reads a changed catalog", async () => {
    harness = await startHarness("catalog-follow");
    const { server, device } = harness;
    let registered = false;
    scriptHydration(server, {
      head: "1",
      catalog: typeCatalog(),
      edgeTypes: () => edgeTypeCatalog(registered ? [MENTOR] : []),
    });
    server.answer("GET", "/types", () =>
      typeCatalog(registered ? [RECIPE] : []),
    );
    server.answer("GET", "/events", heldLog([]));
    value(await device.hydrate(["core.note"], "library"), "the hydration");

    // The witness: a stream that reads the catalog the copy holds says nothing.
    const unchanged = value(await device.follow(2), "a follow");
    expect(
      unchanged.changes,
      "a held stream announced a catalog that had not changed",
    ).toEqual([]);

    registered = true;
    const followed = value(await device.follow(2), "a follow");
    expect(
      followed.changes.map(({ event, item_id, edge_id }) => ({
        event,
        item_id,
        edge_id,
      })),
      "a held stream read a changed catalog and did not tell its caller",
    ).toEqual([{ event: "catalog.changed", item_id: null, edge_id: null }]);
    expect(
      value(await device.edgeType("mentor-of"), "mentor-of").reverse_name,
    ).toBe("mentored-by");
  });
});
