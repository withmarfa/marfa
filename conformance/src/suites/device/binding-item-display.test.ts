import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  copyItemEvent,
  copyReplay,
  typeCatalog,
  wireEdge,
  wireItem,
  wireType,
} from "../../device/marfa-answers.js";
import type { BindingHarness } from "./harness.js";
import { bindingHarness } from "./binding.shared.js";

/**
 * A device names and previews an item from its held catalog and rows, as the server
 * names it. The cases are the ones the server's names are held to in
 * `compliance/item-summaries.test.ts`, so the two cannot drift. Given an
 * item's id, it names a part with no title of its own after the host the copy
 * holds out of the bin (`device/item-name-part`).
 */

interface SharedType {
  id: string;
  parent?: string;
  fields: Record<string, unknown>;
  display_hints?: Record<string, string>;
}

const SHARED = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/item-display.json", import.meta.url),
    "utf8",
  ),
) as {
  types: SharedType[];
  cases: {
    description: string;
    type: string;
    properties: Record<string, unknown>;
    name: string | null;
    preview: string | null;
  }[];
};

let harness: BindingHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("an item's name and preview on a device", () => {
  it("names and previews every shared case from the copy's catalog, without asking the server", async () => {
    const own = await bindingHarness("binding-item-display", {
      setup: ({ server }) => {
        server.copyAnswer("GET", "/types", () =>
          typeCatalog(
            SHARED.types.map((type) => ({
              ...wireType(type.id, {
                parent: type.parent,
                fields: type.fields,
              }),
              // As registered: a type without hints of its own inherits its
              // parent's, which a scripted default would hide.
              display_hints: type.display_hints ?? {},
            })),
          ),
        );
      },
    });
    harness = own;
    const types = await own.device.itemTypes();
    expect(
      types.ok && types.value.map((type) => type.id),
      "the copy does not hold the shared types, so the cases below would be named by the fallback fields alone",
    ).toEqual(expect.arrayContaining(SHARED.types.map((type) => type.id)));

    const asked = own.server.requests.length;
    const shown = await own.device.itemDisplays(
      SHARED.cases.map(({ type, properties }) => ({ type, properties })),
    );
    expect(shown.ok, JSON.stringify(shown)).toBe(true);
    if (!shown.ok) return;
    expect(own.server.requests.slice(asked)).toEqual([]);
    expect(shown.value).toHaveLength(SHARED.cases.length);
    SHARED.cases.forEach(({ description, name, preview }, at) => {
      expect(
        {
          name: shown.value[at]?.name ?? null,
          preview: shown.value[at]?.preview ?? null,
        },
        description,
      ).toEqual({ name, preview });
    });
  });

  it("names a part after the host the copy holds out of the bin, and by its body where it holds none", async () => {
    const UNHELD = "01a00000-0000-7000-8000-0000000000ff";
    const on = (id: string, host: string) => ({
      "comments-on": {
        data: [
          wireEdge({
            id: `edge-${id}`,
            source_id: id,
            target_id: host,
            edge_type: "comments-on",
          }),
        ],
        next_cursor: null,
      },
    });
    const own = await bindingHarness("binding-item-display-parts", {
      rows: {
        "core.note": [
          { item: { id: "issue", properties: { title: "Fix login bug" } } },
          {
            item: {
              id: "comment",
              properties: { body: "LGTM\n\nShip it" },
              edges: on("comment", "issue"),
            },
          },
          {
            item: {
              id: "reply",
              properties: { body: "Agreed" },
              edges: on("reply", "comment"),
            },
          },
          {
            item: {
              id: "stray",
              properties: { body: "Seen it" },
              edges: on("stray", UNHELD),
            },
          },
        ],
      },
    });
    harness = own;
    const named = async () => {
      const asked = own.server.requests.length;
      const shown = await own.device.itemDisplays(
        [
          ["comment", { body: "LGTM\n\nShip it" }],
          ["reply", { body: "Agreed" }],
          ["stray", { body: "Seen it" }],
        ].map(([id, properties]) => ({
          id: id as string,
          type: "core.note",
          properties: properties as Record<string, unknown>,
        })),
      );
      expect(shown.ok, JSON.stringify(shown)).toBe(true);
      expect(own.server.requests.slice(asked)).toEqual([]);
      return shown.ok
        ? shown.value.map(({ name, preview }) => [name, preview ?? null])
        : [];
    };
    expect(await named()).toEqual([
      ["Comment on Fix login bug", "LGTM Ship it"],
      // A reply is named after its comment, which is named after its body.
      ["Comment on LGTM", "Agreed"],
      // A host the copy does not hold names nothing.
      ["Seen it", null],
    ]);

    // A rename of the host reaches the part's name, and a host in the bin
    // leaves the part named by its body.
    own.events.set(
      copyReplay("11", [
        copyItemEvent(
          "11",
          "item.updated",
          wireItem({
            id: "issue",
            version: 2,
            properties: { title: "Fix the login page" },
          }),
        ),
      ]),
    );
    const renamed = await own.device.catchUp();
    expect(renamed.ok, JSON.stringify(renamed)).toBe(true);
    expect((await named())[0]).toEqual([
      "Comment on Fix the login page",
      "LGTM Ship it",
    ]);
    own.events.set(
      copyReplay("12", [
        copyItemEvent(
          "12",
          "item.deleted",
          wireItem({
            id: "issue",
            version: 3,
            state: "trashed",
            properties: { title: "Fix the login page" },
          }),
        ),
      ]),
    );
    const binned = await own.device.catchUp();
    expect(binned.ok, JSON.stringify(binned)).toBe(true);
    expect((await named())[0]).toEqual(["LGTM", "Ship it"]);
  });
});
