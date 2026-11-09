import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { readLineFile } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  movedClock,
} from "../../utils/moved-clock.js";
import {
  connect,
  issuerOrigin,
  registerApp,
  signIn,
  token as refresh,
} from "../../utils/signed-in.js";
import { validatorFor, type OpenApiDocument } from "../../utils/openapi.js";
import { controlRequest } from "../../utils/control-request.js";
import { parseEnvFile } from "../../utils/target.js";
import { bootServer, stopServer } from "../../../scripts/marfa-server.js";
let document: OpenApiDocument;
async function expectMatchesSchema(
  method: string,
  path: string,
  status: number,
  data: unknown,
) {
  const schema =
    document.paths[path]?.[method.toLowerCase()]?.responses?.[String(status)]
      ?.content?.["application/json"]?.schema;
  expect(schema).toBeDefined();
  const validate = validatorFor(schema, document);
  expect(validate(data), JSON.stringify(validate.errors)).toBe(true);
}

let server: FreshServer;
let clock: ReturnType<typeof movedClock>;
let origin: string;
let number = 0;
const report = {
  folder_store_id: "copy-a",
  sequence: 1,
  last_success_at: null,
  pending_uploads: 2,
  pending_downloads: 3,
  paused_removals: 1,
  first_sync_waiting: true,
  problems: [{ code: "held_file", count: 2 }],
};
interface Status {
  folder_id: string;
  sign_ins: {
    sign_in: { kind: string; id: string; name: string };
    current: boolean;
    copies: (typeof report & { received_at: string; age_seconds: number })[];
  }[];
  totals: {
    pending_uploads: number;
    pending_downloads: number;
    paused_removals: number;
    first_sync_waiting: number;
    saturated: boolean;
    problems: { code: string; count: number }[];
  };
}
interface Ack {
  accepted: boolean;
  sequence: number;
  received_at: string;
}
beforeAll(async () => {
  server = await bootFreshServer("folder-status");
  clock = movedClock(server);
  origin = await issuerOrigin(server);
  document = (await (
    await fetch(`${server.apiUrl}/openapi.json`)
  ).json()) as OpenApiDocument;
}, FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);
function call(
  method: string,
  path: string,
  body?: unknown,
  key = server.workingKey,
  cookie?: string,
): Promise<Response> {
  return fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : { authorization: `Bearer ${key}` }),
      "content-type": "application/json",
      origin,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function folder(): Promise<string> {
  const r = await call("POST", "/folders", { title: "Sync reports" });
  expect(r.status).toBe(201);
  return ((await r.json()) as { item: { id: string } }).item.id;
}
const NO_SUCH_ID = "01920000-0000-7000-8000-000000000000";
async function aNote(): Promise<string> {
  const r = await call("POST", "/items", {
    type: "core.note",
    properties: { body: "Not a folder" },
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { item: { id: string } }).item.id;
}
async function key(
  type_permissions: Record<string, string> = { "system.folder": "read" },
  expires_at?: string,
): Promise<{ id: string; key: string }> {
  number++;
  const r = await call("POST", "/keys", {
    label: "Sync reports",
    source: `folder-status-${number}`,
    type_permissions,
    ...(expires_at === undefined ? {} : { expires_at }),
  });
  expect(r.status).toBe(201);
  return (await r.json()) as { id: string; key: string };
}
async function put(
  id: string,
  value: unknown = report,
  bearer = server.workingKey,
): Promise<Ack> {
  const r = await call("PUT", `/folders/${id}/status`, value, bearer);
  expect(r.status).toBe(200);
  const data = (await r.json()) as Ack;
  await expectMatchesSchema("PUT", "/folders/{id}/status", 200, data);
  return data;
}
async function get(id: string): Promise<Status> {
  const r = await call("GET", `/folders/${id}/status`);
  expect(r.status).toBe(200);
  const data = (await r.json()) as Status;
  await expectMatchesSchema("GET", "/folders/{id}/status", 200, data);
  return data;
}

describe("folder sync reports", () => {
  it("keeps witnessed reports outside portable item archives", async () => {
    const id = await folder();
    const folder_store_id = "portable-archive-witness-copy";
    await put(id, { ...report, folder_store_id });
    expect((await get(id)).sign_ins[0]!.copies[0]!.folder_store_id).toBe(
      folder_store_id,
    );
    const archive = await call("GET", "/export?format=archive");
    expect(archive.status).toBe(200);
    const bytes = new Uint8Array(await archive.arrayBuffer());
    const text = (["instance", "items", "edges"] as const)
      .map((name) => readLineFile(bytes, name))
      .join("\n");
    expect(text).toContain(id);
    expect(text).not.toContain(folder_store_id);
  });
  it("lists active folder summaries for the owner and local command with bounded pages", async () => {
    const firstId = await folder();
    const secondId = await folder();
    const cookie = await signIn(server, origin);
    const ids = new Set<string>();
    let cursor: string | null = null;
    do {
      const response = await call(
        "GET",
        `/folders?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        undefined,
        "",
        cookie,
      );
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        data: { id: string; title: string; created_at: string }[];
        next_cursor: string | null;
      };
      await expectMatchesSchema("GET", "/folders", 200, page);
      expect(page.data.length).toBeLessThanOrEqual(1);
      for (const row of page.data) {
        expect(Object.keys(row).sort()).toEqual(["created_at", "id", "title"]);
        expect(ids.has(row.id)).toBe(false);
        ids.add(row.id);
      }
      cursor = page.next_cursor;
    } while (cursor);
    expect(ids.has(firstId)).toBe(true);
    expect(ids.has(secondId)).toBe(true);
    const fromKey = await call("GET", "/folders");
    expect(fromKey.status).toBe(403);
    expect(await fromKey.json()).toMatchObject({
      error: { code: "forbidden" },
    });
    const noCredential = await fetch(`${server.apiUrl}/folders`);
    expect(noCredential.status).toBe(401);
    expect(await noCredential.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
    expect(
      (await call("GET", "/folders?limit=0", undefined, "", cookie)).status,
    ).toBe(400);
    expect(
      (await call("GET", "/folders?extra=1", undefined, "", cookie)).status,
    ).toBe(400);
    expect(
      (await call("GET", "/folders?cursor=broken", undefined, "", cookie))
        .status,
    ).toBe(400);
    expect((await call("POST", `/folders/${secondId}/revoke`)).status).toBe(
      200,
    );
    const local = await controlRequest(
      server.controlSocket,
      "/folders?limit=200",
    );
    expect(local.status).toBe(200);
    const active = (local.body.data as { id: string }[]).map((row) => row.id);
    expect(active).toContain(firstId);
    expect(active).not.toContain(secondId);
  });
  it("lists folders newest first under a trimmed, collapsed or placeholder title, and refuses an app's token", async () => {
    const wait = () => clock.advance(1_000);
    const made: { id: string; title: string }[] = [];
    for (const [sent, shown] of [
      ["  padded \t  and   spaced  ", "padded and spaced"],
      [" \n\t ", "Untitled folder"],
      ["plain", "plain"],
    ] as const) {
      const r = await call("POST", "/folders", { title: sent });
      expect(r.status, JSON.stringify(sent)).toBe(201);
      made.push({
        id: ((await r.json()) as { item: { id: string } }).item.id,
        title: shown,
      });
      await wait();
    }
    const newestFirst = [...made].reverse();
    const cookie = await signIn(server, origin);

    const owner = await call(
      "GET",
      "/folders?limit=200",
      undefined,
      "",
      cookie,
    );
    expect(owner.status).toBe(200);
    const rows = (
      (await owner.json()) as {
        data: { id: string; title: string; created_at: string }[];
      }
    ).data;
    expect(
      rows.filter((row) => made.some((m) => m.id === row.id)),
      "owner",
    ).toMatchObject(newestFirst);
    const created = rows.map((row) => row.created_at);
    expect(created, "newest first").toEqual([...created].sort().reverse());

    // The same order by single-row pages, which a Set would not show.
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await call(
        "GET",
        `/folders?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        undefined,
        "",
        cookie,
      );
      const page = (await response.json()) as {
        data: { id: string }[];
        next_cursor: string | null;
      };
      paged.push(...page.data.map((row) => row.id));
      cursor = page.next_cursor;
    } while (cursor);
    expect(paged.filter((id) => made.some((m) => m.id === id))).toEqual(
      newestFirst.map((m) => m.id),
    );

    const local = await controlRequest(
      server.controlSocket,
      "/folders?limit=200",
    );
    expect(local.status).toBe(200);
    expect(
      (local.body.data as { id: string; title: string }[]).filter((row) =>
        made.some((m) => m.id === row.id),
      ),
    ).toMatchObject(newestFirst);

    // The witness: the app holds the permission the folder's own reads need,
    // and the token works there, so the refusal is the inventory's.
    const app = await registerApp(server, "system.folder:read");
    const delegated = (
      await connect(server, origin, cookie, app, "system.folder:read")
    ).access_token!;
    const witness = await call(
      "GET",
      `/folders/${made[0]!.id}/status`,
      undefined,
      delegated,
    );
    expect(witness.status).toBe(200);
    const refused = await call("GET", "/folders", undefined, delegated);
    expect(refused.status).toBe(403);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe("forbidden");
  });
  it("allows a local command to read but refuses a report without a sign-in", async () => {
    const id = await folder();
    await put(id);
    expect(
      (await controlRequest(server.controlSocket, `/folders/${id}/status`))
        .status,
    ).toBe(200);
    const refused = await controlRequest(
      server.controlSocket,
      `/folders/${id}/status`,
      { method: "PUT", body: report },
    );
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: { code: "forbidden" } });
    expect((await get(id)).sign_ins).toHaveLength(1);
  });
  it("refuses a local command's invalid report and missing folder before its lack of a sign-in", async () => {
    const id = await folder();
    const note = await aNote();
    for (const [path, body, status, code] of [
      [id, report, 403, "forbidden"],
      [id, {}, 400, "missing_required_field"],
      [id, { ...report, folder_store_id: "/x" }, 400, "validation_error"],
      ["not-an-id", report, 400, "invalid_id"],
      [NO_SUCH_ID, report, 404, "item_not_found"],
      [note, report, 404, "item_not_found"],
    ] as const) {
      const answer = await controlRequest(
        server.controlSocket,
        `/folders/${path}/status`,
        { method: "PUT", body },
      );
      expect(answer.status, `${path} ${code}`).toBe(status);
      expect(answer.body).toMatchObject({ error: { code } });
    }
    expect((await get(id)).sign_ins).toEqual([]);
  });
  it("answers item_not_found to the owner and a local command for an ID that holds no folder", async () => {
    const id = await folder();
    const note = await aNote();
    const cookie = await signIn(server, origin);
    const asOwner = (target: string) =>
      call("GET", `/folders/${target}/status`, undefined, "", cookie);
    const asLocal = (target: string) =>
      controlRequest(server.controlSocket, `/folders/${target}/status`);
    expect((await asOwner(id)).status).toBe(200);
    expect((await asLocal(id)).status).toBe(200);
    for (const target of [NO_SUCH_ID, note]) {
      const owner = await asOwner(target);
      expect(owner.status).toBe(404);
      expect(await owner.json()).toMatchObject({
        error: { code: "item_not_found" },
      });
      const local = await asLocal(target);
      expect(local.status).toBe(404);
      expect(local.body).toMatchObject({ error: { code: "item_not_found" } });
    }
    const ownerPut = await call(
      "PUT",
      `/folders/${NO_SUCH_ID}/status`,
      report,
      "",
      cookie,
    );
    expect(ownerPut.status).toBe(404);
    expect(await ownerPut.json()).toMatchObject({
      error: { code: "item_not_found" },
    });
  });
  it("keeps taking and answering reports for a revoked folder", async () => {
    const id = await folder();
    await put(id);
    const revoked = await call("POST", `/folders/${id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(
      ((await revoked.json()) as { item: { state: string } }).item.state,
    ).toBe("revoked");
    const reader = await key();
    const ack = await put(id, { ...report, sequence: 2 });
    expect(ack).toMatchObject({ accepted: true, sequence: 2 });
    expect(
      await put(id, { ...report, folder_store_id: "copy-b" }, reader.key),
    ).toMatchObject({ accepted: true, sequence: 1 });
    const status = await get(id);
    expect(status.sign_ins.map((group) => group.copies[0]!.sequence)).toEqual(
      expect.arrayContaining([2, 1]),
    );
    expect(status.sign_ins).toHaveLength(2);
  });
  it("takes a copy ID of 1 to 128 letters, digits, hyphens and underscores and refuses any other", async () => {
    const id = await folder();
    const longest = "a".repeat(128);
    for (const accepted of [
      "a",
      longest,
      "AZaz09_-",
      "01920000-0000-7000-8000-000000000000",
    ]) {
      expect(
        await put(id, { ...report, folder_store_id: accepted }),
        accepted,
      ).toMatchObject({ accepted: true });
    }
    const before = await get(id);
    expect(before.sign_ins[0]!.copies.map((c) => c.folder_store_id)).toContain(
      longest,
    );
    for (const refused of [
      "",
      "a".repeat(129),
      "a b",
      "a.b",
      "a/b",
      "café",
      "a\n",
    ]) {
      const r = await call("PUT", `/folders/${id}/status`, {
        ...report,
        folder_store_id: refused,
      });
      expect(r.status, JSON.stringify(refused)).toBe(400);
      expect(await r.json()).toMatchObject({
        error: { code: "validation_error" },
      });
    }
    expect((await get(id)).sign_ins[0]!.copies).toHaveLength(
      before.sign_ins[0]!.copies.length,
    );
  });
  it("orders sign-ins by kind and ID and total problems as they first appear", async () => {
    const id = await folder();
    const [low, high] = [await key(), await key()].sort((a, b) =>
      a.id < b.id ? -1 : 1,
    );
    const cookie = await signIn(server, origin);
    const app = await registerApp(server, "system.folder:read");
    const token = await connect(
      server,
      origin,
      cookie,
      app,
      "system.folder:read",
    );
    const reporting = (problems: { code: string; count: number }[]) => ({
      ...report,
      problems,
    });
    // Reported in the reverse of the order they are listed in, so neither
    // order below can be the order the reports arrived in.
    await put(
      id,
      reporting([
        { code: "refused", count: 1 },
        { code: "held_file", count: 1 },
      ]),
      high!.key,
    );
    await put(
      id,
      reporting([
        { code: "settings_invalid", count: 1 },
        { code: "refused", count: 1 },
      ]),
      low!.key,
    );
    const browser = await call(
      "PUT",
      `/folders/${id}/status`,
      reporting([
        { code: "held_file", count: 2 },
        { code: "conflict", count: 1 },
      ]),
      "",
      cookie,
    );
    expect(browser.status).toBe(200);
    await put(
      id,
      reporting([{ code: "unavailable", count: 1 }]),
      token.access_token!,
    );

    const status = await get(id);
    expect(status.sign_ins.map((group) => group.sign_in.kind)).toEqual([
      "app",
      "browser",
      "key",
      "key",
    ]);
    expect(status.sign_ins[2]!.sign_in.id).toBe(low!.id);
    expect(status.sign_ins[3]!.sign_in.id).toBe(high!.id);
    expect(status.totals.problems).toEqual([
      { code: "unavailable", count: 1 },
      { code: "held_file", count: 3 },
      { code: "conflict", count: 1 },
      { code: "settings_invalid", count: 1 },
      { code: "refused", count: 2 },
    ]);
  });
  it("orders copies by latest receipt, and copies received together by copy ID", async () => {
    const id = await folder();
    const copies = async () =>
      (await get(id)).sign_ins[0]!.copies.map((c) => c.folder_store_id);
    const wait = () => clock.advance(1_000);
    await put(id, { ...report, folder_store_id: "copy-a" });
    await wait();
    await put(id, { ...report, folder_store_id: "copy-b" });
    expect(await copies()).toEqual(["copy-b", "copy-a"]);
    await wait();
    await put(id, { ...report, folder_store_id: "copy-a", sequence: 2 });
    expect(await copies()).toEqual(["copy-a", "copy-b"]);

    await clock.pause();
    try {
      await put(id, { ...report, folder_store_id: "copy-z" });
      await put(id, { ...report, folder_store_id: "copy-y" });
      const listed = (await get(id)).sign_ins[0]!.copies;
      expect(listed[0]!.received_at).toBe(listed[1]!.received_at);
      expect(listed.map((c) => c.folder_store_id)).toEqual([
        "copy-y",
        "copy-z",
        "copy-a",
        "copy-b",
      ]);
    } finally {
      await clock.resume();
    }
  });
  it("pages the folder inventory 50 at a time unless a limit from 1 to 200 is named", async () => {
    const cookie = await signIn(server, origin);
    const asOwner = (query: string) =>
      call("GET", `/folders${query}`, undefined, "", cookie);
    interface Page {
      data: { id: string }[];
      next_cursor: string | null;
    }
    const made = new Set<string>();
    for (let index = 0; index < 51; index++) made.add(await folder());

    const standard = await asOwner("");
    expect(standard.status).toBe(200);
    const first = (await standard.json()) as Page;
    expect(first.data).toHaveLength(50);
    expect(first.next_cursor).not.toBeNull();
    const local = await controlRequest(server.controlSocket, "/folders");
    expect(local.body.data as unknown[]).toHaveLength(50);

    const two = (await (await asOwner("?limit=2")).json()) as Page;
    expect(two.data).toHaveLength(2);

    const whole = await asOwner("?limit=200");
    expect(whole.status).toBe(200);
    const wholePage = (await whole.json()) as Page;
    expect(wholePage.data.length).toBeGreaterThan(50);
    expect(wholePage.data.length).toBeLessThanOrEqual(200);

    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor
        ? `?limit=20&cursor=${encodeURIComponent(cursor)}`
        : "?limit=20";
      const answer = await asOwner(query);
      expect(answer.status).toBe(200);
      const page = (await answer.json()) as Page;
      walked.push(...page.data.map((row) => row.id));
      cursor = page.next_cursor;
    } while (cursor);
    expect(new Set(walked).size).toBe(walked.length);
    for (const id of made) expect(walked).toContain(id);

    for (const limit of ["0", "201", "abc", "1.5"]) {
      const refused = await asOwner(`?limit=${limit}`);
      expect(refused.status, String(limit)).toBe(400);
      expect(await refused.json()).toMatchObject({
        error: {
          code: "validation_error",
          details: { errors: [{ path: "limit" }] },
        },
      });
    }

    await aNote();
    await aNote();
    const otherOrdering = (await (
      await call("GET", "/items?limit=1&sort=updated_at")
    ).json()) as Page;
    expect(otherOrdering.next_cursor).not.toBeNull();
    for (const refused of ["broken", otherOrdering.next_cursor!]) {
      const answer = await asOwner(`?cursor=${encodeURIComponent(refused)}`);
      expect(answer.status, refused).toBe(400);
      expect(await answer.json()).toMatchObject({
        error: { code: "validation_error" },
      });
    }
  });
  it("groups multiple copies under their canonical sign-ins and counts current observations", async () => {
    const id = await folder();
    const a = await key();
    const b = await key();
    await put(id, report, a.key);
    await put(
      id,
      {
        ...report,
        folder_store_id: "copy-b",
        last_success_at: "2026-10-03T09:30:00.000Z",
      },
      a.key,
    );
    await put(id, report, b.key);
    const status = await get(id);
    expect(status.sign_ins).toHaveLength(2);
    expect(
      status.sign_ins.find((g) => g.sign_in.id === a.id)?.copies,
    ).toHaveLength(2);
    expect(status.sign_ins.map((g) => g.sign_in.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(status.totals).toMatchObject({
      pending_uploads: 6,
      pending_downloads: 9,
      paused_removals: 3,
      first_sync_waiting: 3,
      saturated: false,
      problems: [{ code: "held_file", count: 6 }],
    });
    expect(
      status.sign_ins.every((g) => g.current && g.sign_in.kind === "key"),
    ).toBe(true);
    expect(status.sign_ins[0]!.copies[0]!.age_seconds).toBeGreaterThanOrEqual(
      0,
    );
  });
  it("allows a read-only follower to report and hides a folder from a credential that cannot read it", async () => {
    const id = await folder();
    const reader = await key();
    const denied = await key({ "core.note": "read" });
    await put(id, report, reader.key);
    expect(
      (await call("GET", `/folders/${id}/status`, undefined, reader.key))
        .status,
    ).toBe(200);
    for (const method of ["GET", "PUT"]) {
      const r = await call(
        method,
        `/folders/${id}/status`,
        method === "PUT" ? report : undefined,
        denied.key,
      );
      expect(r.status).toBe(404);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
        "item_not_found",
      );
    }
    expect((await get(id)).sign_ins).toHaveLength(1);
  });
  it("answers distinct authentication, malformed-ID, missing-folder, and malformed-report refusals", async () => {
    const id = await folder();
    const note = await aNote();
    const write = (method: string) =>
      method === "PUT"
        ? {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(report),
          }
        : { method };
    for (const method of ["GET", "PUT"]) {
      const unauthorized = await fetch(
        `${server.apiUrl}/folders/${id}/status`,
        write(method),
      );
      expect(unauthorized.status, method).toBe(401);
      expect(await unauthorized.json()).toMatchObject({
        error: { code: "unauthorized" },
      });
      const body = method === "PUT" ? report : undefined;
      const invalid = await call(method, "/folders/not-an-id/status", body);
      expect(invalid.status, method).toBe(400);
      expect(await invalid.json()).toMatchObject({
        error: { code: "invalid_id" },
      });
      for (const target of [NO_SUCH_ID, note]) {
        const missing = await call(method, `/folders/${target}/status`, body);
        expect(missing.status, method).toBe(404);
        expect(await missing.json()).toMatchObject({
          error: { code: "item_not_found" },
        });
      }
    }
    const empty = await key({});
    for (const method of ["GET", "PUT"]) {
      const forbidden = await call(
        method,
        `/folders/${id}/status`,
        method === "PUT" ? report : undefined,
        empty.key,
      );
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toMatchObject({
        error: { code: "type_not_permitted" },
      });
    }
    const r = await call("PUT", `/folders/${id}/status`, {});
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      "missing_required_field",
    );
  });
  it("rejects caller identities, file details, unknown codes, and unsafe counts without changing the report", async () => {
    const id = await folder();
    await put(id);
    for (const patch of [
      { sign_in: { id: "other", kind: "key" } },
      { sign_in_id: "other" },
      { received_at: "2026-10-03T09:30:00.000Z" },
      { online: true },
      { source: "other" },
      { path: "private/file.md" },
      { content: "private" },
      { item_id: "other" },
      { hash: "private" },
      { problems: [{ code: "raw error text", count: 1 }] },
      { problems: [{ code: "held_file", count: 1, message: "private" }] },
      {
        problems: [
          { code: "held_file", count: 1 },
          { code: "held_file", count: 2 },
        ],
      },
      { sequence: 9007199254740992 },
      { pending_uploads: 9007199254740992 },
      { folder_store_id: "a".repeat(129) },
      { sequence: 0 },
      { pending_uploads: -1 },
      { pending_downloads: 0.5 },
      { last_success_at: "2026-02-30T09:30:00.000Z" },
      { last_success_at: "2026-10-03T09:30:00Z" },
      { last_success_at: "2026-10-03T09:30:00.00Z" },
      { last_success_at: "2026-10-03T09:30:00.000+00:00" },
      { last_success_at: "2026-10-03T10:30:00.000+01:00" },
      { last_success_at: "2026-10-03T09:30:00.000" },
      { last_success_at: "2026-10-03" },
      { last_success_at: "2026-10-03T09:30:00.000z" },
      { last_success_at: "" },
      { folder_store_id: "/private/path" },
    ]) {
      const r = await call("PUT", `/folders/${id}/status`, {
        ...report,
        sequence: 2,
        ...patch,
      });
      expect(r.status, JSON.stringify(patch)).toBe(400);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
        "validation_error",
      );
    }
    expect((await get(id)).sign_ins[0]!.copies[0]!.sequence).toBe(1);
  });
  it("leaves newer reports and their receipt unchanged on equal and delayed retries", async () => {
    const id = await folder();
    const first = await put(id, { ...report, sequence: 9 });
    await clock.advance(1_100);
    for (const sequence of [9, 2])
      expect(
        await put(id, { ...report, sequence, pending_uploads: 999 }),
      ).toEqual({ ...first, accepted: false });
    const status = await get(id);
    expect(status.sign_ins[0]!.copies[0]!.age_seconds).toBeGreaterThanOrEqual(
      1,
    );
    expect(status.sign_ins[0]!.copies[0]).toMatchObject({
      sequence: 9,
      pending_uploads: 2,
      received_at: first.received_at,
    });
    expect(
      await put(id, { ...report, sequence: 10, pending_uploads: 0 }),
    ).toMatchObject({ accepted: true, sequence: 10 });
  });
  it("retains revoked and expired key reports immediately as history and excludes them from totals", async () => {
    const id = await folder();
    const revoked = await key();
    // Expires in a minute of the server's clock. The move below is two
    // minutes, short enough that the sign-in tokens other cases make stay
    // within their lifetime.
    const expired = await key(
      undefined,
      new Date(clock.now() + MINUTE_MS).toISOString(),
    );
    await put(id, report, revoked.key);
    await put(id, report, expired.key);
    expect((await get(id)).totals.pending_uploads).toBe(4);
    expect((await call("DELETE", `/keys/${revoked.id}`)).status).toBe(200);
    await clock.advance(2 * MINUTE_MS);
    const status = await get(id);
    expect(status.sign_ins).toHaveLength(2);
    expect(status.sign_ins.every((g) => !g.current)).toBe(true);
    expect(status.totals.pending_uploads).toBe(0);
    expect(
      (
        await call(
          "PUT",
          `/folders/${id}/status`,
          { ...report, sequence: 2 },
          expired.key,
        )
      ).status,
    ).toBe(401);
  });
  it("uses the browser session identity and makes its reports historical after logout or expiry", async () => {
    const id = await folder();
    const cookie = await signIn(server, origin);
    const r = await call("PUT", `/folders/${id}/status`, report, "", cookie);
    expect(r.status).toBe(200);
    const browser = (await get(id)).sign_ins[0]!;
    expect(browser.sign_in.kind).toBe("browser");
    expect(browser.current).toBe(true);
    const listed = await call("GET", "/owner/sign-ins", undefined, "", cookie);
    const own = (
      (await listed.json()) as { data: { id: string; current: boolean }[] }
    ).data.find((v) => v.current)!;
    expect(browser.sign_in.id).toBe(own.id);
    expect((await call("POST", "/auth/sign-out", {}, "", cookie)).status).toBe(
      200,
    );
    expect((await get(id)).sign_ins[0]!.current).toBe(false);
    const cookie2 = await signIn(server, origin);
    expect(
      (await call("PUT", `/folders/${id}/status`, report, "", cookie2)).status,
    ).toBe(200);
    const current = (await get(id)).sign_ins.find((g) => g.current)!;
    // A session ends a week and a minute after its last use.
    expect(current.current).toBe(true);
    await clock.advance(8 * DAY_MS);
    expect((await get(id)).sign_ins.every((g) => !g.current)).toBe(true);
  });
  it("uses the app grant identity across token refresh and retains history after grant revocation", async () => {
    const id = await folder();
    const cookie = await signIn(server, origin);
    const app = await registerApp(server, "system.folder:read offline_access");
    const token = await connect(
      server,
      origin,
      cookie,
      app,
      "system.folder:read offline_access",
    );
    await put(id, report, token.access_token!);
    const before = (await get(id)).sign_ins[0]!;
    expect(before.sign_in.kind).toBe("app");
    // The access token lives an hour. The grant it came from stands.
    await clock.advance(2 * HOUR_MS);
    expect((await get(id)).sign_ins[0]!.current).toBe(true);
    expect(
      (await call("PUT", `/folders/${id}/status`, report, token.access_token!))
        .status,
    ).toBe(401);
    expect(token.refresh_token).toBeTruthy();
    const refreshed = await refresh(server, {
      grant_type: "refresh_token",
      refresh_token: token.refresh_token!,
      client_id: app.clientId,
    });
    expect(refreshed.status).toBe(200);
    await put(id, { ...report, sequence: 2 }, refreshed.body.access_token!);
    const afterRefresh = await get(id);
    expect(afterRefresh.sign_ins).toHaveLength(1);
    expect(afterRefresh.sign_ins[0]!.sign_in.id).toBe(before.sign_in.id);
    expect(afterRefresh.sign_ins[0]!.copies[0]!.sequence).toBe(2);
    const ended = await call("DELETE", `/auth/grants/${before.sign_in.id}`);
    expect(ended.status).toBe(204);
    const after = await get(id);
    expect(after.sign_ins[0]!.current).toBe(false);
    expect(after.sign_ins[0]!.copies).toHaveLength(1);
    expect(after.totals.pending_uploads).toBe(0);
  });
  it("checks current folder read authority after writer admission", async () => {
    const id = await folder();
    for (const method of ["GET", "PUT"]) {
      const reader = await key();
      await put(id, report, reader.key);
      await server.setFault("hold:admission=1");
      const pending = call(
        method,
        `/folders/${id}/status`,
        method === "PUT" ? { ...report, sequence: 2 } : undefined,
        reader.key,
      );
      await server.waitForHold("hold:admission");
      const narrowed = await call("PATCH", `/keys/${reader.id}`, {
        type_permissions: { "core.note": "read" },
      });
      expect(narrowed.status).toBe(200);
      await server.clearFault("hold:admission");
      expect((await pending).status).toBe(404);
    }
    expect(
      (await get(id)).sign_ins.every((g) => g.copies[0]!.sequence === 1),
    ).toBe(true);
  });
  it("rolls back a failed report replacement and preserves its previous receipt", async () => {
    const id = await folder();
    const first = await put(id);
    await server.setFault("fail:folder-status-report");
    try {
      expect(
        (
          await call("PUT", `/folders/${id}/status`, {
            ...report,
            sequence: 2,
            pending_uploads: 0,
          })
        ).status,
      ).toBe(500);
      expect(
        (await server.faults()).find(
          (fault) => fault.name === "fail:folder-status-report",
        )?.fired,
      ).toBe(1);
    } finally {
      await server.clearFault("fail:folder-status-report");
    }
    expect((await get(id)).sign_ins[0]!.copies[0]).toMatchObject({
      sequence: 1,
      pending_uploads: 2,
      received_at: first.received_at,
    });
  });
  it("bounds aggregate totals without rounding a per-copy count", async () => {
    const id = await folder();
    const large = {
      ...report,
      pending_uploads: Number.MAX_SAFE_INTEGER,
      problems: [{ code: "held_file", count: Number.MAX_SAFE_INTEGER }],
    };
    await put(id, large);
    await put(id, { ...large, folder_store_id: "copy-b" });
    const status = await get(id);
    expect(status.totals).toMatchObject({
      saturated: true,
      pending_uploads: Number.MAX_SAFE_INTEGER,
      problems: [{ code: "held_file", count: Number.MAX_SAFE_INTEGER }],
    });
    expect(
      status.sign_ins[0]!.copies.every(
        (c) => c.pending_uploads === Number.MAX_SAFE_INTEGER,
      ),
    ).toBe(true);
  });
  it(
    "retains reports through restart and restoring a physical database backup",
    async () => {
      const id = await folder();
      const ack = await put(id);
      const image = await server.image();
      try {
        await server.restart();
        expect((await get(id)).sign_ins[0]!.copies[0]!.received_at).toBe(
          ack.received_at,
        );
        await put(id, { ...report, sequence: 2 });
        await bootServer({ state: image });
        const env = parseEnvFile(readFileSync(`${image}/env`, "utf8"));
        const restored = await fetch(
          `${env.MARFA_API_URL}/folders/${id}/status`,
          { headers: { authorization: `Bearer ${server.workingKey}` } },
        );
        expect(restored.status).toBe(200);
        expect(
          ((await restored.json()) as Status).sign_ins[0]!.copies[0],
        ).toMatchObject({ sequence: 1, received_at: ack.received_at });
      } finally {
        await stopServer({ state: image });
        rmSync(image, { recursive: true, force: true });
      }
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );
});
