import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import type { SseEvent } from "../../utils/sse.js";
import { collectUntil, withStreamAtCursor } from "../../utils/stream.js";
import { controlRequest, localFetch } from "../../utils/control-request.js";
import { generateId } from "../../generators/items.js";
import { itemsArchive } from "../../utils/archive.js";
type RefusalBody = { error: { details?: unknown } };
let server: FreshServer;
beforeAll(async () => {
  server = await bootFreshServer("owner-trash");
  vi.stubEnv("MARFA_API_URL", server.apiUrl);
}, 2 * FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  await server?.stop();
  vi.unstubAllEnvs();
}, 2 * FRESH_SERVER_TIMEOUT_MS);
function owner(path: string, init: RequestInit = {}) {
  return localFetch(server.controlSocket, `${server.apiUrl}${path}`, init);
}
function key(path: string, body?: unknown) {
  return fetch(`${server.apiUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${server.workingKey}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function note(title: string) {
  const r = await key("/items", {
    type: "core.note",
    properties: { title, body: "private-trash-body" },
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { item: { id: string; version: number } }).item;
}
const act = (id: string, action: string, version = 1) =>
  owner(
    `/items/${id}${action === "trash" ? "" : `/${action}`}?version=${String(version)}`,
    { method: action === "trash" ? "DELETE" : "POST" },
  );
interface BinRow {
  id: string;
  type: string;
  version: number;
  name: string;
  source: string;
  created_at: string;
  trashed_at: string;
  trashed_by: { kind: string; id: string; name: string };
  eligible_for_deletion_at: string | null;
}
interface BinPage {
  data: BinRow[];
  next_cursor: string | null;
  retention_days: number;
}
async function bin(query = ""): Promise<BinPage> {
  const listed = await owner(`/trash${query}`);
  expect(listed.status).toBe(200);
  return (await listed.json()) as BinPage;
}
const tagged = () => `ot${randomUUID().slice(0, 8)}`;
async function setConfig(body: unknown) {
  const set = await owner("/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(set.status).toBe(200);
}
async function binned(title: string, extra: Record<string, unknown> = {}) {
  const made = await key("/items", {
    type: "core.note",
    properties: { title, body: "private-trash-body" },
    ...extra,
  });
  expect(made.status).toBe(201);
  const { item } = (await made.json()) as { item: { id: string } };
  expect((await act(item.id, "trash")).status).toBe(200);
  return item.id;
}
const SUMMARY_FIELDS = [
  "created_at",
  "id",
  "name",
  "source",
  "type",
  "version",
];

it("lists a trashed item as a summary with its fields and retention_days beside the page", async () => {
  const tag = tagged();
  const id = await binned(`${tag} summary`);
  const page = await bin(`?q=${tag}`);
  await expectMatchesSchema("GET", "/trash", 200, page);
  expect(Object.keys(page).sort()).toEqual([
    "data",
    "next_cursor",
    "retention_days",
  ]);
  expect(page.data.map((row) => row.id)).toEqual([id]);
  expect(Object.keys(page.data[0]!).sort()).toEqual(
    [
      ...SUMMARY_FIELDS,
      "eligible_for_deletion_at",
      "trashed_at",
      "trashed_by",
    ].sort(),
  );
  expect(page.retention_days).toBeGreaterThan(0);
});

it("lists only the items in the bin", async () => {
  const tag = tagged();
  const active = await note(`${tag} active`);
  const archived = await key("/items", {
    type: "core.note",
    state: "archived",
    properties: { title: `${tag} archived` },
  });
  expect(archived.status).toBe(201);
  const trashed = await binned(`${tag} trashed`);

  // The witness: the other two exist and the name search finds them.
  const outside = await owner(`/items/summaries?q=${tag}`);
  expect(
    ((await outside.json()) as { data: { id: string }[] }).data.map(
      (row) => row.id,
    ),
  ).toContain(active.id);

  const page = await bin(`?q=${tag}`);
  expect(page.data.map((row) => row.id)).toEqual([trashed]);
});

it("leaves out of the bin the items whose source the instance's source filter does not admit", async () => {
  const tag = tagged();
  const id = await binned(`${tag} filtered`);
  const bookmark = await key("/items", {
    type: "core.bookmark",
    state: "trashed",
    properties: { url: "https://example.com/filtered", title: `${tag} kept` },
  });
  expect(bookmark.status).toBe(201);
  const other = ((await bookmark.json()) as { item: { id: string } }).item.id;
  expect((await bin(`?q=${tag}`)).data.map((row) => row.id).sort()).toEqual(
    [id, other].sort(),
  );

  await setConfig({
    enforcement: {
      source_filter: { types: ["core.note"], sources: ["unwritten-source"] },
    },
  });
  try {
    expect((await bin(`?q=${tag}`)).data.map((row) => row.id)).toEqual([other]);
  } finally {
    await setConfig({ enforcement: null });
  }
  expect((await bin(`?q=${tag}`)).data).toHaveLength(2);
});

it("lists the items of the type it names and no other, matching the identifier exactly", async () => {
  const tag = tagged();
  const noteId = await binned(`${tag} note`);
  const marked = await key("/items", {
    type: "core.bookmark",
    state: "trashed",
    properties: { url: "https://example.com/typed", title: `${tag} bookmark` },
  });
  const bookmarkId = ((await marked.json()) as { item: { id: string } }).item
    .id;
  expect((await bin(`?q=${tag}`)).data.map((row) => row.id).sort()).toEqual(
    [noteId, bookmarkId].sort(),
  );
  expect(
    (await bin(`?q=${tag}&type=core.bookmark`)).data.map((row) => row.id),
  ).toEqual([bookmarkId]);
  expect(
    (await bin(`?q=${tag}&type=core.bookmar`)).data.map((row) => row.id),
  ).toEqual([]);
});

it("matches q as a case-insensitive substring of the name alone, with the query trimmed", async () => {
  const tag = tagged();
  const named = await binned(`Needle ${tag} Name`);
  const content = await key("/items", {
    type: "core.note",
    state: "trashed",
    properties: { title: "Plain title", body: `needle ${tag} in the body` },
  });
  expect(content.status).toBe(201);
  const upper = encodeURIComponent(`  NEEDLE ${tag.toUpperCase()}  `);
  expect((await bin(`?q=${upper}`)).data.map((row) => row.id)).toEqual([named]);
  // The witness: the same words in the body are found by the item search.
  const found = await key(`/search?q=${encodeURIComponent(`needle ${tag}`)}`);
  expect(found.status).toBe(200);
});

it("applies q before the page, so a match behind newer items still fills the page", async () => {
  const tag = tagged();
  const match = await binned(`${tag} match`);
  await binned(`${tag}-other newer`);
  await binned(`${tag}-other newest`);
  const page = await bin(`?q=${tag}%20match&limit=1`);
  expect(page.data.map((row) => row.id)).toEqual([match]);
  expect(page.next_cursor).toBeNull();
});

it("lists the bin newest created first, with the id as the tie-break, whatever order the items went there", async () => {
  const tag = tagged();
  const ids = [generateId(), generateId(), generateId()];
  const made = await key("/items/bulk", {
    items: ids.map((id, at) => ({
      id,
      type: "core.note",
      properties: { title: `${tag} tie ${String(at)}` },
    })),
  });
  expect(made.status).toBe(200);
  const first = await note(`${tag} separate first`);
  const second = await note(`${tag} separate second`);
  for (const id of [ids[0]!, second.id, ids[2]!, first.id, ids[1]!]) {
    expect((await act(id, "trash")).status).toBe(200);
  }
  const everything = [...ids].reverse();
  const listed = await bin(`?q=${tag}&limit=200`);
  expect(listed.data.map((row) => row.id)).toEqual([
    second.id,
    first.id,
    ...everything,
  ]);

  const walked: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await bin(
      `?q=${tag}&limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
    );
    walked.push(...page.data.map((row) => row.id));
    cursor = page.next_cursor;
  } while (cursor !== null);
  expect(walked).toEqual(listed.data.map((row) => row.id));
});

it.each(["/trash", "/items/summaries"])(
  "takes a q of 500 characters on GET %s and refuses one of 501, naming q",
  async (path) => {
    const accepted = await owner(`${path}?q=${"a".repeat(500)}`);
    expect(accepted.status).toBe(200);
    const refused = await owner(`${path}?q=${"a".repeat(501)}`);
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as {
      error: { code: string; details?: { field?: string } };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details?.field).toBe("q");
    const wide = await owner(
      `${path}?q=${encodeURIComponent("é".repeat(500))}`,
    );
    expect(wide.status).toBe(200);
    const astral = "\u{1F600}";
    const counted = await owner(
      `${path}?q=${encodeURIComponent(astral.repeat(500))}`,
    );
    expect(counted.status).toBe(200);
    const over = await owner(
      `${path}?q=${encodeURIComponent(astral.repeat(501))}`,
    );
    expect(over.status).toBe(400);
  },
);

it("answers a move to the bin, a restore and a purge with the item's summary", async () => {
  const item = await note("Owner action answers");
  const answered = async (action: string) => {
    const done = await act(item.id, action);
    expect(done.status, action).toBe(200);
    const body = (await done.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort(), action).toEqual(SUMMARY_FIELDS);
    expect(body.id, action).toBe(item.id);
    return body;
  };
  await expectMatchesSchema(
    "DELETE",
    "/items/{id}",
    200,
    await answered("trash"),
  );
  await expectMatchesSchema(
    "POST",
    "/items/{id}/restore",
    200,
    await answered("restore"),
  );
  await answered("trash");
  await expectMatchesSchema(
    "POST",
    "/items/{id}/purge",
    200,
    await answered("purge"),
  );
});

it("moves an item to the bin with the children it takes, and leaves a key unable to read either", async () => {
  const root = await note("Owner move parent");
  const child = await note("Owner move child");
  const edge = await key("/edges", {
    from_id: root.id,
    to_id: child.id,
    edge_type: "parent-of",
  });
  expect(edge.status).toBe(201);
  expect((await key(`/items/${child.id}`)).status).toBe(200);

  expect((await act(root.id, "trash")).status).toBe(200);
  expect((await key(`/items/${root.id}`)).status).toBe(404);
  expect((await key(`/items/${child.id}`)).status).toBe(404);
  const listed = (await bin("?limit=200")).data.map((row) => row.id);
  expect(listed).toContain(root.id);
  expect(listed).toContain(child.id);
});

it("restores an item with the children that went to the bin with it", async () => {
  const root = await note("Owner restore parent");
  const child = await note("Owner restore child");
  expect(
    (
      await key("/edges", {
        from_id: root.id,
        to_id: child.id,
        edge_type: "parent-of",
      })
    ).status,
  ).toBe(201);
  expect((await act(root.id, "trash")).status).toBe(200);
  expect((await key(`/items/${child.id}`)).status).toBe(404);

  expect((await act(root.id, "restore")).status).toBe(200);
  expect((await key(`/items/${root.id}`)).status).toBe(200);
  expect((await key(`/items/${child.id}`)).status).toBe(200);
});

it("purges an item in the bin for good, and refuses to purge one that is not in the bin", async () => {
  const item = await note("Owner purge");
  const refused = await act(item.id, "purge");
  expect(refused.status).toBe(400);
  expect(
    ((await refused.json()) as { error: { code: string } }).error.code,
  ).toBe("invalid_transition");
  expect((await key(`/items/${item.id}`)).status).toBe(200);

  expect((await act(item.id, "trash")).status).toBe(200);
  expect((await act(item.id, "purge")).status).toBe(200);
  expect((await key(`/items/${item.id}`)).status).toBe(404);
  expect((await bin("?limit=200")).data.map((row) => row.id)).not.toContain(
    item.id,
  );
});

it("refuses a move to the bin of an item that a block edge points to, with 400 and a fixed message, and leaves the item", async () => {
  const id = `mock.owner-block.r${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const registered = await key("/edge-types", {
    id,
    label: "Blocking test edge type",
    cardinality: "many-to-many",
    cascade_on_delete: "block",
  });
  expect(registered.status, await registered.clone().text()).toBe(201);
  const holder = await note("Owner block holder");
  const held = await note("Owner block held");
  const witness = await note("Owner block witness");
  expect(
    (
      await key("/edges", {
        from_id: holder.id,
        to_id: held.id,
        edge_type: id,
      })
    ).status,
  ).toBe(201);

  // The witness: an item no block edge holds moves.
  expect((await act(witness.id, "trash")).status).toBe(200);

  const refused = await act(held.id, "trash");
  expect(refused.status).toBe(400);
  const body = (await refused.json()) as {
    error: { code: string; message: string };
  };
  expect(body.error.code).toBe("edge_constraint_violation");
  expect(body.error.message).toBe(
    "Another item prevents this item from moving to the trash.",
  );
  expect((await key(`/items/${held.id}`)).status).toBe(200);
  expect((await key(`/items/${holder.id}`)).status).toBe(200);
});

it("keeps item content out of every answer to an owner trash action, the current summary of a stale version included", async () => {
  const item = await note("Owner boundary");
  await key("/items", { type: "core.note", properties: { title: "other" } });
  const answers: Response[] = [];
  answers.push(await act(item.id, "trash", 2));
  answers.push(await act(item.id, "trash"));
  answers.push(await act(item.id, "restore", 2));
  answers.push(await act(item.id, "restore"));
  answers.push(await act(item.id, "purge", 2));
  answers.push(await act(item.id, "purge"));
  answers.push(await act("invalid", "trash"));
  answers.push(await act("01900000-0000-7000-8000-000000000001", "restore"));
  const seen: number[] = [];
  for (const answer of answers) {
    seen.push(answer.status);
    const text = await answer.text();
    expect(text).not.toContain("private-trash-body");
    const parsed = JSON.parse(text) as {
      current?: Record<string, unknown>;
      edges?: unknown;
      metadata?: unknown;
      history?: unknown;
      properties?: unknown;
    };
    expect(parsed.edges).toBeUndefined();
    expect(parsed.metadata).toBeUndefined();
    expect(parsed.history).toBeUndefined();
    expect(parsed.properties).toBeUndefined();
    if (parsed.current !== undefined) {
      expect(Object.keys(parsed.current).sort()).toEqual(SUMMARY_FIELDS);
    }
  }
  // The witness: the refusals and the successes are both in the set.
  expect(seen).toContain(409);
  expect(seen).toContain(200);
});

it("answers a stale version with 409 version_conflict and the item's current summary, leaving it unchanged", async () => {
  const item = await note("Owner version");
  for (const action of ["trash", "restore", "purge"]) {
    const stale = await act(item.id, action, 2);
    expect(stale.status, action).toBe(409);
    const body = (await stale.json()) as {
      error: { code: string };
      current: { id: string; version: number };
    };
    expect(body.error.code, action).toBe("version_conflict");
    expect(body.current.id, action).toBe(item.id);
    expect(body.current.version, action).toBe(item.version);
  }
  const read = await key(`/items/${item.id}`);
  expect(read.status).toBe(200);
  expect(((await read.json()) as { item: { state: string } }).item.state).toBe(
    "active",
  );
  expect((await act(item.id, "trash")).status).toBe(200);
});

it("refuses a key without items.purge every owner trash door, naming the permission", async () => {
  const minted = await controlRequest(server.controlSocket, "/keys", {
    method: "POST",
    body: {
      label: "owner trash without items.purge",
      source: `owner-trash-${randomUUID()}`,
      type_permissions: { "*": "write" },
    },
  });
  expect(minted.status).toBe(201);
  const holder = minted.body.key as string;
  for (const [method, path] of [
    ["GET", "/trash"],
    ["POST", "/trash/empty"],
  ] as const) {
    const refused = await fetch(`${server.apiUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${holder}` },
    });
    expect(refused.status, path).toBe(403);
    expect(((await refused.json()) as RefusalBody).error.details, path).toEqual(
      { required_scope: "items.purge" },
    );
  }
  // The witness: the local command is admitted at the same paths.
  expect((await owner("/trash?limit=1")).status).toBe(200);
});

it("gives an item's trashed_by the sign-in that last moved it to the bin, and trashed_at the time", async () => {
  const tag = tagged();
  const made = await key("/items", {
    type: "core.note",
    properties: { title: `${tag} identity` },
  });
  const { item } = (await made.json()) as { item: { id: string } };
  const deleted = await fetch(`${server.apiUrl}/items/${item.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${server.workingKey}` },
  });
  expect(deleted.status).toBe(200);
  const byKey = (await bin(`?q=${tag}`)).data[0]!;
  expect(byKey.trashed_by.kind).toBe("key");
  expect(byKey.trashed_by.name).toBeTruthy();
  expect(byKey.trashed_by.id).toBeTruthy();
  expect(Date.parse(byKey.trashed_at)).toBeGreaterThan(
    Date.parse(byKey.created_at) - 1,
  );

  expect((await act(item.id, "restore")).status).toBe(200);
  expect((await act(item.id, "trash")).status).toBe(200);
  const byOwner = (await bin(`?q=${tag}`)).data[0]!;
  expect(byOwner.trashed_by).toEqual({
    kind: "local",
    id: "local",
    name: "Local command",
  });
  expect(Date.parse(byOwner.trashed_at)).toBeGreaterThanOrEqual(
    Date.parse(byKey.trashed_at),
  );
});

async function retention(days: number) {
  await setConfig({ trash_retention_days: days });
}

it("gives eligible_for_deletion_at as the deletion time plus the retention days", async () => {
  const tag = tagged();
  await binned(`${tag} eligible`);
  try {
    for (const days of [7, 60]) {
      await retention(days);
      const page = await bin(`?q=${tag}`);
      expect(page.retention_days).toBe(days);
      const row = page.data[0]!;
      expect(row.eligible_for_deletion_at).toBe(
        new Date(Date.parse(row.trashed_at) + days * 86_400_000).toISOString(),
      );
    }
  } finally {
    await retention(60);
  }
});

it("gives eligible_for_deletion_at as null while the retention is 0 days", async () => {
  const tag = tagged();
  await binned(`${tag} never`);
  expect(
    (await bin(`?q=${tag}`)).data[0]!.eligible_for_deletion_at,
  ).toBeTruthy();
  await retention(0);
  try {
    const page = await bin(`?q=${tag}`);
    expect(page.retention_days).toBe(0);
    expect(page.data[0]!.eligible_for_deletion_at).toBeNull();
  } finally {
    await retention(60);
  }
});

it("refuses a cursor the bin did not issue with 400 validation_error", async () => {
  const refused = await owner("/trash?cursor=invalid");
  expect(refused.status).toBe(400);
  expect(
    ((await refused.json()) as { error: { code: string } }).error.code,
  ).toBe("validation_error");
  // The witness: a cursor the bin issued is taken.
  const tag = tagged();
  await binned(`${tag} one`);
  await binned(`${tag} two`);
  const first = await bin(`?q=${tag}&limit=1`);
  expect(first.next_cursor).not.toBeNull();
  expect(
    (
      await owner(
        `/trash?q=${tag}&limit=1&cursor=${encodeURIComponent(first.next_cursor!)}`,
      )
    ).status,
  ).toBe(200);
});

it("refuses an owner trash action that names a malformed id with 400 invalid_id", async () => {
  for (const action of ["trash", "restore", "purge"]) {
    const refused = await act("invalid", action);
    expect(refused.status, action).toBe(400);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
      action,
    ).toBe("invalid_id");
  }
});

it("refuses an owner trash action that names an item no item holds with 404 item_not_found", async () => {
  const held = await note("Owner action witness");
  expect((await act(held.id, "trash")).status).toBe(200);
  for (const action of ["trash", "restore", "purge"]) {
    const refused = await act("01900000-0000-7000-8000-000000000001", action);
    expect(refused.status, action).toBe(404);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
      action,
    ).toBe("item_not_found");
  }
});

it("preserves deletion identity and time through an archive and clears them on restoration", async () => {
  await drainBin();
  const item = await note("Archive witness");
  expect((await act(item.id, "trash")).status).toBe(200);
  const before = (await (await owner("/trash")).json()) as { data: unknown[] };
  // The private local command meets no credential requirement of the export,
  // so a key that reads notes takes the archive.
  const archive = await key("/export?format=archive&type=core.note&state=any");
  expect(archive.status).toBe(200);
  const bytes = await archive.arrayBuffer();
  expect((await act(item.id, "purge")).status).toBe(200);
  const restore = await owner("/restore", {
    method: "POST",
    headers: { "content-type": "application/x-tar" },
    body: bytes,
  });
  expect(restore.status).toBe(200);
  const after = (await (await owner("/trash")).json()) as { data: unknown[] };
  expect(after.data).toEqual(before.data);
  expect((await act(item.id, "restore")).status).toBe(200);
  expect(
    ((await (await owner("/trash")).json()) as { data: unknown[] }).data,
  ).toEqual([]);
});

it("lets the owner remove only unused custom types", async () => {
  for (const id of [
    "user.empty",
    "user.held",
    "user.parent",
    "user.dependent",
  ]) {
    const result = await key("/types", {
      id,
      fields: { title: { type: "string" } },
      ...(id === "user.dependent" ? { parent: "user.parent" } : {}),
    });
    expect(result.status).toBe(201);
  }
  expect(
    (
      await key("/items", {
        type: "user.held",
        state: "trashed",
        properties: { title: "Held" },
      })
    ).status,
  ).toBe(201);
  expect((await owner("/types/user.held", { method: "DELETE" })).status).toBe(
    409,
  );
  expect(
    (await owner("/types/user.held?force=true", { method: "DELETE" })).status,
  ).toBe(403);
  expect((await owner("/types/user.parent", { method: "DELETE" })).status).toBe(
    409,
  );
  expect((await owner("/types/core.note", { method: "DELETE" })).status).toBe(
    403,
  );
  expect((await owner("/types/user.empty", { method: "DELETE" })).status).toBe(
    200,
  );
});
it("announces the owner's trash, restore, purge and emptying of the bin as the item events, and nothing else", async ({
  signal,
}) => {
  const rowOf = (e: SseEvent) =>
    (e.data as { item?: { id?: string } }).item?.id;
  const purged = await note("Purged");
  const emptied = await note("Emptied");
  const frames = await withStreamAtCursor(
    server.apiUrl,
    server.workingKey,
    { signal },
    async (stream) => {
      for (const action of ["trash", "restore", "trash", "purge"]) {
        const r = await act(purged.id, action);
        expect(r.status, action).toBe(200);
      }
      expect((await act(emptied.id, "trash")).status).toBe(200);
      expect((await owner("/trash/empty", { method: "POST" })).status).toBe(
        200,
      );
      const witness = await note("Witness");
      const { events } = await collectUntil(
        stream,
        (evts) => evts.some((e) => rowOf(e) === witness.id),
        `the witness ${witness.id}`,
        signal,
      );
      return events;
    },
  );
  const of = (id: string) =>
    frames.filter((e) => rowOf(e) === id).map((e) => e.event);
  expect(of(purged.id)).toEqual([
    "item.trashed",
    "item.restored",
    "item.trashed",
    "item.purged",
  ]);
  expect(of(emptied.id)).toEqual(["item.trashed", "item.purged"]);
});

async function emptyBin() {
  const emptied = await owner("/trash/empty", { method: "POST" });
  expect(emptied.status).toBe(200);
  const body = (await emptied.json()) as {
    purged: number;
    failures: { id: string; code: string }[];
    next_cursor: string | null;
  };
  await expectMatchesSchema("POST", "/trash/empty", 200, body);
  return body;
}

async function status(id: string) {
  return (await key(`/items/${id}`)).status;
}

it("counts every item emptying the bin removes, parts included, and reports no failure for a part that went with its host", async () => {
  expect(await emptyBin()).toMatchObject({ failures: [] });
  const witness = await emptyBin();
  expect(witness).toEqual({ purged: 0, failures: [], next_cursor: null });

  const part = await note("Part, older than its host");
  const nested = await note("Part of the part");
  const host = await note("Host");
  const alone = await note("Alone");
  for (const [source, target] of [
    [part.id, host.id],
    [nested.id, part.id],
  ] as const) {
    const edge = await key("/edges", {
      from_id: source,
      to_id: target,
      edge_type: "comments-on",
    });
    expect(edge.status).toBe(201);
  }
  expect((await act(host.id, "trash")).status).toBe(200);
  expect((await act(alone.id, "trash")).status).toBe(200);

  const emptied = await emptyBin();
  expect(emptied).toEqual({ purged: 4, failures: [], next_cursor: null });
  for (const id of [part.id, nested.id, host.id, alone.id]) {
    expect(await status(id), id).toBe(404);
  }
  expect(await emptyBin()).toEqual(witness);
});

async function fillBin(count: number, tag: string): Promise<string[]> {
  const made = await key("/items/bulk", {
    items: Array.from({ length: count }, (_, at) => ({
      type: "core.note",
      state: "trashed",
      properties: { title: `${tag} ${String(at)}` },
    })),
  });
  expect(made.status).toBe(200);
  return ((await made.json()) as { results: { id: string }[] }).results.map(
    (row) => row.id,
  );
}

async function drainBin(): Promise<void> {
  for (;;) {
    const emptied = await emptyBin();
    if (emptied.purged === 0 && emptied.next_cursor === null) return;
  }
}

async function wholeBin(): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await bin(
      `?limit=200${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
    );
    ids.push(...page.data.map((row) => row.id));
    cursor = page.next_cursor;
  } while (cursor !== null);
  return ids;
}

it("attempts at most 200 items of the bin in a batch, those a listing of the bin gives first", async () => {
  await drainBin();
  await fillBin(201, tagged());
  const before = await wholeBin();
  expect(before).toHaveLength(201);

  const batch = await emptyBin();
  expect(batch.purged).toBe(200);
  expect(batch.failures).toEqual([]);
  expect(await wholeBin()).toEqual([before[200]]);
  await drainBin();
});

it("returns the cursor that continues a batch at the item after it, and null at the end of the bin", async () => {
  await drainBin();
  await fillBin(3, tagged());
  expect((await emptyBin()).next_cursor).toBeNull();

  await fillBin(201, tagged());
  const first = await emptyBin();
  expect(first.purged).toBe(200);
  expect(first.next_cursor).toEqual(expect.any(String));
  const rest = await owner(
    `/trash/empty?cursor=${encodeURIComponent(first.next_cursor!)}`,
    { method: "POST" },
  );
  expect(rest.status).toBe(200);
  expect(await rest.json()).toEqual({
    purged: 1,
    failures: [],
    next_cursor: null,
  });
});

it("keeps an item that left the bin after the batch selected it, and lists it in failures as invalid_transition", async () => {
  await drainBin();
  await binned(tagged());
  await binned(tagged());

  // The witness: with nothing changed, both are purged.
  const witness = await emptyBin();
  expect(witness.purged).toBe(2);
  expect(witness.failures).toEqual([]);

  const again = await binned(tagged());
  await server.setFault("hold:write=item.purge@1");
  try {
    const pending = owner("/trash/empty", { method: "POST" });
    await server.waitForHold("hold:write");
    expect((await act(again, "restore")).status).toBe(200);
    await server.clearFault("hold:write");
    const emptied = (await (await pending).json()) as Awaited<
      ReturnType<typeof emptyBin>
    >;
    expect(emptied.purged).toBe(0);
    expect(emptied.failures).toEqual([
      expect.objectContaining({ id: again, code: "invalid_transition" }),
    ]);
  } finally {
    await server.clearFault();
  }
  expect(await status(again)).toBe(200);
});

type Refused = {
  error: {
    code: string;
    message: string;
    details?: { write_outcome?: string };
  };
};

const OWNER_WRITES = [
  ["trash", "item.delete"],
  ["restore", "item.restore"],
  ["purge", "item.purge"],
] as const;

async function readyFor(action: string) {
  const tag = tagged();
  if (action === "trash") return note(tag);
  const id = await binned(tag);
  const row = (await bin(`?q=${tag}`)).data.find((listed) => listed.id === id)!;
  return { id, version: row.version };
}

async function commitTurnedAway(point: string, status: number, code: string) {
  for (const [action, write] of OWNER_WRITES) {
    const { id, version } = await readyFor(action);
    await server.setFault(`${point}=${write}`);
    try {
      const refused = await act(id, action, version);
      expect(refused.status, action).toBe(status);
      const body = (await refused.json()) as Refused;
      expect(body.error.code, action).toBe(code);
      expect(body.error.details?.write_outcome, action).toBe("unknown");
      expect(body.error.message, action).not.toMatch(
        /\b(kept|deleted|removed|purged|restored|trashed)\b/i,
      );
      expect(
        (await server.faults()).some((fault) => fault.fired > 0),
        action,
      ).toBe(true);
    } finally {
      await server.clearFault();
    }
    // The witness: nothing landed and the fault acted once, so the same action lands.
    expect((await act(id, action, version)).status, action).toBe(200);
  }
  await drainBin();
}

it("answers an owner trash, restore or purge whose commit cannot be confirmed with 500 and write_outcome unknown", async () => {
  await commitTurnedAway("fail:commit", 500, "internal_error");
});

it("answers an owner trash, restore or purge that a full volume turns away with 507 and write_outcome unknown", async () => {
  await commitTurnedAway("fail:commit-full", 507, "insufficient_storage");
});

async function uncertainBatch(count: number) {
  await drainBin();
  const tag = tagged();
  const ids = await fillBin(count, tag);
  const listed = await wholeBin();
  await server.setFault("fail:commit=item.purge");
  try {
    const emptied = await emptyBin();
    expect((await server.faults()).some((fault) => fault.fired > 0)).toBe(true);
    return { emptied, listed, ids };
  } finally {
    await server.clearFault();
  }
}

it("lists the item whose purge could not be confirmed in failures, with write_outcome unknown", async () => {
  const { emptied, listed } = await uncertainBatch(2);
  expect(emptied.failures).toEqual([
    expect.objectContaining({
      id: listed[0],
      code: "internal_error",
      details: { write_outcome: "unknown" },
    }),
  ]);
  await drainBin();
});

it("attempts no further item of a batch after one whose purge could not be confirmed", async () => {
  const { emptied, listed } = await uncertainBatch(3);
  expect(emptied.purged).toBe(0);
  expect(emptied.failures).toHaveLength(1);
  // The witness: the fault acted once, so a second attempt would have purged.
  expect(await wholeBin()).toEqual(listed);
  expect((await emptyBin()).purged).toBe(3);
});

it("returns no cursor after a batch that stopped for a purge it could not confirm", async () => {
  await drainBin();
  await fillBin(201, tagged());
  await server.setFault("fail:commit=item.purge");
  try {
    const stopped = await emptyBin();
    expect(stopped.failures).toHaveLength(1);
    expect(stopped.next_cursor).toBeNull();
  } finally {
    await server.clearFault();
  }
  // The witness: the same bin answers a cursor once the purge can be confirmed.
  const resumed = await emptyBin();
  expect(resumed.next_cursor).toEqual(expect.any(String));
  await drainBin();
});

it("stops a batch at a purge that a full volume turns away, listing it as insufficient_storage with write_outcome unknown", async () => {
  await drainBin();
  await fillBin(3, tagged());
  const listed = await wholeBin();
  await server.setFault("fail:commit-full=item.purge");
  try {
    const stopped = await emptyBin();
    expect((await server.faults()).some((fault) => fault.fired > 0)).toBe(true);
    expect(stopped.failures).toEqual([
      expect.objectContaining({
        id: listed[0],
        code: "insufficient_storage",
        details: { write_outcome: "unknown" },
      }),
    ]);
    expect(stopped.purged).toBe(0);
    expect(stopped.next_cursor).toBeNull();
  } finally {
    await server.clearFault();
  }
  // The witness: the fault acted once, so a second attempt would have purged.
  expect(await wholeBin()).toEqual(listed);
  expect((await emptyBin()).purged).toBe(3);
});

it("keeps an item whose version changed after the batch selected it, and lists it in failures as version_conflict", async () => {
  await drainBin();
  await binned(tagged());
  await binned(tagged());

  // The witness: with nothing changed, both are purged.
  const witness = await emptyBin();
  expect(witness.purged).toBe(2);
  expect(witness.failures).toEqual([]);

  const tag = tagged();
  const again = await binned(tag);
  const version = (await bin(`?q=${tag}`)).data[0]!.version;
  await server.setFault("hold:write=item.purge@1");
  try {
    const pending = owner("/trash/empty", { method: "POST" });
    await server.waitForHold("hold:write");
    expect((await act(again, "restore", version)).status).toBe(200);
    const changed = await fetch(`${server.apiUrl}/items/${again}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${server.workingKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version,
        properties: { title: `${tag} changed` },
      }),
    });
    expect(changed.status).toBe(200);
    expect((await act(again, "trash", version + 1)).status).toBe(200);
    await server.clearFault("hold:write");
    const emptied = (await (await pending).json()) as Awaited<
      ReturnType<typeof emptyBin>
    >;
    expect(emptied.purged).toBe(0);
    expect(emptied.failures).toEqual([
      expect.objectContaining({ id: again, code: "version_conflict" }),
    ]);
  } finally {
    await server.clearFault();
  }
  expect((await bin(`?q=${tag}`)).data.map((row) => row.id)).toEqual([again]);
});

it("restores an archived item in the bin that records no time or sign-in with both null, and no deletion deadline", async () => {
  await drainBin();
  await retention(60);
  const tag = tagged();
  const witness = await binned(`${tag} recorded`);
  const unrecorded = generateId();
  const restored = await owner("/restore", {
    method: "POST",
    headers: { "content-type": "application/x-tar" },
    body: new Uint8Array(
      itemsArchive([
        {
          id: unrecorded,
          type: "core.note",
          source: "owner-trash-archive",
          state: "trashed",
          properties: { title: `${tag} unrecorded` },
        },
      ]),
    ),
  });
  expect(restored.status).toBe(200);
  const rows = (await bin(`?q=${tag}`)).data;
  const row = rows.find((listed) => listed.id === unrecorded)!;
  expect(row.trashed_at).toBeNull();
  expect(row.trashed_by).toBeNull();
  expect(row.eligible_for_deletion_at).toBeNull();
  // The witness: an item moved to the bin has all three.
  const recorded = rows.find((listed) => listed.id === witness)!;
  expect(recorded.trashed_at).toEqual(expect.any(String));
  expect(recorded.trashed_by).toEqual(expect.any(Object));
  expect(recorded.eligible_for_deletion_at).toEqual(expect.any(String));
  await drainBin();
});

it("answers an owner trash action on a system item, or one the source filter hides, with 404 item_not_found and leaves it", async () => {
  const made = await key("/folders", { title: tagged() });
  expect(made.status).toBe(201);
  const folder = ((await made.json()) as { item: { id: string } }).item;
  const binnedTag = tagged();
  const hiddenBinned = await binned(binnedTag);
  const binnedVersion = (await bin(`?q=${binnedTag}`)).data[0]!.version;
  const hiddenActive = await note(tagged());
  const refuse = async (id: string, action: string, version: number) => {
    const refused = await act(id, action, version);
    expect(refused.status, `${id} ${action}`).toBe(404);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe("item_not_found");
  };
  for (const action of ["trash", "restore", "purge"]) {
    await refuse(folder.id, action, 1);
  }
  await setConfig({
    enforcement: {
      source_filter: { types: ["core.note"], sources: ["unwritten-source"] },
    },
  });
  try {
    await refuse(hiddenBinned, "restore", binnedVersion);
    await refuse(hiddenBinned, "purge", binnedVersion);
    await refuse(hiddenActive.id, "trash", hiddenActive.version);
  } finally {
    await setConfig({ enforcement: null });
  }
  // The witness: with the filter gone the same items answer their actions.
  expect((await act(hiddenBinned, "restore", binnedVersion)).status).toBe(200);
  expect(
    (await act(hiddenActive.id, "trash", hiddenActive.version)).status,
  ).toBe(200);
  const read = await key(`/items/${hiddenBinned}`);
  expect(read.status).toBe(200);
  await drainBin();
});
