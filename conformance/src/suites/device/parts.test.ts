import { afterEach, describe, expect, it } from "vitest";
import {
  answers,
  copyItemEvent,
  copyReplay,
  edgeType,
  edgeTypeCatalog,
  typeCatalog,
  wireEdge,
  wireItem,
  type WireItemOptions,
} from "../../device/marfa-answers.js";
import type { DeviceUnderTest, Item, Outcome } from "../../device/protocol.js";
import type { SseFrame } from "../../device/scripted-server.js";
import { scriptHydration, startHarness, type Harness } from "./harness.js";

/**
 * A working copy answers the `part` filter term as the server does, from the
 * rows and edges it holds: an item out of the bin with an edge of a
 * `with-hosts` type to a host out of the bin is a part, and a host the copy
 * does not hold counts as out of the bin (`device/filter-part`). It applies
 * no part rule of its own on a delete: the parts of a host it deletes
 * offline follow from the server's events once it syncs
 * (`device/bin-parts-follow`).
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const VIEW = "01a00000-0000-7000-8000-00000000face";
const UNHELD = "01a00000-0000-7000-8000-0000000000ff";
/** A registered edge type that keeps its source with its hosts. */
const ANNOTATES = "acme.annotates";

function on(
  source: string,
  links: Array<[edgeType: string, target: string]>,
): WireItemOptions["edges"] {
  const edges: Record<string, { data: unknown[]; next_cursor: null }> = {};
  links.forEach(([type, target], at) => {
    (edges[type] ??= { data: [], next_cursor: null }).data.push(
      wireEdge({
        id: `edge-${source}-${String(at)}`,
        source_id: source,
        target_id: target,
        edge_type: type,
      }),
    );
  });
  return edges;
}

function note(
  id: string,
  links: Array<[string, string]> = [],
  options: Partial<WireItemOptions> = {},
): { item: WireItemOptions; tags?: string[] } {
  return {
    item: {
      id,
      properties: { body: `body of ${id}` },
      edges: on(id, links),
      ...options,
    },
  };
}

const ROWS = {
  "core.task": [
    { item: { id: "host", type: "core.task", properties: { title: "Host" } } },
    {
      item: {
        id: "binned",
        type: "core.task",
        state: "trashed",
        trashed_at: "2026-09-18T00:00:00.000Z",
        properties: { title: "Binned" },
      },
    },
    {
      item: {
        id: "shelved",
        type: "core.task",
        state: "archived",
        properties: { title: "Shelved" },
      },
    },
  ],
  "core.note": [
    note("comment", [["comments-on", "host"]]),
    note("on-binned", [["comments-on", "binned"]]),
    note("on-unheld", [["attached-to", UNHELD]]),
    note("on-shelved", [["comments-on", "shelved"]]),
    note("annotation", [[ANNOTATES, "host"]]),
    // A part of a host in the bin and of one out of it is a part.
    note("both", [
      ["comments-on", "binned"],
      ["attached-to", "host"],
    ]),
    // An edge of a type that does not keep its source with its hosts.
    note("mention", [["references", "host"]]),
    note("plain"),
    note("binned-part", [["comments-on", "host"]], {
      state: "trashed",
      trashed_at: "2026-09-18T00:00:00.000Z",
    }),
  ],
};

const PARTS = ["annotation", "both", "comment", "on-shelved", "on-unheld"];
const OTHERS = [
  "binned",
  "binned-part",
  "host",
  "mention",
  "on-binned",
  "plain",
  "shelved",
];

/** What the log holds after the hydration's head, which a catch-up reads. */
let log: SseFrame[] = [];

async function hydrated(
  name: string,
  options: { view?: Record<string, unknown> } = {},
): Promise<Harness> {
  log = [];
  harness = await startHarness(name);
  const head = () => String(10 + log.length);
  scriptHydration(harness.server, {
    head,
    replay: () => copyReplay(head(), log),
    rows: {
      ...ROWS,
      ...(options.view
        ? {
            "system.view": [
              {
                item: {
                  id: VIEW,
                  type: "system.view",
                  properties: { title: "Parts", ...options.view },
                },
              },
            ],
          }
        : {}),
    },
    catalog: typeCatalog([
      { id: "system.view", version: 0, fields: {} },
      { id: "core.task", version: 0, fields: {} },
    ]),
    edgeTypes: edgeTypeCatalog([
      edgeType(ANNOTATES, { cascade_on_delete: "with-hosts" }),
    ]),
  });
  const slice = [
    "core.task",
    "core.note",
    ...(options.view ? ["system.view"] : []),
  ];
  const hydration = await harness.device.hydrate(slice, "all");
  expect(hydration.ok, JSON.stringify(hydration)).toBe(true);
  return harness;
}

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

/** A read the server never sees: the requests stay where they were. */
async function offline<T>(
  started: Harness,
  read: () => Promise<T>,
): Promise<T> {
  await started.server.offline();
  const before = started.server.requests.length;
  try {
    return await read();
  } finally {
    await started.server.online();
    expect(
      started.server.requests.length,
      "the local read went to the server",
    ).toBe(before);
  }
}

async function ids(device: DeviceUnderTest, filter: string): Promise<string[]> {
  const listed = value(await device.list({ filter, allStates: true }));
  return listed.map((item) => item.id).sort();
}

describe("a working copy answers the part term from what it holds", () => {
  it("selects items with a host out of the bin, counting a host it does not hold as out of it", async () => {
    const started = await hydrated("parts-filter");
    const { device } = started;
    expect(await offline(started, () => ids(device, "part eq true"))).toEqual(
      PARTS,
    );
    expect(await offline(started, () => ids(device, "part neq false"))).toEqual(
      PARTS,
    );
    expect(await offline(started, () => ids(device, "part eq false"))).toEqual(
      OTHERS,
    );
    expect(await offline(started, () => ids(device, "part neq true"))).toEqual(
      OTHERS,
    );

    // The witness: back out of the bin, its host makes the item a part.
    log = [
      copyItemEvent(
        "11",
        "item.restored",
        wireItem({
          id: "binned",
          type: "core.task",
          version: 2,
          properties: { title: "Binned" },
        }),
      ),
    ];
    value(await device.catchUp());
    expect(await offline(started, () => ids(device, "part eq true"))).toEqual(
      [...PARTS, "on-binned"].sort(),
    );
  });

  it("takes only eq and neq with true or false, as the server does", async () => {
    const started = await hydrated("parts-refused");
    const refused = async (filter: string) => {
      const answer = await offline(started, () =>
        started.device.list({ filter }),
      );
      expect(answer.ok, filter).toBe(false);
      if (answer.ok) return "";
      const error = (
        JSON.parse(answer.refusal.raw) as {
          error: {
            code: string;
            message: string;
            server: { code: string | null } | null;
          };
        }
      ).error;
      expect([error.code, error.server?.code], filter).toEqual([
        "validation",
        "validation_error",
      ]);
      return error.message;
    };
    expect(await refused("part exists")).toContain(
      'Operator "exists" is not valid for "part". Use: eq, neq, with true or false',
    );
    expect(await refused('part eq "true"')).toContain(
      '"part" compares with true or false, not "true", at position 8',
    );
    expect(await refused("part neq null")).toContain(
      'Compare "part" with true or false',
    );
    expect(await refused("parts eq true")).toContain(
      '"part" for the parts of other items',
    );
  });

  it("lists and counts a saved view of parts offline", async () => {
    const started = await hydrated("parts-view", {
      view: {
        query: { types: ["core.note"], filter: "part eq true" },
        sort: [{ by: "created_at", direction: "asc" }],
      },
    });
    const listed = await offline(started, async () => {
      const answer = value(
        await started.device.attempt(["items", "list", "--view", VIEW]),
      ) as { completeness: string; items: Item[] };
      expect(answer.completeness).toBe("complete");
      return answer.items.map((item) => item.id).sort();
    });
    // The view asks for active notes, so the part on an archived host is
    // listed and the archived host is not.
    expect(listed).toEqual(PARTS);
    const counted = await offline(started, async () => {
      const answer = value(
        await started.device.attempt(["views", "groups", VIEW]),
      ) as { completeness: string; groups: Array<{ count: number }> };
      expect(answer.completeness).toBe("complete");
      return answer.groups;
    });
    expect(counted).toEqual([{ key: null, count: PARTS.length }]);
  });
});

describe("a working copy applies no part rule on a delete", () => {
  it("leaves a host's parts as they are on an offline delete, and bins them when the server's events arrive", async () => {
    const started = await hydrated("parts-delete");
    const { device, server } = started;
    await server.offline();
    try {
      value(await device.deleteItem("host"));
      const held = new Map(
        value(await device.list({ allStates: true })).map((item) => [
          item.id,
          item.state,
        ]),
      );
      expect(held.get("host")).toBe("trashed");
      expect(
        ["comment", "annotation", "both"].map((id) => held.get(id)),
        "the copy binned a part on its own delete",
      ).toEqual(["active", "active", "active"]);
      // With their hosts in the bin, they are no longer parts.
      expect(await ids(device, "part eq true")).toEqual([
        "on-shelved",
        "on-unheld",
      ]);
    } finally {
      await server.online();
    }

    server.answer("DELETE", "/items/host", {
      kind: "json",
      status: 200,
      body: { ok: true },
    });
    // The device reads the row its delete binned back from the server.
    server.copyAnswer(
      "GET",
      "/items/host",
      answers.updated(
        wireItem({
          id: "host",
          type: "core.task",
          version: 2,
          state: "trashed",
          trashed_at: "2026-09-18T01:00:00.000Z",
          properties: { title: "Host" },
        }),
      ),
    );
    value(await device.drain());
    expect(
      server.requests.filter((request) => request.method === "DELETE").length,
    ).toBe(1);

    // The server's delete took the parts it left with no host out of the
    // bin.
    const binned = (id: string, at: string) =>
      copyItemEvent(
        at,
        "item.deleted",
        wireItem({
          id,
          version: 2,
          state: "trashed",
          trashed_at: "2026-09-18T01:00:00.000Z",
          properties: { body: `body of ${id}` },
        }),
      );
    log = [
      copyItemEvent(
        "11",
        "item.deleted",
        wireItem({
          id: "host",
          type: "core.task",
          version: 2,
          state: "trashed",
          trashed_at: "2026-09-18T01:00:00.000Z",
          properties: { title: "Host" },
        }),
      ),
      binned("comment", "12"),
      binned("annotation", "13"),
      binned("both", "14"),
    ];
    value(await device.catchUp());
    const after = new Map(
      value(await device.list({ allStates: true })).map((item) => [
        item.id,
        item.state,
      ]),
    );
    expect(
      ["comment", "annotation", "both", "on-shelved"].map((id) =>
        after.get(id),
      ),
    ).toEqual(["trashed", "trashed", "trashed", "active"]);
  });
});
