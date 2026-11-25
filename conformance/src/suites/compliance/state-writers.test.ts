import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { controlRequest } from "../../utils/control-request.js";
import {
  approvedApp,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  DAY_MS,
  movedClock,
  QUIET_SCHEDULE,
  quiet,
  runJob,
  writerOf,
} from "../../utils/moved-clock.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let server: FreshServer;
let clock: ReturnType<typeof movedClock>;

beforeAll(async () => {
  server = await bootFreshServer("state-writers", QUIET_SCHEDULE);
  clock = movedClock(server);
  await quiet(server, ["feed-expiry", "event-log-cleanup"]);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

interface Writer {
  kind: string;
  id: string;
  name: string;
}

interface Answered {
  id: string;
  state: string;
  version: number;
  writer?: Writer | null;
  state_writer?: Writer | null;
}

interface Minted {
  id: string;
  key: string;
  label: string;
  source: string;
}

type Answer = { status: number; body: Record<string, unknown> };

function local(method: string, path: string, body?: unknown): Promise<Answer> {
  return controlRequest(server.controlSocket, path, { method, body });
}

async function mintKey(
  label: string,
  typePermissions: Record<string, string> = { "core.note": "write" },
  edgePermissions: Record<string, string> = {},
): Promise<Minted> {
  const minted = await local("POST", "/keys", {
    label,
    source: `state-writers-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
    type_permissions: typePermissions,
    edge_permissions: edgePermissions,
  });
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  return minted.body as unknown as Minted;
}

async function call(
  bearer: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const response = await fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function createNote(
  bearer: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const created = await call(bearer, "POST", "/items", {
    type: "core.note",
    properties: { body: "first" },
    ...extra,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return (created.body.item as { id: string }).id;
}

function as(minted: Minted): Writer {
  return { kind: "key", id: minted.id, name: minted.label };
}

/** `GET /items/{id}` with the writers, whatever state the item is in. */
async function read(bearer: string, id: string): Promise<Answered> {
  const answer = await call(
    bearer,
    "GET",
    `/items/${id}?include=writer&state=any`,
  );
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  await expectMatchesSchema("GET", "/items/{id}", 200, answer.body);
  return answer.body.item as Answered;
}

async function bulkGet(
  bearer: string,
  ids: string[],
  include: string[] = ["writer"],
): Promise<Answered[]> {
  const answer = await call(bearer, "POST", "/items/bulk-get", {
    ids,
    include,
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  await expectMatchesSchema("POST", "/items/bulk-get", 200, answer.body);
  return answer.body.data as Answered[];
}

function clientOf(minted: Minted): MarfaClient {
  return new MarfaClient({ baseUrl: server.apiUrl, apiKey: minted.key });
}

describe("who made an item's last state move", () => {
  it("answers the key that archived an item to another credential, and the one that brought it back", async () => {
    const author = await mintKey("state author");
    const archiver = await mintKey("state archiver");
    const reader = await mintKey("state reader", { "core.note": "read" });
    const restorer = await mintKey("state restorer");
    const id = await createNote(author.key);

    expect((await read(reader.key, id)).state_writer).toBeNull();
    expect(
      (await clientOf(archiver).transitionItem(id, "archived")).status,
    ).toBe(200);
    const archived = await read(reader.key, id);
    expect(archived.state).toBe("archived");
    expect(archived.state_writer).toEqual(as(archiver));
    // The move wrote no version, so the version's writer is still the author's.
    expect(archived.writer).toEqual(as(author));
    expect((await bulkGet(reader.key, [id]))[0]!.state_writer).toEqual(
      as(archiver),
    );

    expect((await clientOf(restorer).transitionItem(id, "active")).status).toBe(
      200,
    );
    expect((await read(reader.key, id)).state_writer).toEqual(as(restorer));
    expect((await bulkGet(reader.key, [id]))[0]!.state_writer).toEqual(
      as(restorer),
    );
  });

  it("answers null for an item that was created and has not moved, in any state it was created in", async () => {
    const author = await mintKey("unmoved author");
    const active = await createNote(author.key);
    const archived = await createNote(author.key, { state: "archived" });
    const read1 = await read(author.key, active);
    expect(read1).toHaveProperty("state_writer", null);
    const read2 = await read(author.key, archived);
    expect(read2.state).toBe("archived");
    expect(read2).toHaveProperty("state_writer", null);
    expect(
      (await bulkGet(author.key, [active, archived])).map(
        (item) => item.state_writer,
      ),
    ).toEqual([null, null]);
  });

  it("answers the app that moved an item to the bin by the id and name its sign-in has", async () => {
    const app = await approvedApp(server, ["core.note:write"]);
    const author = await mintKey("bin author");
    const id = await createNote(author.key);
    const listed = (
      (await local("GET", "/owner/sign-ins")).body.data as {
        id: string;
        kind: string;
        name: string;
      }[]
    ).find((row) => row.kind === "app" && row.name === "conformance");
    expect(listed, "the device's app is not listed").toBeDefined();

    const trashed = await call(app.token, "DELETE", `/items/${id}`);
    expect(trashed.status, JSON.stringify(trashed.body)).toBe(200);
    expect((await call(author.key, "GET", `/items/${id}`)).status).toBe(404);
    expect((await read(author.key, id)).state_writer).toEqual({
      kind: "app",
      id: listed!.id,
      name: "conformance",
    });
  });

  it("answers the local command that restored an item from the bin", async () => {
    const author = await mintKey("local bin author");
    const id = await createNote(author.key);
    expect((await clientOf(author).deleteItem(id)).status).toBe(200);
    expect((await read(author.key, id)).state_writer).toEqual(as(author));

    const back = await local(
      "POST",
      `/items/${id}/restore?version=${String((await read(author.key, id)).version)}`,
    );
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect((await read(author.key, id)).state_writer).toEqual({
      kind: "local",
      id: "local",
      name: "Local command",
    });
  });

  it("names the requester for each item a move to the bin takes along, and for each a restore brings back", async () => {
    const mover = await mintKey(
      "cascade mover",
      { "core.note": "write" },
      {
        "*": "write",
      },
    );
    const restorer = await mintKey(
      "cascade restorer",
      {
        "core.note": "write",
      },
      { "*": "write" },
    );
    const parent = await createNote(mover.key);
    const child = await createNote(mover.key);
    const edge = await call(mover.key, "POST", "/edges", {
      from_id: parent,
      to_id: child,
      edge_type: "parent-of",
    });
    expect(edge.status, JSON.stringify(edge.body)).toBe(201);

    expect((await clientOf(mover).deleteItem(parent)).status).toBe(200);
    // The witness: the child went to the bin with its parent.
    expect((await read(mover.key, child)).state).toBe("trashed");
    expect((await read(mover.key, child)).state_writer).toEqual(as(mover));
    expect((await read(mover.key, parent)).state_writer).toEqual(as(mover));

    expect((await clientOf(restorer).restoreItem(parent)).status).toBe(200);
    const back = await read(mover.key, child);
    expect(back.state).toBe("active");
    expect(back.state_writer).toEqual(as(restorer));
    expect((await read(mover.key, parent)).state_writer).toEqual(as(restorer));
  });

  it("names the requester of a bulk trash, a bulk action and a restore that a bulk action runs", async () => {
    const trasher = await mintKey("bulk trasher");
    const archiver = await mintKey("bulk archiver");
    const tag = `state-writers-${String(Date.now())}`;
    const [a, b] = [
      await createNote(trasher.key, { tags: [tag] }),
      await createNote(trasher.key, { tags: [tag] }),
    ];
    const trashed = await call(trasher.key, "POST", "/items/trash", {
      ids: [a],
    });
    expect(trashed.status, JSON.stringify(trashed.body)).toBe(200);
    expect((await read(trasher.key, a)).state_writer).toEqual(as(trasher));

    const job = await clientOf(archiver).bulkAction({
      action: "transition",
      state: "archived",
      filter: { tags: [tag] },
    });
    expect(job.status, JSON.stringify(job.error)).toBe(202);
    const done = await clientOf(archiver).pollBulkActionToTerminal(
      (job.data as { id: string }).id,
    );
    expect(done.status).toBe("completed");
    const moved = await read(trasher.key, b);
    expect(moved.state).toBe("archived");
    expect(moved.state_writer).toEqual(as(archiver));
    expect((await read(trasher.key, a)).state_writer).toEqual(as(trasher));
  });

  it("answers null for an item the feed-expiry job moved to the bin, and the requester once it is restored", async () => {
    const operator = writerOf(server);
    const type = `user.state-writers-${String(Date.now())}`;
    const registered = await operator.registerType({
      id: type,
      fields: { title: { type: "string" } },
      retention_policy: { feed_days: 2 },
    } as Parameters<MarfaClient["registerType"]>[0]);
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const created = await operator.createItem({
      type,
      tier: "feed",
      properties: { title: "expires" },
    } as Parameters<MarfaClient["createItem"]>[0]);
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    const id = created.data.item.id;
    const asKey = async () =>
      (
        await call(
          server.workingKey,
          "GET",
          `/items/${id}?include=writer&state=any`,
        )
      ).body.item as Answered;

    await clock.advance(3 * DAY_MS);
    const run = await runJob(server, "feed-expiry");
    expect(run.outcome, String(run.error)).toBe("succeeded");
    const expired = await asKey();
    // The witness: the job moved it.
    expect(expired.state).toBe("trashed");
    expect(expired).toHaveProperty("state_writer", null);
    expect(expired.writer).not.toBeNull();

    expect((await operator.restoreItem(id)).status).toBe(200);
    expect((await asKey()).state_writer).not.toBeNull();
  });

  it("leaves it as it was for an update, a patch and an upsert that names a state, and for a transition to the state the item is in", async () => {
    const archiver = await mintKey("keeping archiver");
    const editor = await mintKey("keeping editor");
    const id = await createNote(archiver.key, { source_id: "state-kept-1" });
    expect(
      (await clientOf(archiver).transitionItem(id, "archived")).status,
    ).toBe(200);
    const before = await read(archiver.key, id);
    expect(before.state_writer).toEqual(as(archiver));

    const patched = await call(editor.key, "PATCH", `/items/${id}`, {
      version: 1,
      properties: { body: "second" },
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const afterPatch = await read(archiver.key, id);
    // The witness: the edit landed as a version by the editor.
    expect(afterPatch.version).toBe(2);
    expect(afterPatch.writer).toEqual(as(editor));
    expect(afterPatch.state_writer).toEqual(as(archiver));

    const upserted = await call(editor.key, "POST", "/items", {
      type: "core.note",
      source_id: "state-kept-1",
      state: "active",
      properties: { body: "third" },
    });
    expect(upserted.status, JSON.stringify(upserted.body)).toBeLessThan(300);
    const afterUpsert = await read(archiver.key, id);
    expect(afterUpsert.state).toBe("archived");
    expect(afterUpsert.state_writer).toEqual(as(archiver));

    const same = await call(editor.key, "POST", `/items/${id}/transition`, {
      state: "archived",
    });
    expect(same.status).toBe(400);
    expect((await read(archiver.key, id)).state_writer).toEqual(as(archiver));
  });

  it("leaves it off an item read that does not name writer, and off every other member", async () => {
    const author = await mintKey("quiet state author");
    const id = await createNote(author.key);
    expect((await clientOf(author).transitionItem(id, "archived")).status).toBe(
      200,
    );
    // The witness: the same read names it when asked.
    expect((await read(author.key, id)).state_writer).toEqual(as(author));

    for (const query of [
      "",
      "include=metadata",
      "include=versions,backrefs,neighbors",
    ]) {
      const answer = await call(
        author.key,
        "GET",
        `/items/${id}?state=any${query === "" ? "" : `&${query}`}`,
      );
      expect(answer.status).toBe(200);
      expect(answer.body.item).not.toHaveProperty("state_writer");
      expect(answer.body).not.toHaveProperty("state_writer");
    }
    for (const include of [[], ["metadata", "edges", "extensions"]]) {
      expect((await bulkGet(author.key, [id], include))[0]).not.toHaveProperty(
        "state_writer",
      );
    }
    const listed = await call(
      author.key,
      "GET",
      "/items?include=metadata&state=any",
    );
    expect(listed.status).toBe(200);
    for (const item of listed.body.data as Answered[]) {
      expect(item).not.toHaveProperty("state_writer");
    }
  });

  it("gives a key that may not read the item's type no state writer, and no refusal other than the item's", async () => {
    const mover = await mintKey("closed type mover");
    const narrow = await mintKey("reader of another type", {
      "core.task": "read",
    });
    const wide = await mintKey("reader of the type", { "core.note": "read" });
    const id = await createNote(mover.key);
    expect((await clientOf(mover).transitionItem(id, "archived")).status).toBe(
      200,
    );

    // The witness: a key that reads the type is told.
    expect((await read(wide.key, id)).state_writer).toEqual(as(mover));
    expect((await bulkGet(wide.key, [id]))[0]!.state_writer).toEqual(as(mover));
    const single = await call(
      narrow.key,
      "GET",
      `/items/${id}?include=writer&state=any`,
    );
    expect(single.status).toBe(404);
    expect(JSON.stringify(single.body)).not.toContain(mover.id);
    expect(await bulkGet(narrow.key, [id])).toEqual([]);
  });
});
