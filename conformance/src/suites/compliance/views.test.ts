/**
 * The view door: `system.view` is written through `/views` alone, gated on
 * write to `system.view` in the key's type map.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  trackView,
  cleanup,
} from "../../utils/setup.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import type { SseEvent } from "../../utils/sse.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "views",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

interface Refusal {
  error: {
    code: string;
    details?: {
      errors?: { path: string }[];
      field?: string;
      unknown_body_fields?: string[];
    };
  };
  conflicting_fields?: string[];
}

const LIST = [{ id: "main", kind: "list" }];

async function keyWith(
  label: string,
  type_permissions: Record<string, string>,
): Promise<MarfaClient> {
  const r = await client.createKey({
    label,
    source: `${ctx.source}-${label}`,
    type_permissions,
  });
  expect(r.status).toBe(201);
  trackKey(ctx, r.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: r.data.key });
}

async function view(
  settings: Record<string, unknown> = {},
  by: MarfaClient = client,
): Promise<{ id: string; version: number }> {
  const r = await by.createView({
    title: "A view",
    layouts: LIST,
    ...settings,
  });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackView(ctx, r.data.item.id);
  return { id: r.data.item.id, version: r.data.item.version };
}

describe("the view door", () => {
  it("creates a view as a system.view with every layout kind, read back through the item doors", async () => {
    const settings = {
      title: "Reading",
      query: {
        types: ["core.note"],
        tier: "library",
        state: ["active"],
        filter: 'tags contains "reading"',
        beneath: "01920000-0000-7000-8000-000000000000",
      },
      layouts: [
        {
          id: "rows",
          kind: "list",
          title: "Rows",
          sort: [
            { by: "updated_at", direction: "desc" },
            { by: "title", direction: "asc" },
          ],
          shown: ["title", "tags", "properties.status"],
        },
        {
          id: "grid",
          kind: "table",
          group: { by: "edge[parent-of]" },
          shown: ["title", "type", "state", "tier", "created_at"],
        },
        {
          id: "board",
          kind: "board",
          group: {
            by: "properties.status",
            order: ["todo", "doing", null],
            hidden: [false, 3],
          },
        },
        { id: "cards", kind: "gallery", image: "properties.cover" },
        {
          id: "month",
          kind: "calendar",
          date: "occurred_at",
          end: "properties.ends",
          group: { by: "backref[about]" },
        },
        {
          id: "spans",
          kind: "timeline",
          start: "properties.starts",
          end: "properties.ends",
          group: { by: "created_at", bucket: "week" },
        },
        {
          id: "count",
          kind: "chart",
          x: "properties.status",
          y: "count",
          group: { by: "properties.due", bucket: "month" },
        },
        {
          id: "sum",
          kind: "chart",
          x: "type",
          y: { sum: "properties.amount" },
        },
        { id: "places", kind: "map", location: "properties.place" },
      ],
    };
    const r = await client.createView(settings);
    expect(r.status, JSON.stringify(r.error)).toBe(201);
    trackView(ctx, r.data.item.id);
    await expectMatchesSchema("POST", "/views", 201, r.data);
    expect(Object.keys(r.data).sort()).toEqual(["item", "metadata"]);
    const { item } = r.data;
    expect(item.type).toBe("system.view");
    expect(item.state).toBe("active");
    expect(item.version).toBe(1);
    expect(item.properties).toEqual(settings);

    const read = await client.getItem(item.id);
    expect(read.status).toBe(200);
    expect(read.data.item.properties).toEqual(settings);
    const listed = await client.rawRequest<{ data: { id: string }[] }>(
      "/items?type=system.view&limit=200",
    );
    expect(listed.status).toBe(200);
    expect(listed.data.data.map((row) => row.id)).toContain(item.id);
  });

  it("changes a view at its version, merges a stale change to another setting, and refuses one to the same", async () => {
    const { id } = await view({ query: { tier: "feed" } });
    const changed = await client.updateView(id, {
      version: 1,
      title: "Renamed",
    });
    expect(changed.status).toBe(200);
    await expectMatchesSchema("PATCH", "/views/{id}", 200, changed.data);
    expect(changed.data.item.version).toBe(2);

    const layouts = [
      { id: "b", kind: "table", shown: ["title"] },
      { id: "a", kind: "board", group: { by: "state" } },
    ];
    const merged = await client.updateView(id, { version: 1, layouts });
    expect(merged.status, JSON.stringify(merged.error)).toBe(200);
    expect(merged.data.item.properties).toEqual({
      title: "Renamed",
      query: { tier: "feed" },
      layouts,
    });

    const stale = await client.updateView(id, {
      version: 1,
      title: "Lost",
    });
    expect(stale.status).toBe(409);
    await expectMatchesSchema("PATCH", "/views/{id}", 409, stale.error);
    const refusal = stale.error as unknown as Refusal;
    expect(refusal.error.code).toBe("version_conflict");
    expect(refusal.conflicting_fields).toEqual(["title"]);
    const kept = await client.getItem(id);
    expect(kept.data.item.properties.title).toBe("Renamed");
  });

  it("refuses a change naming no version or no setting, and a change or delete of an id that is not a view", async () => {
    const { id } = await view();
    const noVersion = await client.rawRequest(`/views/${id}`, {
      method: "PATCH",
      body: { title: "x" },
    });
    expect(noVersion.status).toBe(400);
    expect(noVersion.error?.error.code).toBe("missing_required_field");
    const noSetting = await client.updateView(id, { version: 1 });
    expect(noSetting.status).toBe(400);
    expect(noSetting.error?.error.code).toBe("validation_error");

    const note = await client.createItem({
      type: "core.note",
      properties: { body: "not a view" },
    });
    expect(note.status).toBe(201);
    trackItem(ctx, note.data.item.id);
    for (const r of [
      await client.updateView(note.data.item.id, { version: 1, title: "x" }),
      await client.deleteView(note.data.item.id),
    ]) {
      expect(r.status).toBe(404);
      expect(r.error?.error.code).toBe("item_not_found");
    }
    expect((await client.getItem(note.data.item.id)).status).toBe(200);
    for (const r of [
      await client.updateView("not-an-id", { version: 1, title: "x" }),
      await client.deleteView("not-an-id"),
    ]) {
      expect(r.status).toBe(400);
      expect(r.error?.error.code).toBe("invalid_id");
    }
    // The witness: the view itself takes the same change.
    expect(
      (await client.updateView(id, { version: 1, title: "x" })).status,
    ).toBe(200);
  });

  it("deletes a view at once, and a deleted view is no longer readable or changed", async () => {
    const { id } = await view();
    // The witness: the view is readable and listed before the delete.
    expect((await client.getItem(id)).status).toBe(200);

    const deleted = await client.deleteView(id);
    expect(deleted.status).toBe(200);
    await expectMatchesSchema("DELETE", "/views/{id}", 200, deleted.data);
    expect(deleted.data).toEqual({ ok: true });

    const read = await client.getItem(id);
    expect(read.status).toBe(404);
    expect(read.error?.error.code).toBe("item_not_found");
    for (const query of [
      "type=system.view",
      "type=system.view&state=trashed",
      "type=system.view&state=revoked",
    ]) {
      const listed = await client.rawRequest<{ data: { id: string }[] }>(
        `/items?${query}&limit=200`,
      );
      expect(listed.status, query).toBe(200);
      expect(
        listed.data.data.map((row) => row.id),
        query,
      ).not.toContain(id);
    }
    for (const r of [
      await client.deleteView(id),
      await client.updateView(id, { version: 1, title: "back" }),
    ]) {
      expect(r.status).toBe(404);
      expect(r.error?.error.code).toBe("item_not_found");
    }
  });

  it("admits a key minted with write on system.view alone, and refuses one whose map does not grant it", async () => {
    // The witness: a key holding exactly the grant passes every door.
    const exact = await keyWith("view-writer", { "system.view": "write" });
    const { id } = await view({}, exact);
    const changed = await exact.updateView(id, {
      version: 1,
      title: "renamed",
    });
    expect(changed.status).toBe(200);
    const read = await exact.getItem(id);
    expect(read.status).toBe(200);
    expect(read.data.item.properties.title).toBe("renamed");
    expect((await exact.deleteView(id)).status).toBe(200);

    const target = await view();
    for (const [label, map] of [
      ["note-writer", { "core.note": "write" }],
      ["view-reader", { "system.view": "read" }],
      ["folder-writer", { "system.folder": "write" }],
      ["everything-but", { "*": "write", "system.view": "read" }],
    ] as const) {
      const narrow = await keyWith(label, map);
      const answers = [
        await narrow.createView({ title: "refused", layouts: LIST }),
        await narrow.updateView(target.id, { version: 1, title: "x" }),
        await narrow.deleteView(target.id),
      ];
      for (const r of answers) {
        expect(r.status, label).toBe(403);
        expect(r.error?.error.code, label).toBe("type_not_permitted");
      }
    }
    const untouched = await client.getItem(target.id);
    expect(untouched.data.item.state).toBe("active");
    expect(untouched.data.item.version).toBe(1);
  });

  it("reads a view through the item doors only with read on system.view", async () => {
    const { id } = await view();
    const reader = await keyWith("reader", { "system.view": "read" });
    expect((await reader.getItem(id)).status).toBe(200);
    const listed = await reader.rawRequest<{ data: { id: string }[] }>(
      "/items?type=system.view&limit=200",
    );
    expect(listed.data.data.map((row) => row.id)).toContain(id);

    const other = await keyWith("other-reader", {
      "*": "read",
      "system.view": "none",
    });
    const refused = await other.getItem(id);
    expect(refused.status).toBe(404);
    expect(refused.error?.error.code).toBe("item_not_found");
    const hidden = await other.rawRequest<{ data: { id: string }[] }>(
      "/items?type=system.view&limit=200",
    );
    expect(hidden.data.data?.map((row) => row.id) ?? []).not.toContain(id);
  });

  it.each([
    [{ layouts: [] }, "validation_error", "layouts"],
    [
      { layouts: [{ id: "", kind: "list" }] },
      "validation_error",
      "layouts.0.id",
    ],
    [
      {
        layouts: [
          { id: "a", kind: "list" },
          { id: "a", kind: "table" },
        ],
      },
      "validation_error",
      "layouts.1.id",
    ],
    [
      { layouts: [{ id: "a", kind: "kanban" }] },
      "validation_error",
      "layouts.0.kind",
    ],
    [
      { layouts: [{ id: "a", kind: "list", image: "properties.cover" }] },
      "validation_error",
      "layouts.0.image",
    ],
    [
      {
        layouts: [
          {
            id: "a",
            kind: "board",
            group: { by: "state" },
            date: "created_at",
          },
        ],
      },
      "validation_error",
      "layouts.0.date",
    ],
    [
      { layouts: [{ id: "a", kind: "calendar", start: "created_at" }] },
      "validation_error",
      "layouts.0.start",
    ],
    [
      { layouts: [{ id: "a", kind: "map", x: "title" }] },
      "validation_error",
      "layouts.0.x",
    ],
    [
      {
        layouts: [
          { id: "a", kind: "list", sort: [{ by: "body", direction: "asc" }] },
        ],
      },
      "validation_error",
      "layouts.0.sort.0.by",
    ],
    [
      {
        layouts: [{ id: "a", kind: "table", shown: ["title", "properties."] }],
      },
      "validation_error",
      "layouts.0.shown.1",
    ],
    [
      { layouts: [{ id: "a", kind: "list", group: { by: "owner" } }] },
      "validation_error",
      "layouts.0.group.by",
    ],
    [
      {
        layouts: [
          { id: "a", kind: "list", group: { by: "edge[no-such-edge]" } },
        ],
      },
      "validation_error",
      "layouts.0.group.by",
    ],
    [
      {
        layouts: [
          { id: "a", kind: "list", group: { by: "title", bucket: "month" } },
        ],
      },
      "validation_error",
      "layouts.0.group.bucket",
    ],
    [
      {
        layouts: [
          {
            id: "a",
            kind: "list",
            group: { by: "edge[about]", bucket: "day" },
          },
        ],
      },
      "validation_error",
      "layouts.0.group.bucket",
    ],
    [
      { layouts: [{ id: "a", kind: "gallery", image: "title" }] },
      "validation_error",
      "layouts.0.image",
    ],
    [
      {
        layouts: [
          { id: "a", kind: "timeline", start: "title", end: "updated_at" },
        ],
      },
      "validation_error",
      "layouts.0.start",
    ],
    [{ query: { filter: "tags eq" } }, "validation_error", "query.filter"],
    [
      { query: { types: ["core.no-such-type"] } },
      "unknown_type",
      "query.types.0",
    ],
    [{ query: { types: ["Not A Type"] } }, "validation_error", "query.types.0"],
    [
      { query: { types: ["system.view"] } },
      "validation_error",
      "query.types.0",
    ],
    [{ query: { tier: "trash" } }, "validation_error", "query.tier"],
    [{ query: { state: ["trashed"] } }, "validation_error", "query.state.0"],
    [{ query: { beneath: "not-an-id" } }, "validation_error", "query.beneath"],
  ])(
    "refuses a malformed setting %j with %s naming %s, on a create and on a change",
    async (settings, code, path) => {
      const { id } = await view();
      for (const r of [
        await client.createView({
          title: "refused",
          layouts: LIST,
          ...settings,
        }),
        await client.updateView(id, { version: 1, ...settings }),
      ]) {
        expect(r.status).toBe(400);
        const refusal = r.error as unknown as Refusal;
        expect(refusal.error.code).toBe(code);
        expect(refusal.error.details?.errors?.[0]?.path).toBe(path);
      }
      const unchanged = await client.getItem(id);
      expect(unchanged.data.item.version).toBe(1);
    },
  );

  it("takes a chart measuring a number property and refuses one summing a field that is not a property", async () => {
    // The witness: the same layout with a property is taken.
    await view({
      layouts: [{ id: "a", kind: "chart", y: { sum: "properties.amount" } }],
    });
    const r = await client.createView({
      title: "refused",
      layouts: [{ id: "a", kind: "chart", y: { sum: "title" } }],
    });
    expect(r.status).toBe(400);
    const refusal = r.error as unknown as Refusal;
    expect(refusal.error.code).toBe("validation_error");
    expect(refusal.error.details?.errors?.[0]?.path).toMatch(/^layouts\.0\.y/);
  });

  it.each([
    [{ title: undefined }, "title"],
    [{ layouts: undefined }, "layouts"],
    [{ layouts: [{ kind: "list" }] }, "layouts.0.id"],
    [{ layouts: [{ id: "a" }] }, "layouts.0.kind"],
    [{ layouts: [{ id: "a", kind: "board" }] }, "layouts.0.group"],
    [
      { layouts: [{ id: "a", kind: "timeline", start: "created_at" }] },
      "layouts.0.end",
    ],
    [
      { layouts: [{ id: "a", kind: "timeline", end: "created_at" }] },
      "layouts.0.start",
    ],
  ])(
    "refuses a create missing %j with missing_required_field naming %s",
    async (settings, field) => {
      const body: Record<string, unknown> = {
        title: "refused",
        layouts: LIST,
        ...settings,
      };
      for (const [name, value] of Object.entries(body)) {
        if (value === undefined) Reflect.deleteProperty(body, name);
      }
      const r = await client.createView(body);
      expect(r.status).toBe(400);
      const refusal = r.error as unknown as Refusal;
      expect(refusal.error.code).toBe("missing_required_field");
      expect(refusal.error.details?.field).toBe(field);
    },
  );

  it("refuses a key a view setting does not declare, naming its path from the body, on a create and on a change", async () => {
    const { id } = await view();
    const extra = {
      query: { tags: ["x"] },
      layouts: [{ id: "a", kind: "list", color: "red", filter: "x" }],
      owner: "x",
    };
    for (const r of [
      await client.createView({ title: "refused", ...extra }),
      await client.updateView(id, { version: 1, ...extra }),
    ]) {
      expect(r.status).toBe(400);
      const refusal = r.error as unknown as Refusal;
      expect(refusal.error.code).toBe("validation_error");
      expect(
        [...(refusal.error.details?.unknown_body_fields ?? [])].sort(),
      ).toEqual(["layouts.0.color", "layouts.0.filter", "owner", "query.tags"]);
    }
  });

  it("answers a view create repeated under one Idempotency-Key once", async () => {
    const key = `views-${ctx.runId}-${String(Date.now())}`;
    const send = () =>
      client.rawRequest<{ item: { id: string } }>("/views", {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: { title: "once", layouts: LIST },
      });
    const first = await send();
    expect(first.status).toBe(201);
    trackView(ctx, first.data.item.id);
    expect(first.headers.get("Idempotency-Replayed")).toBeNull();
    const repeat = await send();
    expect(repeat.status).toBe(201);
    expect(repeat.headers.get("Idempotency-Replayed")).toBe("true");
    expect(repeat.data.item.id).toBe(first.data.item.id);
  });

  it("refuses 422 a key sent again with another request on each view door", async () => {
    const [a, b, c, d] = [
      await view(),
      await view(),
      await view(),
      await view(),
    ];
    const doors: [string, string, [string, unknown?], [string, unknown?]][] = [
      [
        "POST",
        "/views",
        ["/views", { title: "a", layouts: LIST }],
        ["/views", { title: "b", layouts: LIST }],
      ],
      [
        "PATCH",
        "/views/{id}",
        [`/views/${a.id}`, { version: a.version, title: "a" }],
        [`/views/${b.id}`, { version: b.version, title: "b" }],
      ],
      ["DELETE", "/views/{id}", [`/views/${c.id}`], [`/views/${d.id}`]],
    ];
    for (const [method, template, first, second] of doors) {
      const key = `views-${ctx.runId}-${template}-${String(Date.now())}`;
      const send = ([path, body]: [string, unknown?]) =>
        client.rawRequest<{ item?: { id: string } } & Refusal>(path, {
          method,
          headers: { "Idempotency-Key": key },
          ...(body === undefined ? {} : { body }),
        });
      const accepted = await send(first);
      expect(accepted.status, `${method} ${template}`).toBeLessThan(300);
      if (template === "/views" && accepted.data.item)
        trackView(ctx, accepted.data.item.id);
      const refused = await send(second);
      expect(
        [refused.status, refused.data.error?.code],
        `${method} ${template} served one request's answer to another`,
      ).toEqual([422, "idempotency_key_reused"]);
    }
    // The second delete was refused, so its view is still there.
    expect((await client.getItem(d.id)).status).toBe(200);
  });

  it("publishes a view's create and change as item events, and its delete as item.purged", async ({
    signal,
  }) => {
    await withStream(apiUrl, apiKey, {}, async (stream) => {
      await new Promise((r) => setTimeout(r, 200));
      const { id } = await view();
      expect((await client.updateView(id, { version: 1, title: "b" })).ok).toBe(
        true,
      );
      expect((await client.deleteView(id)).ok).toBe(true);
      const ours = (e: SseEvent, name: string): boolean =>
        e.event === name &&
        (e.data as { item?: { id?: string } }).item?.id === id;
      const names = ["item.created", "item.updated", "item.purged"];
      const { events } = await collectUntil(
        stream,
        (evts) => names.every((n) => evts.some((e) => ours(e, n))),
        `item.created, item.updated and item.purged for ${id}`,
        signal,
      );
      const updated = events.find((e) => ours(e, "item.updated"));
      expect(
        (updated?.data as { item?: { properties?: { title?: string } } }).item
          ?.properties?.title,
      ).toBe("b");
      // The delete passes through no state a working copy keeps.
      for (const name of ["item.deleted", "item.state_changed"]) {
        expect(
          events.some((e) => ours(e, name)),
          `${name} for a deleted view`,
        ).toBe(false);
      }
    });
  });
});
