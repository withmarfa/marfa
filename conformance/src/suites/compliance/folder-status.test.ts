import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootFreshServer,
  bootRefused,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import { MINUTE_MS, movedClock } from "../../utils/moved-clock.js";
import { HeldLock } from "../../utils/held-lock.js";
import {
  connect,
  issuerOrigin,
  registerApp,
  signIn,
  token as refresh,
} from "../../utils/signed-in.js";
import { validatorFor, type OpenApiDocument } from "../../utils/openapi.js";
import { controlRequest } from "../../utils/control-request.js";
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
  server = await bootFreshServer("folder-status", {
    SQLITE_BUSY_BUDGET_MS: "3000",
  });
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
    const bytes = gunzipSync(Buffer.from(await archive.arrayBuffer()));
    expect(bytes.toString("utf8")).toContain(id);
    expect(bytes.toString("utf8")).not.toContain(folder_store_id);
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
    const unauthorized = await fetch(`${server.apiUrl}/folders/${id}/status`);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
    const invalid = await call("GET", "/folders/not-an-id/status");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: "invalid_id" },
    });
    const missing = await call(
      "PUT",
      "/folders/01920000-0000-7000-8000-000000000000/status",
      report,
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: "item_not_found" },
    });
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
    await new Promise((resolve) => setTimeout(resolve, 1100));
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
    withInstanceDatabase(server.sqlitePath, (db) => {
      db.prepare("UPDATE auth_session SET expires_at=0 WHERE id=?").run(
        current.sign_in.id,
      );
    });
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
    withInstanceDatabase(server.sqlitePath, (db) => {
      db.prepare(
        "UPDATE auth_oauth_access_token SET expires_at=0 WHERE client_id=?",
      ).run(app.clientId);
    });
    expect((await get(id)).sign_ins[0]!.current).toBe(true);
    expect(
      (await call("PUT", `/folders/${id}/status`, report, token.access_token!))
        .status,
    ).toBe(401);
    expect(token.refresh_token).toBeTruthy();
    const refreshed = await refresh(
      server,
      {
        grant_type: "refresh_token",
        refresh_token: token.refresh_token!,
        client_id: app.clientId,
      },
      app,
    );
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
      const lock = await HeldLock.take(server.sqlitePath);
      try {
        const pending = call(
          method,
          `/folders/${id}/status`,
          method === "PUT" ? { ...report, sequence: 2 } : undefined,
          reader.key,
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
        await lock.commit([
          `UPDATE api_keys SET type_permissions='{"core.note":"read"}' WHERE id='${reader.id}'`,
        ]);
        expect((await pending).status).toBe(404);
      } finally {
        await lock.release();
      }
    }
    expect(
      (await get(id)).sign_ins.every((g) => g.copies[0]!.sequence === 1),
    ).toBe(true);
  });
  it("rolls back a failed report replacement and preserves its previous receipt", async () => {
    const id = await folder();
    const first = await put(id);
    withInstanceDatabase(server.sqlitePath, (db) => {
      db.exec(
        "CREATE TRIGGER fail_folder_status BEFORE UPDATE ON folder_status BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END",
      );
    });
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
    } finally {
      withInstanceDatabase(server.sqlitePath, (db) => {
        db.exec("DROP TRIGGER fail_folder_status");
      });
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
      const backup = join(
        mkdtempSync(join(tmpdir(), "folder-health-backup-")),
        "marfa.db",
      );
      try {
        await server.restart(() => {
          copyFileSync(server.sqlitePath, backup);
        });
        expect((await get(id)).sign_ins[0]!.copies[0]!.received_at).toBe(
          ack.received_at,
        );
        await put(id, { ...report, sequence: 2 });
        await server.restart(() => {
          copyFileSync(backup, server.sqlitePath);
        });
        expect((await get(id)).sign_ins[0]!.copies[0]).toMatchObject({
          sequence: 1,
          received_at: ack.received_at,
        });
      } finally {
        rmSync(join(backup, ".."), { recursive: true, force: true });
      }
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );
  it(
    "refuses an old schema without adding a health table or altering its database",
    async () => {
      const backup = join(
        mkdtempSync(join(tmpdir(), "folder-health-schema-")),
        "marfa.db",
      );
      await server.restart(() => {
        copyFileSync(server.sqlitePath, backup);
      });
      const refused = await bootRefused("folder-status-old-schema", {
        prepare: (path) => {
          copyFileSync(backup, path);
          withInstanceDatabase(path, (db) => {
            db.exec("DROP TABLE folder_status");
          });
        },
      });
      try {
        expect(refused.after.db).toBe(refused.before.db);
        expect([
          "absent",
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        ]).toContain(refused.after.wal);
        expect(refused.output).toMatch(/refus|incompatible/i);
      } finally {
        await refused.stop();
        rmSync(join(backup, ".."), { recursive: true, force: true });
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
