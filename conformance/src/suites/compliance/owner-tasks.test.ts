import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  approvedApp,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest } from "../../utils/control-request.js";

/**
 * The owner's tasks, open to any credential that holds the permission each
 * names: the bin, the item and folder listings, an app's grant, the sign-ins
 * and passkeys, what needs attention, the clock and the backups. The owner's
 * whole state is the subject, so the file boots a server of its own, with a
 * backup folder so the backup doors answer past their access check.
 */
let server: FreshServer;
const backups = mkdtempSync(join(tmpdir(), "marfa-owner-tasks-"));
const SOURCE = "owner-tasks";
let minted = 0;

beforeAll(async () => {
  server = await bootFreshServer("owner-tasks", {
    MARFA_BACKUP_PATH: backups,
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
  rmSync(backups, { recursive: true, force: true });
}, FRESH_SERVER_TIMEOUT_MS);

interface Minted {
  id: string;
  key: string;
}

async function mint(body: Record<string, unknown>): Promise<Minted> {
  minted += 1;
  const answer = await controlRequest(server.controlSocket, "/keys", {
    method: "POST",
    body: {
      label: `owner tasks ${String(minted)}`,
      source: `${SOURCE}-${String(minted)}`,
      ...body,
    },
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body as unknown as Minted;
}

async function call(
  credential: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${credential}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>,
  };
}

function local(method: string, path: string, body?: unknown) {
  return controlRequest(server.controlSocket, path, { method, body });
}

/** Each owner task, a request that reaches it, and the permission it takes. */
const TASKS: readonly {
  method: string;
  path: string;
  body?: unknown;
  scope: string;
}[] = [
  { method: "GET", path: "/trash", scope: "items.purge" },
  { method: "POST", path: "/trash/empty", scope: "items.purge" },
  {
    method: "PATCH",
    path: "/grants/no-such-grant",
    body: { scopes: [], expected_scopes: [] },
    scope: "grants.manage",
  },
  { method: "GET", path: "/owner/sign-ins", scope: "sign_ins.manage" },
  {
    method: "PATCH",
    path: "/owner/sign-ins/no-such-sign-in",
    body: { name: "Renamed" },
    scope: "sign_ins.manage",
  },
  {
    method: "DELETE",
    path: "/owner/sign-ins/no-such-sign-in",
    scope: "sign_ins.manage",
  },
  { method: "GET", path: "/owner/passkeys", scope: "sign_ins.manage" },
  {
    method: "PATCH",
    path: "/owner/passkeys/no-such-passkey",
    body: { name: "Renamed" },
    scope: "sign_ins.manage",
  },
  {
    method: "DELETE",
    path: "/owner/passkeys/no-such-passkey",
    scope: "sign_ins.manage",
  },
  { method: "GET", path: "/owner/passkeys/add-url", scope: "sign_ins.manage" },
  { method: "GET", path: "/attention", scope: "instance.read" },
  { method: "POST", path: "/clock/confirm", scope: "instance.maintain" },
  { method: "GET", path: "/backups", scope: "backups.manage" },
  { method: "POST", path: "/backups", scope: "backups.manage" },
  { method: "POST", path: "/backups/folder/adopt", scope: "backups.manage" },
];

const EVERY_TYPE = { type_permissions: { "*": "write" } };

describe("owner tasks", () => {
  it("refuses each owner task to a key that lacks its permission, naming the permission", async () => {
    for (const task of TASKS) {
      // The witness: a key that holds every other permission, so only the
      // one the task names is missing.
      const others = TASKS.map((each) => each.scope).filter(
        (scope) => scope !== task.scope,
      );
      const { key } = await mint({
        ...EVERY_TYPE,
        permissions: [...new Set(others)],
      });
      const refused = await call(key, task.method, task.path, task.body);
      const label = `${task.method} ${task.path}`;
      expect(refused.status, label).toBe(403);
      const error = refused.body.error as {
        code: string;
        details?: Record<string, unknown>;
      };
      expect(error.code, label).toBe("forbidden");
      expect(error.details?.required_scope, label).toBe(task.scope);
    }
  });

  it("lets a key holding each permission do each owner task", async () => {
    const { key } = await mint({
      ...EVERY_TYPE,
      permissions: [...new Set(TASKS.map((task) => task.scope))],
    });
    const statuses = async (path: string, method = "GET", body?: unknown) =>
      (await call(key, method, path, body)).status;
    expect(await statuses("/trash")).toBe(200);
    expect(await statuses("/trash/empty", "POST")).toBe(200);
    expect(await statuses("/owner/sign-ins")).toBe(200);
    expect(await statuses("/owner/passkeys")).toBe(200);
    expect(await statuses("/attention")).toBe(200);
    expect(await statuses("/clock/confirm", "POST")).toBe(200);
    expect(await statuses("/backups")).toBe(200);
    expect(await statuses("/backups", "POST")).toBe(200);
    // The folder holds the store's marker already, so adopting it is a
    // conflict past the access check.
    expect(await statuses("/backups/folder/adopt", "POST")).toBe(409);
    const link = await call(key, "GET", "/owner/passkeys/add-url");
    expect(link.status).toBe(200);
    const url = new URL(link.body.url as string);
    expect(url.pathname).toBe("/auth/sign-in");
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("return_to")).toBe("/auth/owner/passkeys");
  });

  it("lets a key holding sign_ins.manage list and rename another key's sign-in", async () => {
    const other = await mint({});
    const { key } = await mint({ permissions: ["sign_ins.manage"] });
    const listed = await call(key, "GET", "/owner/sign-ins");
    expect(listed.status).toBe(200);
    const ids = (listed.body.data as { id: string }[]).map((row) => row.id);
    expect(ids).toContain(other.id);
    const renamed = await call(key, "PATCH", `/owner/sign-ins/${other.id}`, {
      name: "  Renamed by a key  ",
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.name).toBe("Renamed by a key");
  });

  it("lets a key holding only sign_ins.manage end its own sign-in, and refuses its next request", async () => {
    const own = await mint({ permissions: ["sign_ins.manage"] });
    expect((await call(own.key, "GET", "/owner/sign-ins")).status).toBe(200);
    const ended = await call(own.key, "DELETE", `/owner/sign-ins/${own.id}`);
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(ended.body.ok).toBe(true);
    expect((await call(own.key, "GET", "/owner/sign-ins")).status).toBe(401);
  });

  it("lets an app holding grants.manage narrow another app's grant", async () => {
    const narrowed = await approvedApp(server, ["core.note:write"]);
    const manager = await approvedApp(server, ["grants.manage"]);
    const grants = await call(manager.token, "GET", "/grants");
    expect(grants.status).toBe(200);
    const grant = (
      grants.body.data as { id: string; client_id: string; scopes: string[] }[]
    ).find((row) => row.client_id === narrowed.clientId);
    expect(grant, JSON.stringify(grants.body)).toBeDefined();
    const answer = await call(manager.token, "PATCH", `/grants/${grant!.id}`, {
      scopes: ["core.note:read"],
      expected_scopes: grant!.scopes,
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body.scopes).toEqual(["core.note:read"]);
  });

  it("refuses an owner task to a key narrowed between requests, naming the permission it lost", async () => {
    const held = await mint({ permissions: ["sign_ins.manage", "audit.read"] });
    expect((await call(held.key, "GET", "/owner/sign-ins")).status).toBe(200);
    const narrowed = await local("PATCH", `/keys/${held.id}`, {
      permissions: ["audit.read"],
    });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    const refused = await call(held.key, "GET", "/owner/sign-ins");
    expect(refused.status).toBe(403);
    expect(
      (refused.body.error as { details?: Record<string, unknown> }).details
        ?.required_scope,
    ).toBe("sign_ins.manage");
    // The witness: the key still works where it still reaches.
    expect((await call(held.key, "GET", "/audit?limit=1")).status).toBe(200);
  });

  it("refuses an owner task to an app whose grant was narrowed or revoked between requests", async () => {
    const narrowedApp = await approvedApp(server, [
      "sign_ins.manage",
      "core.note:read",
    ]);
    const revokedApp = await approvedApp(server, ["sign_ins.manage"]);
    for (const app of [narrowedApp, revokedApp]) {
      expect((await call(app.token, "GET", "/owner/sign-ins")).status).toBe(
        200,
      );
    }
    const grants = (await local("GET", "/grants")).body.data as {
      id: string;
      client_id: string;
      scopes: string[];
    }[];
    const grantOf = (clientId: string) =>
      grants.find((row) => row.client_id === clientId)!;
    const narrowing = grantOf(narrowedApp.clientId);
    const narrowed = await local("PATCH", `/grants/${narrowing.id}`, {
      scopes: ["core.note:read"],
      expected_scopes: narrowing.scopes,
    });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    expect(
      (await call(narrowedApp.token, "GET", "/owner/sign-ins")).status,
    ).toBe(401);
    const revoked = await local(
      "DELETE",
      `/grants/${grantOf(revokedApp.clientId).id}`,
    );
    expect(revoked.status).toBe(200);
    expect((await call(revokedApp.token, "GET", "/owner/sign-ins")).status).toBe(
      401,
    );
  });

  it("lists and empties only the bin's items of the types a credential holding items.purge reads", async () => {
    const run = randomUUID();
    const writer = await mint({ ...EVERY_TYPE });
    const binned: Record<string, string> = {};
    for (const type of ["core.note", "core.task"]) {
      const made = await call(writer.key, "POST", "/items", {
        type,
        properties: { title: `binned ${type} ${run}` },
      });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const id = (made.body.item as { id: string }).id;
      binned[type] = id;
      expect((await call(writer.key, "DELETE", `/items/${id}`)).status).toBe(
        200,
      );
    }
    const purger = await mint({
      permissions: ["items.purge"],
      type_permissions: { "core.note": "write" },
    });
    // The witness: the socket lists both.
    const everything = await local("GET", `/trash?q=${run}`);
    expect(
      (everything.body.data as { id: string }[]).map((row) => row.id).sort(),
    ).toEqual(Object.values(binned).sort());
    const listed = await call(purger.key, "GET", `/trash?q=${run}`);
    expect(listed.status).toBe(200);
    expect((listed.body.data as { id: string }[]).map((row) => row.id)).toEqual(
      [binned["core.note"]],
    );
    let cursor: string | null = null;
    do {
      const emptied = await call(
        purger.key,
        "POST",
        `/trash/empty${cursor === null ? "" : `?cursor=${cursor}`}`,
      );
      expect(emptied.status, JSON.stringify(emptied.body)).toBe(200);
      expect(emptied.body.failures).toEqual([]);
      cursor = emptied.body.next_cursor as string | null;
    } while (cursor !== null);
    const left = await local("GET", `/trash?q=${run}`);
    expect((left.body.data as { id: string }[]).map((row) => row.id)).toEqual([
      binned["core.task"],
    ]);
  });

  it("lists item summaries of only the types a credential reads, and refuses one that reads none", async () => {
    const run = randomUUID();
    const writer = await mint({ ...EVERY_TYPE });
    const made: Record<string, string> = {};
    for (const type of ["core.note", "core.task"]) {
      const answer = await call(writer.key, "POST", "/items", {
        type,
        properties: { title: `summary ${type} ${run}` },
      });
      expect(answer.status).toBe(201);
      made[type] = (answer.body.item as { id: string }).id;
    }
    const everything = await local("GET", `/items/summaries?q=${run}`);
    expect(
      (everything.body.data as { id: string }[]).map((row) => row.id).sort(),
    ).toEqual(Object.values(made).sort());
    const reader = await mint({ type_permissions: { "core.note": "read" } });
    const listed = await call(reader.key, "GET", `/items/summaries?q=${run}`);
    expect(listed.status).toBe(200);
    expect((listed.body.data as { id: string }[]).map((row) => row.id)).toEqual(
      [made["core.note"]],
    );
    const none = await mint({ permissions: ["instance.read"] });
    const refused = await call(none.key, "GET", "/items/summaries");
    expect(refused.status).toBe(403);
    expect((refused.body.error as { code: string }).code).toBe(
      "type_not_permitted",
    );
  });

  it("lists folders to a credential that reads system.folder, and refuses one that does not", async () => {
    const reader = await mint({ type_permissions: { "system.folder": "read" } });
    const listed = await call(reader.key, "GET", "/folders");
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(Array.isArray(listed.body.data)).toBe(true);
    const notes = await mint({ type_permissions: { "core.note": "read" } });
    const refused = await call(notes.key, "GET", "/folders");
    expect(refused.status).toBe(403);
    expect((refused.body.error as { code: string }).code).toBe(
      "type_not_permitted",
    );
  });

  it("lets a key holding profile.email:write change the owner's email", async () => {
    const before = await local("GET", "/profile");
    expect(before.status).toBe(200);
    const email = before.body.email as string;
    const { key } = await mint({
      profile_permissions: { email: "write", name: "read" },
    });
    const changed = await call(key, "PATCH", "/profile", {
      email: "Changed.Owner@Example.COM",
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.email).toBe("changed.owner@example.com");
    const reader = await mint({ profile_permissions: { email: "read" } });
    const refused = await call(reader.key, "PATCH", "/profile", {
      email: "another@example.com",
    });
    expect(refused.status).toBe(403);
    expect((await local("PATCH", "/profile", { email })).status).toBe(200);
    expect((await local("GET", "/profile")).body.email).toBe(email);
  });

  it("still answers every owner task on the private socket", async () => {
    for (const [method, path] of [
      ["GET", "/trash"],
      ["POST", "/trash/empty"],
      ["GET", "/owner/sign-ins"],
      ["GET", "/owner/passkeys"],
      ["GET", "/owner/passkeys/add-url"],
      ["GET", "/attention"],
      ["POST", "/clock/confirm"],
      ["GET", "/backups"],
      ["GET", "/folders"],
      ["GET", "/items/summaries"],
      ["GET", "/profile"],
      ["GET", "/grants"],
    ] as const) {
      const answer = await local(method, path);
      expect(answer.status, `${method} ${path} ${JSON.stringify(answer.body)}`).toBe(
        200,
      );
    }
  });
});
