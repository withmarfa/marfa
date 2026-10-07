/**
 * The folder door: `system.folder` is written through `/folders` alone,
 * gated on write to `system.folder` in the key's type map.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackFolder,
  trackItem,
  trackKey,
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
    "folders",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

interface Refusal {
  error: {
    code: string;
    details?: { errors?: { path: string }[] };
  };
  conflicting_fields?: string[];
}

async function keyWith(
  label: string,
  type_permissions: Record<string, string>,
): Promise<{ client: MarfaClient; key: string }> {
  const r = await client.createKey({
    label,
    source: `${ctx.source}-${label}`,
    type_permissions,
  });
  expect(r.status).toBe(201);
  trackKey(ctx, r.data.id);
  return {
    client: new MarfaClient({ baseUrl: apiUrl, apiKey: r.data.key }),
    key: r.data.key,
  };
}

async function folder(
  settings: Record<string, unknown> = {},
  by: MarfaClient = client,
): Promise<{ id: string; version: number }> {
  const r = await by.createFolder({ title: "A folder", ...settings });
  expect(r.status).toBe(201);
  trackFolder(ctx, r.data.item.id);
  return { id: r.data.item.id, version: r.data.item.version };
}

describe("the folder door", () => {
  it("creates a folder as a system.folder, read back through the item doors", async () => {
    const settings = {
      title: "Project",
      search: {
        types: ["core.note"],
        tier: "library",
        state: ["active", "archived"],
        filter: 'tags contains "project"',
        beneath: "01920000-0000-7000-8000-000000000000",
      },
      defaults: {
        type: "core.note",
        tags: ["project"],
        edges: { "parent-of": ["01920000-0000-7000-8000-000000000000"] },
      },
      include: ["*.md"],
      ignore: ["drafts/"],
      first_placement: { "core.note": "Notes" },
      removal_threshold: { files: 20, fraction: 0.5 },
    };
    const r = await client.createFolder(settings);
    expect(r.status).toBe(201);
    trackFolder(ctx, r.data.item.id);
    await expectMatchesSchema("POST", "/folders", 201, r.data);
    const { item } = r.data;
    expect(item.type).toBe("system.folder");
    expect(item.state).toBe("active");
    expect(item.version).toBe(1);
    expect(item.properties).toEqual(settings);

    const read = await client.getItem(item.id);
    expect(read.status).toBe(200);
    expect(read.data.item.properties).toEqual(settings);
    const listed = await client.rawRequest<{ data: { id: string }[] }>(
      "/items?type=system.folder&limit=200",
    );
    expect(listed.status).toBe(200);
    expect(listed.data.data.map((row) => row.id)).toContain(item.id);
  });

  it("changes a folder at its version, merges a stale change to another setting, and refuses one to the same, and refuses a conflict parameter as undeclared", async () => {
    const { id } = await folder({ include: ["a"] });
    const changed = await client.updateFolder(id, {
      version: 1,
      include: ["b"],
    });
    expect(changed.status).toBe(200);
    await expectMatchesSchema("PATCH", "/folders/{id}", 200, changed.data);
    expect(changed.data.item.version).toBe(2);

    const merged = await client.updateFolder(id, {
      version: 1,
      ignore: ["c"],
    });
    expect(merged.status).toBe(200);
    expect(merged.data.item.properties).toMatchObject({
      include: ["b"],
      ignore: ["c"],
    });

    const stale = await client.updateFolder(id, {
      version: 1,
      include: ["d"],
    });
    expect(stale.status).toBe(409);
    await expectMatchesSchema("PATCH", "/folders/{id}", 409, stale.error);
    const refusal = stale.error as unknown as Refusal;
    expect(refusal.error.code).toBe("version_conflict");
    expect(refusal.conflicting_fields).toEqual(["include"]);

    const asked = await client.rawRequest(`/folders/${id}?conflict=auto`, {
      method: "PATCH",
      body: { version: 1, include: ["d"] },
    });
    expect(asked.status).toBe(400);
    expect(asked.error?.error.code).toBe("validation_error");
    expect(asked.error?.error.details?.["unknown_parameters"]).toEqual([
      "conflict",
    ]);
  });

  it("refuses a change naming no version or no setting, and one to an id that is not a folder", async () => {
    const { id } = await folder();
    const noVersion = await client.rawRequest(`/folders/${id}`, {
      method: "PATCH",
      body: { title: "x" },
    });
    expect(noVersion.status).toBe(400);
    expect(noVersion.error?.error.code).toBe("missing_required_field");
    const noSetting = await client.updateFolder(id, { version: 1 });
    expect(noSetting.status).toBe(400);
    expect(noSetting.error?.error.code).toBe("validation_error");

    const note = await client.createItem({
      type: "core.note",
      properties: { body: "not a folder" },
    });
    expect(note.status).toBe(201);
    trackItem(ctx, note.data.item.id);
    for (const r of [
      await client.updateFolder(note.data.item.id, { version: 1, title: "x" }),
      await client.revokeFolder(note.data.item.id),
    ]) {
      expect(r.status).toBe(404);
      expect(r.error?.error.code).toBe("item_not_found");
    }
    for (const r of [
      await client.updateFolder("not-an-id", { version: 1, title: "x" }),
      await client.revokeFolder("not-an-id"),
    ]) {
      expect(r.status).toBe(400);
      expect(r.error?.error.code).toBe("invalid_id");
    }
    // The witness: the folder itself takes the same change.
    expect(
      (await client.updateFolder(id, { version: 1, title: "x" })).status,
    ).toBe(200);
  });

  it("revokes a folder once, and a revoked folder does not change", async () => {
    const { id } = await folder();
    const revoked = await client.revokeFolder(id);
    expect(revoked.status).toBe(200);
    await expectMatchesSchema(
      "POST",
      "/folders/{id}/revoke",
      200,
      revoked.data,
    );
    expect(revoked.data.item.state).toBe("revoked");
    expect(typeof revoked.data.item.properties.revoked_at).toBe("string");

    const again = await client.revokeFolder(id);
    expect(again.status).toBe(400);
    expect(again.error?.error.code).toBe("invalid_transition");
    const change = await client.updateFolder(id, {
      version: revoked.data.item.version,
      title: "back",
    });
    expect(change.status).toBe(400);
    expect(change.error?.error.code).toBe("invalid_transition");
  });

  it("moves the folder's version by one on a revoke, which writes revoked_at beside the state", async () => {
    const { id, version } = await folder();
    expect(version).toBe(1);

    const revoked = await client.revokeFolder(id);
    expect(revoked.status).toBe(200);
    expect(revoked.data.item.version).toBe(2);
    expect(typeof revoked.data.item.properties.revoked_at).toBe("string");

    const read = await client.getItem(id);
    expect(read.status).toBe(200);
    expect(read.data.item).toMatchObject({ state: "revoked", version: 2 });
    const history = await client.getVersions(id);
    expect(history.status, JSON.stringify(history.error)).toBe(200);
    expect(history.data.data.map((v) => v.version)).toEqual([1]);
    expect(history.data.data[0]?.properties.revoked_at).toBeUndefined();
  });

  it("admits a key minted with write on system.folder alone, and refuses one whose map does not grant it", async () => {
    // The witness: a key holding exactly the grant passes every door.
    const exact = await keyWith("folder-writer", { "system.folder": "write" });
    const { id } = await folder({}, exact.client);
    const changed = await exact.client.updateFolder(id, {
      version: 1,
      title: "renamed",
    });
    expect(changed.status).toBe(200);
    const read = await exact.client.getItem(id);
    expect(read.status).toBe(200);
    expect(read.data.item.properties.title).toBe("renamed");
    const revoked = await exact.client.revokeFolder(id);
    expect(revoked.status).toBe(200);
    expect(revoked.data.item.state).toBe("revoked");

    const target = await folder();
    for (const [label, map] of [
      ["note-writer", { "core.note": "write" }],
      ["folder-reader", { "system.folder": "read" }],
      ["everything-but", { "*": "write", "system.folder": "read" }],
    ] as const) {
      const { client: narrow } = await keyWith(label, map);
      const answers = [
        await narrow.createFolder({ title: "refused" }),
        await narrow.updateFolder(target.id, { version: 1, title: "x" }),
        await narrow.revokeFolder(target.id),
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

  it("reads a folder through the item doors only with read on system.folder", async () => {
    const { id } = await folder();
    const reader = await keyWith("reader", { "system.folder": "read" });
    expect((await reader.client.getItem(id)).status).toBe(200);
    const other = await keyWith("other-reader", { "core.note": "read" });
    const refused = await other.client.getItem(id);
    expect(refused.status).toBe(404);
    expect(refused.error?.error.code).toBe("item_not_found");
  });

  it.each([
    [
      { search: { types: ["core.no-such-type"] } },
      "unknown_type",
      "search.types.0",
    ],
    [
      { search: { types: ["Not A Type"] } },
      "validation_error",
      "search.types.0",
    ],
    [{ search: { filter: "tags eq" } }, "validation_error", "search.filter"],
    [
      { search: { beneath: "not-an-id" } },
      "validation_error",
      "search.beneath",
    ],
    [{ search: { state: ["trashed"] } }, "validation_error", "search.state.0"],
    [{ search: { tags: ["x"] } }, "validation_error", "search"],
    [
      { defaults: { type: "core.no-such-type" } },
      "unknown_type",
      "defaults.type",
    ],
    [{ defaults: { type: "Not A Type" } }, "validation_error", "defaults.type"],
    [
      { defaults: { edges: { "no-such-edge": [] } } },
      "validation_error",
      "defaults.edges.no-such-edge",
    ],
    [
      { defaults: { edges: { about: ["not-an-id"] } } },
      "validation_error",
      "defaults.edges.about",
    ],
    [{ include: [7] }, "validation_error", "include.0"],
    [{ ignore: [""] }, "validation_error", "ignore.0"],
    [
      { first_placement: { "Not A Type": "Notes" } },
      "validation_error",
      "first_placement.Not A Type",
    ],
    [
      { first_placement: { "core.note": "Notes/../../out" } },
      "validation_error",
      "first_placement.core.note",
    ],
    [
      { first_placement: { "core.note": "/Notes" } },
      "validation_error",
      "first_placement.core.note",
    ],
    [
      { first_placement: { "core.note": "C:/Notes" } },
      "validation_error",
      "first_placement.core.note",
    ],
    [
      { first_placement: { "core.note": "Notes\\..\\..\\out" } },
      "validation_error",
      "first_placement.core.note",
    ],
    [
      { first_placement: { "core.note": "Notes\0" } },
      "validation_error",
      "first_placement.core.note",
    ],
    [
      { search: { types: ["system.folder"] } },
      "validation_error",
      "search.types.0",
    ],
    [
      { defaults: { type: "system.folder" } },
      "validation_error",
      "defaults.type",
    ],
    [
      { first_placement: { "system.folder": "Folders" } },
      "validation_error",
      "first_placement.system.folder",
    ],
    [
      { defaults: { edges: { "in-folder": [] } } },
      "validation_error",
      "defaults.edges.in-folder",
    ],
    [
      { removal_threshold: { fraction: 1.5 } },
      "validation_error",
      "removal_threshold.fraction",
    ],
    [
      { removal_threshold: { files: -1 } },
      "validation_error",
      "removal_threshold.files",
    ],
  ])(
    "refuses a malformed setting %j with %s naming %s, on a create and on a change",
    async (settings, code, path) => {
      const { id } = await folder();
      for (const r of [
        await client.createFolder({ title: "refused", ...settings }),
        await client.updateFolder(id, { version: 1, ...settings }),
      ]) {
        expect(r.status).toBe(400);
        const refusal = r.error as unknown as Refusal;
        expect(refusal.error.code).toBe(code);
        expect(refusal.error.details?.errors?.[0]?.path).toBe(path);
      }
    },
  );

  it("caps defaults.edges at 100 edge types and 100 targets for each", async () => {
    const target = "01920000-0000-7000-8000-000000000000";
    const { id } = await folder();
    for (const [edges, path] of [
      [
        Object.fromEntries(
          Array.from({ length: 101 }, (_, i) => [`edge-${String(i)}`, []]),
        ),
        "defaults.edges",
      ],
      [
        { "parent-of": Array.from({ length: 101 }, () => target) },
        "defaults.edges.parent-of",
      ],
    ] as const) {
      for (const r of [
        await client.createFolder({ title: "refused", defaults: { edges } }),
        await client.updateFolder(id, { version: 1, defaults: { edges } }),
      ]) {
        expect(r.status, path).toBe(400);
        const refusal = r.error as unknown as Refusal;
        expect(refusal.error.code, path).toBe("validation_error");
        expect(refusal.error.details?.errors?.[0]?.path, path).toBe(path);
      }
    }
    // The witness: a hundred targets are taken.
    const full = { "parent-of": Array.from({ length: 100 }, () => target) };
    await folder({ defaults: { edges: full } });
  });

  it("takes a placement that climbs and comes back inside the folder, on a create and on a change", async () => {
    // The witness for the refusals above: `..` alone is not what refuses, and
    // a registered type outside `system.*` is taken.
    const settings = {
      search: { types: ["core.note"] },
      defaults: { type: "core.note" },
      first_placement: { "core.note": "Notes/../Tickets" },
    };
    const { id } = await folder(settings);
    const changed = await client.updateFolder(id, { version: 1, ...settings });
    expect(changed.status).toBe(200);
  });

  it("answers a folder create repeated under one Idempotency-Key once", async () => {
    const key = `folders-${ctx.runId}-${String(Date.now())}`;
    const send = () =>
      client.rawRequest<{ item: { id: string } }>("/folders", {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: { title: "once" },
      });
    const first = await send();
    expect(first.status).toBe(201);
    trackFolder(ctx, first.data.item.id);
    expect(first.headers.get("Idempotency-Replayed")).toBeNull();
    const repeat = await send();
    expect(repeat.status).toBe(201);
    expect(repeat.headers.get("Idempotency-Replayed")).toBe("true");
    expect(repeat.data.item.id).toBe(first.data.item.id);
  });

  it("refuses 422 a key sent again with another request on each folder door", async () => {
    const [a, b, c, d] = [
      await folder(),
      await folder(),
      await folder(),
      await folder(),
    ];
    const doors: [string, string, [string, unknown?], [string, unknown?]][] = [
      [
        "POST",
        "/folders",
        ["/folders", { title: "a" }],
        ["/folders", { title: "b" }],
      ],
      [
        "PATCH",
        "/folders/{id}",
        [`/folders/${a.id}`, { version: a.version, title: "a" }],
        [`/folders/${b.id}`, { version: b.version, title: "b" }],
      ],
      [
        "POST",
        "/folders/{id}/revoke",
        [`/folders/${c.id}/revoke`],
        [`/folders/${d.id}/revoke`],
      ],
    ];
    for (const [method, template, first, second] of doors) {
      const key = `folders-${ctx.runId}-${template}-${String(Date.now())}`;
      const send = ([path, body]: [string, unknown?]) =>
        client.rawRequest<{ item?: { id: string } } & Refusal>(path, {
          method,
          headers: { "Idempotency-Key": key },
          ...(body === undefined ? {} : { body }),
        });
      const accepted = await send(first);
      expect(accepted.status, `${method} ${template}`).toBeLessThan(300);
      if (template === "/folders" && accepted.data.item)
        trackFolder(ctx, accepted.data.item.id);
      const refused = await send(second);
      expect(
        [refused.status, refused.data.error?.code],
        `${method} ${template} served one request's answer to another`,
      ).toEqual([422, "idempotency_key_reused"]);
    }
  });

  it("publishes a folder's create, change and revoke as item events", async ({
    signal,
  }) => {
    await withStream(apiUrl, apiKey, {}, async (stream) => {
      await new Promise((r) => setTimeout(r, 200));
      const { id } = await folder();
      expect(
        (await client.updateFolder(id, { version: 1, title: "b" })).ok,
      ).toBe(true);
      expect((await client.revokeFolder(id)).ok).toBe(true);
      const ours = (e: SseEvent, name: string): boolean =>
        e.event === name &&
        (e.data as { item?: { id?: string } }).item?.id === id;
      const names = ["item.created", "item.updated", "item.state_changed"];
      const { events } = await collectUntil(
        stream,
        (evts) => names.every((n) => evts.some((e) => ours(e, n))),
        `item.created, item.updated and item.state_changed for ${id}`,
        signal,
      );
      const updated = events.find((e) => ours(e, "item.updated"));
      expect(
        (updated?.data as { item?: { properties?: { title?: string } } }).item
          ?.properties?.title,
      ).toBe("b");
    });
  });
});
