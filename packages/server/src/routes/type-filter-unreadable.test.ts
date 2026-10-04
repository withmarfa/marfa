/**
 * A `type` filter that names a registered type the credential may not read is
 * refused `403 type_not_permitted` on every door that takes one, and a
 * pattern answers only the types it matches that the credential may read.
 *
 * The door used to decide. `GET /search` refused, and `GET /items`,
 * `/items/stats`, `/export`, `/occurrences` and `/events` answered an empty
 * page or a stream with nothing in it, so one question had two answers
 * depending on where it was asked, and the empty one said "nothing here" about
 * a type that is plainly registered. The registries do not narrow: an
 * unregistered type is already told from a registered one, so the refusal
 * discloses nothing a `GET /types` does not.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
/** Reads `acme.*` except `acme.secret`; reads nothing under `core`. */
let acmeKey: string;
/** Reads `core.event` and `core.task` only, so `core.*` matches part of its reach. */
let eventKey: string;
let acmeId: string;
let secretId: string;
let noteId: string;
let eventId: string;
/** Reads and writes `core.entity.person` and nothing else. */
let personKey: string;
let personId: string;
let placeId: string;

const WINDOW = "from=2026-03-01T00:00:00Z&to=2026-03-08T00:00:00Z";

beforeAll(async () => {
  ctx = await createTestContext();
  for (const id of ["acme.thing", "acme.secret"]) {
    const registered = await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: { id, version: 1, fields: { name: { type: "string" } } },
    });
    expect(registered.status).toBe(201);
  }
  const create = async (
    type: string,
    properties: Record<string, unknown>,
  ): Promise<string> => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type, properties },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { item: { id: string } }).item.id;
  };
  acmeId = await create("acme.thing", { name: "unreadable-filter-acme" });
  secretId = await create("acme.secret", { name: "unreadable-filter-secret" });
  noteId = await create("core.note", {
    title: "unreadable-filter-note",
    body: "unreadable-filter-note",
  });
  eventId = await create("core.event", {
    title: "unreadable-filter-event",
    starts_at: "2026-03-03T09:00:00.000Z",
    ends_at: "2026-03-03T10:00:00.000Z",
  });

  personId = await create("core.entity.person", {
    name: "unreadable-filter-person",
  });
  placeId = await create("core.entity.place", {
    name: "unreadable-filter-place",
  });

  const suffix = Math.random().toString(36).slice(2, 10);
  const narrow = {
    edge_permissions: {},
    metadata_permissions: {},
    extension_permissions: {},
    profile_permissions: {},
  };
  acmeKey = await mintWorkingKey(ctx, {
    label: `acme-${suffix}`,
    source: `acme-${suffix}`,
    type_permissions: { "acme.*": "write", "acme.secret": "none" },
    ...narrow,
  });
  personKey = await mintWorkingKey(ctx, {
    label: `person-${suffix}`,
    source: `person-${suffix}`,
    type_permissions: { "core.entity.person": "write" },
    ...narrow,
  });
  eventKey = await mintWorkingKey(ctx, {
    label: `event-${suffix}`,
    source: `event-${suffix}`,
    type_permissions: { "core.event": "read", "core.task": "read" },
    ...narrow,
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

interface Answer {
  status: number;
  code: string | undefined;
  grant: { kind?: string; name?: string; level?: string } | undefined;
  ids: string[];
}

/** Reads a door's answer down to its status, refusal and the item ids it holds. */
async function answer(res: Response): Promise<Answer> {
  const text = await res.text();
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    const ids = [...text.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]!);
    return { status: res.status, code: undefined, grant: undefined, ids };
  }
  if (res.headers.get("content-type")?.includes("ndjson")) {
    const ids = text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { id?: string; item?: { id: string } })
      .map((r) => r.id ?? r.item?.id)
      .filter((id): id is string => typeof id === "string");
    return { status: res.status, code: undefined, grant: undefined, ids };
  }
  const body = JSON.parse(text) as {
    error?: { code?: string; details?: { grant?: Answer["grant"] } };
    data?: { id?: string; item?: { id: string } }[];
    ids?: string[];
  };
  const rows = (body.data ?? [])
    .map((r) => r.id ?? r.item?.id)
    .filter((id): id is string => typeof id === "string");
  return {
    status: res.status,
    code: body.error?.code,
    grant: body.error?.details?.grant,
    ids: body.ids ?? rows,
  };
}

/**
 * Every door that takes a `type` filter, asked for one type. `GET /events` is
 * the stream: a refusal is a plain response before the first frame, so the
 * test reads the headers and closes the stream.
 */
const DOORS: {
  name: string;
  ask: (type: string, key: string) => Promise<Response>;
}[] = [
  {
    name: "GET /items",
    ask: (t, key) => request(ctx.app, "GET", `/items?type=${t}`, { key }),
  },
  {
    name: "GET /items/stats",
    ask: (t, key) => request(ctx.app, "GET", `/items/stats?type=${t}`, { key }),
  },
  {
    name: "GET /export",
    ask: (t, key) => request(ctx.app, "GET", `/export?type=${t}`, { key }),
  },
  {
    name: "GET /search",
    ask: (t, key) =>
      request(ctx.app, "GET", `/search?q=unreadable-filter&type=${t}`, {
        key,
      }),
  },
  {
    name: "GET /occurrences",
    ask: (t, key) =>
      request(ctx.app, "GET", `/occurrences?${WINDOW}&type=${t}`, { key }),
  },
  {
    name: "GET /events",
    ask: async (t, key) => {
      const res = await request(ctx.app, "GET", `/events?type=${t}`, { key });
      if (res.status === 200) {
        // A stream never ends on its own; the status is all this reads.
        await res.body?.cancel();
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return res;
    },
  },
  {
    name: "POST /items/bulk-actions",
    ask: (t, key) =>
      request(ctx.app, "POST", "/items/bulk-actions", {
        key,
        body: {
          action: "transition",
          state: "archived",
          filter: { type: t },
          dry_run: true,
        },
      }),
  },
];

describe("a registered type the credential may not read is refused on every door", () => {
  for (const door of DOORS) {
    it(`${door.name} answers 403 type_not_permitted, naming the type`, async () => {
      // `core.note` is registered and holds a row, and `acme.secret` is read
      // as `none` inside a namespace the key otherwise reads.
      for (const type of ["core.note", "acme.secret"]) {
        const got = await answer(await door.ask(type, acmeKey));
        expect(got.status, `${door.name} ${type}`).toBe(403);
        expect(got.code).toBe("type_not_permitted");
        expect(got.grant?.kind).toBe("type");
        expect(got.grant?.name).toBe(type);
      }
    });
  }

  it("the witness: the working key reads the same type on the same doors", async () => {
    // Without it, a refusal could be the door's own and not the credential's.
    for (const door of DOORS.filter((d) => !d.name.includes("bulk"))) {
      const got = await answer(await door.ask("core.note", ctx.workingKey));
      expect(got.status, door.name).toBe(200);
    }
    const listed = await answer(
      await DOORS[0]!.ask("core.note", ctx.workingKey),
    );
    expect(listed.ids).toContain(noteId);
  });
});

describe("the bulk action asks about reading, not writing", () => {
  it("narrows a type the key reads and does not write to nothing, rather than refusing it", async () => {
    // `core.event` is read-only to this key. The action would write nothing
    // to it, which `bulk-actions` already answers as a match set of nothing.
    const body = {
      action: "transition",
      state: "archived",
      filter: { type: "core.event" },
      dry_run: true,
    };
    const narrowed = await answer(
      await request(ctx.app, "POST", "/items/bulk-actions", {
        key: eventKey,
        body,
      }),
    );
    expect(narrowed.status).toBe(200);
    expect(narrowed.ids).toEqual([]);
    // The witness: a key that writes the type matches the row.
    const writer = await answer(
      await request(ctx.app, "POST", "/items/bulk-actions", {
        key: ctx.workingKey,
        body,
      }),
    );
    expect(writer.status).toBe(200);
    expect(writer.ids).toContain(eventId);
  });
});

describe("a type nothing registered is still refused as unknown", () => {
  for (const door of DOORS.filter((d) => !d.name.includes("bulk"))) {
    it(`${door.name} answers 400 unknown_type, whatever the key reads`, async () => {
      for (const key of [acmeKey, ctx.workingKey]) {
        const got = await answer(await door.ask("nope.thing", key));
        expect(got.status, door.name).toBe(400);
        expect(got.code).toBe("unknown_type");
      }
    });
  }

  it("POST /items/bulk-actions keeps accepting one, so rows a force-removed type kept can still be reached", async () => {
    // The door takes no pattern, so the type's own name is the only way to
    // select the rows left behind when it was removed.
    const got = await answer(
      await DOORS[6]!.ask("acme.never_registered", acmeKey),
    );
    expect(got.status).toBe(200);
    expect(got.ids).toEqual([]);
  });

  it("POST /items/bulk-actions refuses an unregistered type the key holds nothing on", async () => {
    // Registration is not asked, the grant is: the same key is refused a name
    // it holds nothing on, registered or not.
    const got = await answer(await DOORS[6]!.ask("nope.thing", acmeKey));
    expect(got.status).toBe(403);
    expect(got.code).toBe("type_not_permitted");
  });
});

describe("a pattern answers the readable types it matches", () => {
  it("GET /items lists acme rows the key reads and leaves out the one it does not", async () => {
    const got = await answer(await DOORS[0]!.ask("acme.*", acmeKey));
    expect(got.status).toBe(200);
    expect(got.ids).toContain(acmeId);
    expect(got.ids).not.toContain(secretId);
    // The witness: the working key sees the row the narrowed key does not.
    const all = await answer(await DOORS[0]!.ask("acme.*", ctx.workingKey));
    expect(all.ids).toContain(secretId);
  });

  it("GET /export and GET /search narrow the same way", async () => {
    const exported = await answer(await DOORS[2]!.ask("acme.*", acmeKey));
    expect(exported.status).toBe(200);
    expect(exported.ids).toContain(acmeId);
    expect(exported.ids).not.toContain(secretId);
    const found = await answer(await DOORS[3]!.ask("acme.*", acmeKey));
    expect(found.status).toBe(200);
    expect(found.ids).toContain(acmeId);
    expect(found.ids).not.toContain(secretId);
  });

  it("GET /items/stats counts only the readable rows", async () => {
    const res = await DOORS[1]!.ask("acme.*", acmeKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    const mine = Object.values(body).reduce((s, n) => s + n, 0);
    const all = (await (
      await DOORS[1]!.ask("acme.*", ctx.workingKey)
    ).json()) as Record<string, number>;
    expect(mine).toBe(1);
    expect(Object.values(all).reduce((s, n) => s + n, 0)).toBe(2);
  });

  it("a pattern over types the key reads none of answers an empty page, on every door", async () => {
    for (const door of DOORS.filter((d) => !d.name.includes("bulk"))) {
      const got = await answer(await door.ask("core.*", acmeKey));
      expect(got.status, door.name).toBe(200);
      expect(got.ids, door.name).toEqual([]);
    }
  });

  it("a pattern wider than the key's grant returns what it reads, not a refusal", async () => {
    // `core.*` covers `core.note`, which this key may not read, and
    // `core.event`, which it may. Search refused this while the listing
    // answered it.
    for (const door of [DOORS[0]!, DOORS[2]!]) {
      const got = await answer(await door.ask("core.*", eventKey));
      expect(got.status, door.name).toBe(200);
      expect(got.ids, door.name).toContain(eventId);
      expect(got.ids, door.name).not.toContain(noteId);
    }
    const found = await answer(
      await request(ctx.app, "GET", "/search?q=unreadable-filter&type=core.*", {
        key: eventKey,
      }),
    );
    expect(found.status).toBe(200);
    expect(found.ids).toContain(eventId);
    expect(found.ids).not.toContain(noteId);
  });

  it("GET /occurrences reads a pattern as a pattern", async () => {
    const got = await answer(await DOORS[4]!.ask("core.*", eventKey));
    expect(got.status).toBe(200);
    expect(got.ids).toContain(eventId);
    const refused = await answer(await DOORS[4]!.ask("core.note", eventKey));
    expect(refused.status).toBe(403);
  });

  it("GET /events takes a list of patterns and concrete types, each held to the rule", async () => {
    const open = await DOORS[5]!.ask("acme.*,core.*", acmeKey);
    expect(open.status).toBe(200);
    const refused = await answer(
      await DOORS[5]!.ask("acme.*,core.note", acmeKey),
    );
    expect(refused.status).toBe(403);
    expect(refused.code).toBe("type_not_permitted");
    const unknown = await answer(
      await DOORS[5]!.ask("acme.*,nope.thing", acmeKey),
    );
    expect(unknown.status).toBe(400);
    expect(unknown.code).toBe("unknown_type");
  });
});

describe("a concrete type selects its descendants, so one is refused only when nothing under it is readable", () => {
  // `core.entity` is registered and the key may not read it, but it reads
  // `core.entity.person`, which a filter on `core.entity` selects.
  it("answers the readable descendants on every door", async () => {
    for (const door of [DOORS[0]!, DOORS[2]!, DOORS[3]!]) {
      const got = await answer(await door.ask("core.entity", personKey));
      expect(got.status, door.name).toBe(200);
      expect(got.ids, door.name).toContain(personId);
      expect(got.ids, door.name).not.toContain(placeId);
    }
    const stats = await DOORS[1]!.ask("core.entity", personKey);
    expect(stats.status).toBe(200);
    expect((await stats.json()) as Record<string, number>).toEqual({
      active: 1,
    });
    const stream = await DOORS[5]!.ask("core.entity", personKey);
    expect(stream.status).toBe(200);
    const bulk = await answer(await DOORS[6]!.ask("core.entity", personKey));
    expect(bulk.status).toBe(200);
    expect(bulk.ids).toContain(personId);
    expect(bulk.ids).not.toContain(placeId);
  });

  it("refuses the same type to a key that reads nothing under it", async () => {
    for (const door of DOORS) {
      const got = await answer(await door.ask("core.entity", acmeKey));
      expect(got.status, door.name).toBe(403);
      expect(got.code, door.name).toBe("type_not_permitted");
    }
  });
});

describe("POST /items/lookup refuses a type the key may not read", () => {
  const lookup = (key: string, type: string, id: string) =>
    request(ctx.app, "POST", "/items/lookup", {
      key,
      body: { type, ids: [id] },
    });

  it("answers 403 where it used to answer an empty 200", async () => {
    const got = await answer(await lookup(acmeKey, "core.note", noteId));
    expect(got.status).toBe(403);
    expect(got.code).toBe("type_not_permitted");
    expect(got.grant?.name).toBe("core.note");
    // The witness: a key that reads the type is answered the row.
    const read = await lookup(ctx.workingKey, "core.note", noteId);
    expect(read.status).toBe(200);
    expect(JSON.stringify(await read.json())).toContain(noteId);
  });

  it("still answers 400 for a type nothing registers", async () => {
    const got = await answer(await lookup(acmeKey, "nope.thing", noteId));
    expect(got.status).toBe(400);
    expect(got.code).toBe("unknown_type");
  });
});

describe("the registries stay full", () => {
  it("GET /types, GET /types/{id} and GET /edge-types answer a key that reads one namespace in full", async () => {
    const list = await request(ctx.app, "GET", "/types", { key: acmeKey });
    expect(list.status).toBe(200);
    const listed = ((await list.json()) as { data: { id: string }[] }).data.map(
      (t) => t.id,
    );
    expect(listed).toEqual(
      expect.arrayContaining(["core.note", "core.event", "acme.secret"]),
    );
    const one = await request(ctx.app, "GET", "/types/core.note", {
      key: acmeKey,
    });
    expect(one.status).toBe(200);
    const edgeTypes = await request(ctx.app, "GET", "/edge-types", {
      key: acmeKey,
    });
    expect(edgeTypes.status).toBe(200);
    expect(
      ((await edgeTypes.json()) as { data: unknown[] }).data.length,
    ).toBeGreaterThan(0);
  });
});
