import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import {
  createEvent,
  createNote,
  createPerson,
  createPlace,
  createTask,
} from "../../generators/items.js";
import type { MarfaClient } from "../../client/api.js";
import { collectUntil, withStream } from "../../utils/stream.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

/** Reads tasks and events and holds nothing on notes or anything else. */
let key: string;
let noteId: string;
let taskId: string;
let eventId: string;
/** Reads and writes `core.entity.person` and nothing else. */
let personKey: string;
let personId: string;
let placeId: string;

/** A registered type this key may not read, and one nothing registers. */
const UNREADABLE = "core.note";
const UNREGISTERED = "core.unreadable_filter_nothing_registers_this";
const WINDOW = "from=2031-06-10T00:00:00.000Z&to=2031-06-11T00:00:00.000Z";

interface Seen {
  status: number;
  code: string | undefined;
  grant: { kind?: string; name?: string; level?: string } | undefined;
  /** The ids of the items the answer holds, from a page or an export. */
  ids: string[];
  /** The types of those items. */
  types: string[];
}

async function ask(
  as: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Seen> {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${as}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return read(
    res.status,
    res.headers.get("content-type") ?? "",
    await res.text(),
  );
}

function read(status: number, contentType: string, text: string): Seen {
  type Row = {
    id?: string;
    type?: string;
    item?: { id: string; type: string };
  };
  const pick = (rows: Row[]): { ids: string[]; types: string[] } => ({
    ids: rows.flatMap((r) => r.id ?? r.item?.id ?? []),
    types: rows.flatMap((r) => r.type ?? r.item?.type ?? []),
  });
  if (contentType.includes("ndjson")) {
    const rows = text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Row);
    return { status, code: undefined, grant: undefined, ...pick(rows) };
  }
  const body = JSON.parse(text) as {
    error?: { code?: string; details?: { grant?: Seen["grant"] } };
    data?: Row[];
    ids?: string[];
  };
  const { ids, types } = pick(body.data ?? []);
  return {
    status,
    code: body.error?.code,
    grant: body.error?.details?.grant,
    ids: body.ids ?? ids,
    types,
  };
}

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "unreadable-type-filter",
  ));
  const minted = await client.createKey({
    label: "unreadable-type-filter",
    source: `${ctx.source}-unreadable-type-filter`,
    type_permissions: { "core.task": "write", "core.event": "read" },
    edge_permissions: {},
    extension_permissions: {},
  });
  expect(minted.ok).toBe(true);
  trackKey(ctx, minted.data.id);
  key = minted.data.key;
  const personMinted = await client.createKey({
    label: "unreadable-type-filter-person",
    source: `${ctx.source}-unreadable-type-filter-person`,
    type_permissions: { "core.entity.person": "write" },
    edge_permissions: {},
    extension_permissions: {},
  });
  expect(personMinted.ok).toBe(true);
  trackKey(ctx, personMinted.data.id);
  personKey = personMinted.data.key;

  const seed = async (input: Parameters<MarfaClient["createItem"]>[0]) => {
    const r = await client.createItem({ ...input, source: ctx.source });
    expect(r.status).toBe(201);
    trackItem(ctx, r.data.item.id);
    return r.data.item.id;
  };
  noteId = await seed(
    createNote({
      properties: {
        title: `unreadable-filter-${ctx.runId}`,
        body: `unreadable-filter-${ctx.runId}`,
      },
    }),
  );
  taskId = await seed(
    createTask({
      properties: {
        title: `unreadable-filter-${ctx.runId}`,
        status: "pending",
        priority: "medium",
      },
    }),
  );
  personId = await seed(
    createPerson({
      properties: { name: `unreadable-filter-${ctx.runId}` },
    }),
  );
  placeId = await seed(
    createPlace({
      properties: { name: `unreadable-filter-${ctx.runId}` },
    }),
  );
  eventId = await seed(
    createEvent({
      properties: {
        title: `unreadable-filter-${ctx.runId}`,
        starts_at: "2031-06-10T10:00:00.000Z",
        ends_at: "2031-06-10T11:00:00.000Z",
      },
    }),
  );
});

afterAll(async () => {
  await cleanup(ctx);
});

/** Every door that takes a `type` filter, asked of one type. */
const DOORS: {
  name: string;
  ask: (type: string, as: string) => Promise<Seen>;
}[] = [
  {
    name: "GET /items",
    ask: (t, as) => ask(as, "GET", `/items?type=${t}&source=${ctx.source}`),
  },
  {
    name: "GET /items/stats",
    ask: (t, as) =>
      ask(as, "GET", `/items/stats?type=${t}&source=${ctx.source}`),
  },
  {
    name: "GET /export",
    ask: (t, as) => ask(as, "GET", `/export?type=${t}&source=${ctx.source}`),
  },
  {
    name: "GET /search",
    ask: (t, as) =>
      ask(as, "GET", `/search?q=unreadable-filter-${ctx.runId}&type=${t}`),
  },
  {
    name: "GET /occurrences",
    ask: (t, as) => ask(as, "GET", `/occurrences?${WINDOW}&type=${t}`),
  },
  {
    name: "GET /events",
    ask: (t, as) =>
      withStream(apiUrl, as, { query: [["type", t]] }, async (stream) => {
        const res = stream.response;
        if (res.status === 200) {
          return {
            status: 200,
            code: undefined,
            grant: undefined,
            ids: [],
            types: [],
          };
        }
        return read(res.status, "application/json", await res.text());
      }),
  },
  {
    name: "POST /items/bulk-actions",
    ask: (t, as) =>
      ask(as, "POST", "/items/bulk-actions", {
        action: "transition",
        state: "archived",
        filter: { type: t },
        dry_run: true,
      }),
  },
];

/** The doors that take a wildcard, and so refuse an unregistered type too. */
const FILTER_DOORS = DOORS.filter((d) => !d.name.startsWith("POST"));

describe("a registered type the key may not read is refused on every door", () => {
  it.each(DOORS)(
    "$name answers 403 type_not_permitted naming the type",
    async (door) => {
      const seen = await door.ask(UNREADABLE, key);
      expect(seen.status).toBe(403);
      expect(seen.code).toBe("type_not_permitted");
      expect(seen.grant).toMatchObject({ kind: "type", name: UNREADABLE });
    },
  );

  it("names the level read in the grant of every refusal", async () => {
    // The level is the one the door asked for: a filter reads, so a key that
    // writes the type is not offered a write grant it does not need.
    for (const door of DOORS) {
      const seen = await door.ask(UNREADABLE, key);
      expect(seen.status, door.name).toBe(403);
      expect(seen.grant, door.name).toMatchObject({
        kind: "type",
        name: UNREADABLE,
        level: "read",
      });
    }
    const lookedUp = await ask(key, "POST", "/items/lookup", {
      type: UNREADABLE,
      ids: [noteId],
    });
    expect(lookedUp.grant).toMatchObject({
      kind: "type",
      name: UNREADABLE,
      level: "read",
    });
  });

  it("the same type is served to a key that reads it, on every door but the bulk action", async () => {
    // The witness that the refusal is the key's and not the door's.
    for (const door of FILTER_DOORS) {
      const seen = await door.ask(UNREADABLE, apiKey);
      expect(seen.status, door.name).toBe(200);
    }
    const listed = await DOORS[0]!.ask(UNREADABLE, apiKey);
    expect(listed.ids).toContain(noteId);
  });
});

describe("the bulk action asks about reading, not writing", () => {
  it("narrows a type the key reads and does not write to nothing, rather than refusing it", async () => {
    const body = {
      action: "transition",
      state: "archived",
      filter: { type: "core.event", source: ctx.source },
      dry_run: true,
    };
    const narrowed = await ask(key, "POST", "/items/bulk-actions", body);
    expect(narrowed.status).toBe(200);
    expect(narrowed.ids).toEqual([]);
    // The witness: the owner's key writes the type and matches the row.
    const writer = await ask(apiKey, "POST", "/items/bulk-actions", body);
    expect(writer.status).toBe(200);
    expect(writer.ids).toContain(eventId);
  });
});

describe("a type nothing registers is refused as unknown", () => {
  it.each(FILTER_DOORS)(
    "$name answers 400 unknown_type, whatever the key reads",
    async (door) => {
      for (const as of [key, apiKey]) {
        const seen = await door.ask(UNREGISTERED, as);
        expect(seen.status).toBe(400);
        expect(seen.code).toBe("unknown_type");
      }
    },
  );

  it("POST /items/bulk-actions does not refuse one, because it takes no wildcard to reach the rows a removed type kept", async () => {
    const seen = await DOORS[6]!.ask(UNREGISTERED, apiKey);
    expect(seen.status).toBe(200);
    expect(seen.ids).toEqual([]);
  });

  it("POST /items/bulk-actions selects the rows a type removed with force left behind, by the type's own name", async () => {
    const removed = `user.removed_${ctx.runId}`;
    const registered = await client.registerType({
      id: removed,
      label: "Removed",
      version: 0,
      fields: {},
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const made = await client.createItem({
      type: removed,
      source: ctx.source,
      properties: {},
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackItem(ctx, made.data.item.id);
    expect((await client.deleteType(removed, true)).status).toBe(200);

    // The listing refuses the name now that nothing registers it, so the
    // bulk action is the one door that still reaches the row by it.
    const listed = await ask(apiKey, "GET", `/items?type=${removed}`);
    expect(listed.status).toBe(400);
    expect(listed.code).toBe("unknown_type");

    const selected = await ask(apiKey, "POST", "/items/bulk-actions", {
      action: "transition",
      state: "archived",
      filter: { type: removed, source: ctx.source },
      dry_run: true,
    });
    expect(selected.status).toBe(200);
    expect(selected.ids).toEqual([made.data.item.id]);
  });

  it("POST /items/bulk-actions refuses an unregistered type the key holds nothing on", async () => {
    const seen = await DOORS[6]!.ask(UNREGISTERED, key);
    expect(seen.status).toBe(403);
    expect(seen.code).toBe("type_not_permitted");
  });
});

describe("a concrete type selects its descendants, so one is refused only when nothing under it is readable", () => {
  // `core.entity` is registered and the key may not read it, but it reads
  // `core.entity.person`, which a filter on `core.entity` selects.
  it("answers the readable descendants on every door", async () => {
    for (const door of [DOORS[0]!, DOORS[2]!, DOORS[3]!, DOORS[6]!]) {
      const seen = await door.ask("core.entity", personKey);
      expect(seen.status, door.name).toBe(200);
      expect(seen.ids, door.name).toContain(personId);
      expect(seen.ids, door.name).not.toContain(placeId);
    }
    for (const door of [DOORS[1]!, DOORS[5]!]) {
      expect((await door.ask("core.entity", personKey)).status).toBe(200);
    }
  });

  it("GET /items/stats counts the readable descendants of a type the key may not read", async () => {
    const counts = async (as: string): Promise<Record<string, number>> => {
      const res = await fetch(
        `${apiUrl}/items/stats?type=core.entity&source=${encodeURIComponent(ctx.source)}&by=type`,
        { headers: { Authorization: `Bearer ${as}` } },
      );
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, number>;
    };
    // The owner counts both descendants, so the one the key counts is the
    // grant narrowing and not a short seed.
    expect(await counts(apiKey)).toEqual({
      "core.entity.person": 1,
      "core.entity.place": 1,
    });
    expect(await counts(personKey)).toEqual({ "core.entity.person": 1 });
  });

  it("GET /occurrences answers the readable subtype of an event type the key may not read", async () => {
    const subtype = `user.sub_event_${ctx.runId}`;
    const registered = await client.registerType({
      id: subtype,
      parent: "core.event",
      label: "Sub event",
      version: 0,
      fields: {},
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const made = await client.createItem({
      type: subtype,
      source: ctx.source,
      properties: {
        title: `unreadable-filter-${ctx.runId}`,
        starts_at: "2031-06-10T12:00:00.000Z",
        ends_at: "2031-06-10T13:00:00.000Z",
      },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackItem(ctx, made.data.item.id);
    const reader = await client.createKey({
      label: "unreadable-type-filter-subtype",
      source: `${ctx.source}-unreadable-type-filter-subtype`,
      type_permissions: { [subtype]: "read" },
      edge_permissions: {},
      extension_permissions: {},
    });
    expect(reader.ok).toBe(true);
    trackKey(ctx, reader.data.id);

    const asked = async (as: string) => {
      const res = await fetch(
        `${apiUrl}/occurrences?${WINDOW}&type=core.event`,
        { headers: { Authorization: `Bearer ${as}` } },
      );
      const body = (await res.json()) as {
        data?: { item?: { id: string } }[];
      };
      return {
        status: res.status,
        ids: (body.data ?? []).map((o) => o.item?.id),
      };
    };
    // The owner is answered both events, so the one the subtype key is
    // answered is the grant narrowing and not a window with one event.
    const owner = await asked(apiKey);
    expect(owner.status).toBe(200);
    expect(owner.ids).toEqual(
      expect.arrayContaining([eventId, made.data.item.id]),
    );
    const narrowed = await asked(reader.data.key);
    expect(narrowed.status).toBe(200);
    expect(narrowed.ids).toContain(made.data.item.id);
    expect(narrowed.ids).not.toContain(eventId);
  });

  it("refuses the same type to a key that reads nothing under it", async () => {
    for (const door of DOORS) {
      const seen = await door.ask("core.entity", key);
      expect(seen.status, door.name).toBe(403);
      expect(seen.code, door.name).toBe("type_not_permitted");
    }
  });
});

describe("a key whose map reaches no type", () => {
  it("a key whose map reaches no type is refused a wildcard too", async () => {
    const minted = await client.createKey({
      label: "unreadable-type-filter-none",
      source: `${ctx.source}-unreadable-type-filter-none`,
      type_permissions: {},
      edge_permissions: {},
      extension_permissions: {},
    });
    expect(minted.ok).toBe(true);
    trackKey(ctx, minted.data.id);
    for (const type of ["core.*", UNREADABLE]) {
      const seen = await ask(minted.data.key, "GET", `/items?type=${type}`);
      expect(seen.status, type).toBe(403);
      expect(seen.code, type).toBe("type_not_permitted");
    }
    // The witness: the key that reads some type is answered the wildcard.
    expect((await ask(key, "GET", "/items?type=core.*")).status).toBe(200);
  });
});

describe("a map that reaches no type is refused on every door that takes a type filter", () => {
  it("answers 403 type_not_permitted whatever the filter names, to a working key and to the operator key", async () => {
    const minted = await client.createKey({
      label: "unreadable-type-filter-every-door",
      source: `${ctx.source}-unreadable-type-filter-every-door`,
      type_permissions: {},
      edge_permissions: {},
      extension_permissions: {},
    });
    expect(minted.ok).toBe(true);
    trackKey(ctx, minted.data.id);
    const operator = process.env.MARFA_OPERATOR_KEY;
    expect(operator, "MARFA_OPERATOR_KEY is required").toBeTruthy();

    // The witness: a key that reads some type is answered the wildcard on
    // each door, and the bulk action the type it reads.
    for (const door of FILTER_DOORS) {
      expect((await door.ask("core.*", key)).status, door.name).toBe(200);
    }
    expect((await DOORS[6]!.ask("core.task", key)).status).toBe(200);
    expect(
      (
        await ask(key, "POST", "/items/lookup", {
          type: "core.task",
          ids: [taskId],
        })
      ).status,
    ).toBe(200);

    for (const as of [minted.data.key, operator ?? ""]) {
      for (const type of ["core.*", UNREADABLE, "core.entity", UNREGISTERED]) {
        for (const door of DOORS) {
          const seen = await door.ask(type, as);
          expect(seen.status, `${door.name} ${type}`).toBe(403);
          expect(seen.code, `${door.name} ${type}`).toBe("type_not_permitted");
        }
        const lookedUp = await ask(as, "POST", "/items/lookup", {
          type,
          ids: [noteId],
        });
        expect(lookedUp.status, `lookup ${type}`).toBe(403);
        expect(lookedUp.code, `lookup ${type}`).toBe("type_not_permitted");
      }
    }
  });
});

describe("POST /items/lookup refuses a type the key may not read", () => {
  const lookup = (as: string, type: string) =>
    ask(as, "POST", "/items/lookup", { type, ids: [noteId] });

  it("answers 403 where it used to answer an empty 200, and 400 for an unregistered type", async () => {
    const refused = await lookup(key, UNREADABLE);
    expect(refused.status).toBe(403);
    expect(refused.code).toBe("type_not_permitted");
    expect(refused.grant).toMatchObject({ kind: "type", name: UNREADABLE });
    const unknown = await lookup(key, UNREGISTERED);
    expect(unknown.status).toBe(400);
    expect(unknown.code).toBe("unknown_type");
    // The witness: a key that reads the type is answered the row.
    const served = await lookup(apiKey, UNREADABLE);
    expect(served.status).toBe(200);
    expect(served.ids).toContain(noteId);
  });

  it("answers 400 for a body it cannot read before it asks whether the key may read the type", async () => {
    const ids501 = Array.from({ length: 501 }, () => noteId);
    const bodies: [string, Record<string, unknown>, string][] = [
      ["no selector", { type: UNREADABLE }, "validation_error"],
      [
        "two selectors",
        {
          type: UNREADABLE,
          ids: [noteId],
          source: ctx.source,
          source_ids: ["x"],
        },
        "validation_error",
      ],
      [
        "source without source_ids",
        { type: UNREADABLE, source: ctx.source },
        "validation_error",
      ],
      [
        "more than 500 values",
        { type: UNREADABLE, ids: ids501 },
        "validation_error",
      ],
      [
        "a malformed id",
        { type: UNREADABLE, ids: ["not-an-id"] },
        "invalid_id",
      ],
    ];
    // The witness: a well-formed body is refused to this key and served to
    // the owner's, so the grant is what the key lacks and each 400 below
    // comes before it.
    const valid = { type: UNREADABLE, ids: [noteId] };
    expect((await ask(key, "POST", "/items/lookup", valid)).status).toBe(403);
    expect((await ask(apiKey, "POST", "/items/lookup", valid)).status).toBe(
      200,
    );
    for (const [name, body, code] of bodies) {
      for (const as of [key, apiKey]) {
        const seen = await ask(as, "POST", "/items/lookup", body);
        expect(seen.status, name).toBe(400);
        expect(seen.code, name).toBe(code);
      }
    }
  });

  it("refuses a wildcard type, which names no one type, to every key", async () => {
    // The witness: the listings take the same wildcard from the same keys.
    for (const as of [key, apiKey]) {
      expect((await ask(as, "GET", "/items?type=core.*")).status).toBe(200);
    }
    for (const type of ["core.*", "*"]) {
      for (const as of [key, apiKey]) {
        const seen = await ask(as, "POST", "/items/lookup", {
          type,
          ids: [taskId],
        });
        expect(seen.status, type).toBe(400);
        expect(seen.code, type).toBe("validation_error");
      }
    }
  });

  it("answers no tombstones to a key that reads only a type under the one named", async () => {
    // A purged `core.entity` row leaves a tombstone under `core.entity`. This
    // key reads `core.entity.person`, which the filter selects, and not
    // `core.entity`, so it is answered and the tombstone is withheld.
    const sourceId = `unreadable-filter-tombstone-${ctx.runId}`;
    const made = await client.createItem({
      type: "core.entity",
      source: ctx.source,
      source_id: sourceId,
      properties: { name: `unreadable-filter-${ctx.runId}` },
    });
    expect(made.status).toBe(201);
    expect((await client.deleteItem(made.data.item.id)).ok).toBe(true);
    expect((await client.purgeItem(made.data.item.id)).ok).toBe(true);
    const body = {
      type: "core.entity",
      source: ctx.source,
      source_ids: [sourceId],
    };

    const owner = await client.lookupItems(body);
    expect(owner.ok, JSON.stringify(owner.error)).toBe(true);
    expect(
      owner.data.tombstones.map((t) => t.key),
      "the owner is not answered the tombstone, so the empty list below says nothing",
    ).toEqual([sourceId]);

    const res = await fetch(`${apiUrl}/items/lookup`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${personKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { tombstones: unknown[] }).tombstones,
    ).toEqual([]);
  });
});

describe("a wildcard answers the types it matches that the key may read", () => {
  it("GET /items, /export and /search leave out what the key may not read", async () => {
    // `core.*` matches notes, tasks and events; the key reads the last two.
    for (const door of [DOORS[0]!, DOORS[2]!, DOORS[3]!]) {
      const seen = await door.ask("core.*", key);
      expect(seen.status, door.name).toBe(200);
      expect(seen.ids, door.name).toContain(taskId);
      expect(seen.ids, door.name).not.toContain(noteId);
      for (const type of seen.types) {
        expect(["core.task", "core.event"], door.name).toContain(type);
      }
    }
    // The witness: the owner's key sees the note under the same wildcard.
    const all = await DOORS[0]!.ask("core.*", apiKey);
    expect(all.ids).toContain(noteId);
  });

  it("GET /items/stats counts only what the key may read", async () => {
    const total = async (as: string): Promise<number> => {
      const res = await fetch(
        `${apiUrl}/items/stats?type=core.*&source=${ctx.source}`,
        { headers: { Authorization: `Bearer ${as}` } },
      );
      expect(res.status).toBe(200);
      const counts = (await res.json()) as Record<string, number>;
      return Object.values(counts).reduce((sum, n) => sum + n, 0);
    };
    // The owner counts the note, the task, the event, the person and the
    // place; the key, the task and the event.
    expect(await total(apiKey)).toBe(5);
    expect(await total(key)).toBe(2);
  });

  it("a wildcard over types the key reads none of is an empty page, not a refusal", async () => {
    for (const door of FILTER_DOORS.filter((d) => d.name !== "GET /events")) {
      const seen = await door.ask("core.entity.*", key);
      expect(seen.status, door.name).toBe(200);
      expect(seen.ids, door.name).toEqual([]);
    }
    const stream = await DOORS[5]!.ask("core.entity.*", key);
    expect(stream.status).toBe(200);
  });

  it("GET /items/stats answers an object with no counts for a wildcard over types the key reads none of", async () => {
    const counts = async (as: string): Promise<Record<string, number>> => {
      const res = await fetch(
        `${apiUrl}/items/stats?type=core.entity.*&source=${encodeURIComponent(ctx.source)}`,
        { headers: { Authorization: `Bearer ${as}` } },
      );
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, number>;
    };
    // The owner counts the person and the place under the same wildcard, so
    // the empty object is the grant's and not an empty source.
    expect(await counts(apiKey)).toEqual({ active: 2 });
    expect(await counts(key)).toEqual({});
  });

  it("GET /occurrences reads a wildcard as a wildcard", async () => {
    const seen = await DOORS[4]!.ask("core.*", key);
    expect(seen.status).toBe(200);
    expect(seen.ids).toContain(eventId);
  });

  it("GET /events streams the readable types a wildcard matches and withholds the rest", async ({
    signal,
  }) => {
    await withStream(
      apiUrl,
      key,
      { query: [["type", "core.*"]] },
      async (stream) => {
        expect(stream.response.status).toBe(200);
        await new Promise((r) => setTimeout(r, 250));
        // The note is written first and the task after it: the stream
        // delivers in order, so the task arriving settles that the note was
        // withheld rather than late.
        const hidden = await client.createItem({
          ...createNote(),
          source: ctx.source,
        });
        expect(hidden.status).toBe(201);
        trackItem(ctx, hidden.data.item.id);
        const shown = await client.createItem({
          ...createTask(),
          source: ctx.source,
        });
        expect(shown.status).toBe(201);
        trackItem(ctx, shown.data.item.id);
        const idOf = (e: { data: unknown }) =>
          (e.data as { item?: { id?: string } })?.item?.id;
        const { events } = await collectUntil(
          stream,
          (seen) => seen.some((e) => idOf(e) === shown.data.item.id),
          "the readable task to reach the stream",
          signal,
        );
        expect(events.some((e) => idOf(e) === hidden.data.item.id)).toBe(false);
      },
    );
  });

  it("GET /events holds each entry of a list to the rule", async () => {
    const refused = await DOORS[5]!.ask("core.*,core.note", key);
    expect(refused.status).toBe(403);
    expect(refused.code).toBe("type_not_permitted");
    const unknown = await DOORS[5]!.ask(`core.*,${UNREGISTERED}`, key);
    expect(unknown.status).toBe(400);
    expect(unknown.code).toBe("unknown_type");
  });
});

describe("the registries are not narrowed", () => {
  it("lists every type and edge type to a key that reads two types", async () => {
    const list = await ask(key, "GET", "/types");
    expect(list.status).toBe(200);
    const asOwner = await ask(apiKey, "GET", "/types");
    expect(new Set(list.ids)).toEqual(new Set(asOwner.ids));
    const names = list.ids;
    expect(names).toEqual(
      expect.arrayContaining([UNREADABLE, "core.entity", "core.bookmark"]),
    );

    const one = await ask(key, "GET", `/types/${UNREADABLE}`);
    expect(one.status).toBe(200);

    const edges = (await (
      await fetch(`${apiUrl}/edge-types`, {
        headers: { Authorization: `Bearer ${key}` },
      })
    ).json()) as { data: { id: string }[] };
    const ownerEdges = (await (
      await fetch(`${apiUrl}/edge-types`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
    ).json()) as { data: { id: string }[] };
    expect(edges.data.map((e) => e.id).sort()).toEqual(
      ownerEdges.data.map((e) => e.id).sort(),
    );
  });
});

describe("the event stream reads a type filter as the listings do", () => {
  it("GET /events streams the readable descendants of a type the key may not read and withholds the rest", async ({
    signal,
  }) => {
    await withStream(
      apiUrl,
      personKey,
      { query: [["type", "core.entity"]] },
      async (stream) => {
        expect(stream.response.status).toBe(200);
        await new Promise((r) => setTimeout(r, 250));
        // The place is written first and the person after it: the stream
        // delivers in order, so the person arriving settles that the place
        // was withheld rather than late.
        const hidden = await client.createItem({
          ...createPlace(),
          source: ctx.source,
        });
        expect(hidden.status).toBe(201);
        trackItem(ctx, hidden.data.item.id);
        const shown = await client.createItem({
          ...createPerson(),
          source: ctx.source,
        });
        expect(shown.status).toBe(201);
        trackItem(ctx, shown.data.item.id);
        const idOf = (e: { data: unknown }) =>
          (e.data as { item?: { id?: string } })?.item?.id;
        const { events } = await collectUntil(
          stream,
          (seen) => seen.some((e) => idOf(e) === shown.data.item.id),
          "the readable person to reach the stream",
          signal,
        );
        expect(events.some((e) => idOf(e) === hidden.data.item.id)).toBe(false);
      },
    );
  });

  it("GET /events carries no frame for a wildcard over types the key reads none of", async ({
    signal,
  }) => {
    // The witness: a key that may read the person is streamed it under the
    // same wildcard, so the person is a frame the stream can carry.
    await withStream(
      apiUrl,
      apiKey,
      { query: [["type", "core.entity.*"]] },
      async (reader) => {
        expect(reader.response.status).toBe(200);
        await new Promise((r) => setTimeout(r, 250));
        const person = await client.createItem({
          ...createPerson(),
          source: ctx.source,
        });
        expect(person.status).toBe(201);
        trackItem(ctx, person.data.item.id);
        await collectUntil(
          reader,
          (seen) =>
            seen.some(
              (e) =>
                (e.data as { item?: { id?: string } })?.item?.id ===
                person.data.item.id,
            ),
          "the person to reach the key that may read it",
          signal,
        );
      },
    );
    await withStream(
      apiUrl,
      key,
      { query: [["type", "core.entity.*,core.task"]] },
      async (stream) => {
        expect(stream.response.status).toBe(200);
        await new Promise((r) => setTimeout(r, 250));
        // The person matches the wildcard and the key may not read it; the
        // task is named outright and the key may. The task is written second
        // and the stream delivers in order, so its arrival settles that the
        // person was withheld rather than late.
        const hidden = await client.createItem({
          ...createPerson(),
          source: ctx.source,
        });
        expect(hidden.status).toBe(201);
        trackItem(ctx, hidden.data.item.id);
        const shown = await client.createItem({
          ...createTask(),
          source: ctx.source,
        });
        expect(shown.status).toBe(201);
        trackItem(ctx, shown.data.item.id);
        const idOf = (e: { data: unknown }) =>
          (e.data as { item?: { id?: string } })?.item?.id;
        const { events } = await collectUntil(
          stream,
          (seen) => seen.some((e) => idOf(e) === shown.data.item.id),
          "the readable task to reach the stream",
          signal,
        );
        expect(events.some((e) => idOf(e) === hidden.data.item.id)).toBe(false);
      },
    );
  });
});
