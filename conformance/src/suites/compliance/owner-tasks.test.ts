import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import {
  approvedApp,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest } from "../../utils/control-request.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import {
  callTool,
  connectMcp,
  toolError,
  toolResult,
  type McpConnection,
  type ToolAnswer,
} from "../../utils/mcp.js";
import { tempFolder } from "../../utils/temp-folder.js";
import { waitFor } from "../../utils/wait.js";

/**
 * The owner's tasks, open to any credential that holds the permission each
 * names: the bin, the item and folder listings, an app's grant, the sign-ins
 * and passkeys, what needs attention, the clock and the backups. The owner's
 * whole state is the subject, so the file boots a server of its own, with a
 * backup folder so the backup doors answer past their access check.
 */
let server: FreshServer;
const backups = tempFolder("marfa-owner-tasks-");
const SOURCE = "owner-tasks";
let minted = 0;

beforeAll(async () => {
  server = await bootFreshServer("owner-tasks", {
    MARFA_OBJECT_STORE_BUCKET: "",
    MARFA_BACKUP_PATH: backups,
    MARFA_BACKUP_INTERVAL_SECONDS: "0",
  });
}, FRESH_SERVER_TIMEOUT_MS);

const connections: McpConnection[] = [];

afterAll(async () => {
  await Promise.all(connections.map((connection) => connection.close()));
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
  {
    method: "PUT",
    path: "/owner/password",
    body: { current_password: "not used", new_password: "not used either" },
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
    const confirmed = await call(key, "POST", "/clock/confirm");
    expect(confirmed.status).toBe(200);
    await expectMatchesSchema("POST", "/clock/confirm", 200, confirmed.body);
    expect(await statuses("/backups")).toBe(200);
    expect(await statuses("/backups", "POST")).toBe(200);
    // The folder holds the store's marker already, so adopting it is a
    // conflict past the access check.
    expect(await statuses("/backups/folder/adopt", "POST")).toBe(409);
    const link = await call(key, "GET", "/owner/passkeys/add-url");
    expect(link.status).toBe(200);
    await expectMatchesSchema("GET", "/owner/passkeys/add-url", 200, link.body);
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
    expect(
      (await call(revokedApp.token, "GET", "/owner/sign-ins")).status,
    ).toBe(401);
  });

  it("lists and empties only the bin's items of the types a credential holding items.purge writes, leaving those it only reads", async () => {
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
      type_permissions: { "core.note": "write", "core.task": "read" },
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
    const reader = await mint({
      type_permissions: { "system.folder": "read" },
    });
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

  it("lists only the folders a credential's source filter admits, as the item listing does", async () => {
    const run = randomUUID();
    const made: string[] = [];
    const sources: string[] = [];
    for (const side of ["kept", "filtered"]) {
      const writer = await mint({
        type_permissions: { "system.folder": "write" },
      });
      const key = await call(writer.key, "GET", "/keys/current");
      sources.push(key.body.source as string);
      const folder = await call(writer.key, "POST", "/folders", {
        title: `${side} ${run}`,
      });
      expect(folder.status, JSON.stringify(folder.body)).toBe(201);
      made.push((folder.body.item as { id: string }).id);
    }
    const ours = (body: Record<string, unknown>) =>
      (body.data as { id: string }[])
        .map((row) => row.id)
        .filter((id) => made.includes(id))
        .sort();
    // The witness: a reader with no filter lists both.
    const open = await mint({ type_permissions: { "system.folder": "read" } });
    const both = await call(open.key, "GET", "/folders?limit=200");
    expect(both.status).toBe(200);
    expect(ours(both.body)).toEqual([...made].sort());
    const filtered = await mint({
      type_permissions: { "system.folder": "read" },
      enforcement_override: {
        source_filter: { types: ["system.folder"], sources: [sources[0]] },
      },
    });
    const items = await call(
      filtered.key,
      "GET",
      "/items?type=system.folder&limit=200",
    );
    expect(items.status, JSON.stringify(items.body)).toBe(200);
    expect(ours(items.body)).toEqual([made[0]]);
    const listed = await call(filtered.key, "GET", "/folders?limit=200");
    expect(listed.status).toBe(200);
    expect(ours(listed.body)).toEqual([made[0]]);
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

  it(
    "puts no backup for a key revoked before the backup's upload begins",
    { retry: 0 },
    async () => {
      // retry: 0 because a failed try leaves the hold set.
      const backupsNow = async () =>
        ((await local("GET", "/backups")).body.data as { name: string }[])
          .length;
      const witness = await mint({ permissions: ["backups.manage"] });
      const first = await backupsNow();
      expect((await call(witness.key, "POST", "/backups")).status).toBe(200);
      expect(await backupsNow()).toBe(first + 1);

      const revoked = await mint({ permissions: ["backups.manage"] });
      const before = await backupsNow();
      await server.setFault("hold:backup:read");
      const pending = call(revoked.key, "POST", "/backups");
      await server.waitForHold("hold:backup:read");
      expect((await local("DELETE", `/keys/${revoked.id}`)).status).toBe(200);
      await server.clearFault("hold:backup:read");
      const answer = await pending;
      expect(answer.status, JSON.stringify(answer.body)).toBe(401);
      expect(await backupsNow()).toBe(before);
    },
  );

  it(
    "records no backup for a key revoked while its backup uploads",
    { retry: 0 },
    async () => {
      // retry: 0 because a failed try leaves the hold set.
      const lastBackup = async () =>
        (
          (await local("GET", "/health")).body.backups as {
            last_backup?: string;
          }
        ).last_backup;
      const listed = async () => {
        const answer = await local("GET", "/backups");
        expect(answer.status, JSON.stringify(answer.body)).toBe(200);
        return (answer.body.data as { name: string }[]).map(
          (backup) => backup.name,
        );
      };
      const witness = await mint({ permissions: ["backups.manage"] });
      const put = await call(witness.key, "POST", "/backups");
      expect(put.status).toBe(200);
      const first = (put.body.backup as { name: string }).name;
      expect(await lastBackup()).toBe(first);
      const before = await listed();
      expect(before).toContain(first);

      const revoked = await mint({ permissions: ["backups.manage"] });
      await server.setFault("hold:backup:put");
      const pending = call(revoked.key, "POST", "/backups");
      await server.waitForHold("hold:backup:put");
      expect((await local("DELETE", `/keys/${revoked.id}`)).status).toBe(200);
      await server.clearFault("hold:backup:put");
      const answer = await pending;
      expect(answer.status, JSON.stringify(answer.body)).toBe(401);
      expect(await lastBackup()).toBe(first);
      expect(await listed()).toEqual(before);

      const next = await call(witness.key, "POST", "/backups");
      expect(next.status, JSON.stringify(next.body)).toBe(200);
      const second = (next.body.backup as { name: string }).name;
      expect(await lastBackup()).toBe(second);
      expect(await listed()).toEqual([second, ...before]);
    },
  );

  it(
    "counts the failed run when the backup folder fails a backup whose key was revoked while it uploads",
    { retry: 0 },
    async () => {
      // retry: 0 because a failed try leaves the hold set.
      const backups = async () =>
        (await local("GET", "/health")).body.backups as {
          failures: number;
          last_error: string | null;
        };
      const listed = async () =>
        ((await local("GET", "/backups")).body.data as { name: string }[]).map(
          (backup) => backup.name,
        );
      const witness = await mint({ permissions: ["backups.manage"] });
      expect((await call(witness.key, "POST", "/backups")).status).toBe(200);
      expect(await backups()).toMatchObject({ failures: 0, last_error: null });
      const before = await listed();

      const revoked = await mint({ permissions: ["backups.manage"] });
      await server.setFault("hold:backup:put");
      const pending = call(revoked.key, "POST", "/backups");
      try {
        await server.waitForHold("hold:backup:put");
        expect((await local("DELETE", `/keys/${revoked.id}`)).status).toBe(200);
        await server.setFault("fail:backup-folder-write");
      } finally {
        await server.clearFault("hold:backup:put");
      }
      const answer = await pending;
      await server.clearFault("fail:backup-folder-write");
      expect(answer.status, JSON.stringify(answer.body)).toBe(401);
      const failed = await backups();
      expect(failed.failures).toBe(1);
      expect(failed.last_error).toContain("backup folder");
      expect(await listed()).toEqual(before);

      const next = await call(witness.key, "POST", "/backups");
      expect(next.status, JSON.stringify(next.body)).toBe(200);
      const name = (next.body.backup as { name: string }).name;
      expect(await listed()).toEqual([name, ...before]);
      expect(await backups()).toMatchObject({ failures: 0 });
    },
  );

  it(
    "starts no housekeeping run for a key revoked before the run is claimed",
    { retry: 0 },
    async () => {
      // retry: 0 because a failed try leaves the hold set.
      const JOB = "attention-check";
      const started = async () =>
        (
          (await local("GET", "/housekeeping")).body.data as {
            name: string;
            last_started_at: string | null;
          }[]
        ).find((job) => job.name === JOB)?.last_started_at;
      const witness = await mint({ permissions: ["instance.maintain"] });
      const ran = await call(witness.key, "POST", `/housekeeping/${JOB}/run`);
      expect(ran.status, JSON.stringify(ran.body)).toBe(200);
      const before = await started();
      expect(before).toBe(ran.body.started_at);

      const revoked = await mint({ permissions: ["instance.maintain"] });
      await server.setFault("hold:write=housekeeping.claim@1");
      const pending = call(revoked.key, "POST", `/housekeeping/${JOB}/run`);
      await server.waitForHold("hold:write");
      expect((await local("DELETE", `/keys/${revoked.id}`)).status).toBe(200);
      await server.clearFault("hold:write");
      const answer = await pending;
      expect(answer.status, JSON.stringify(answer.body)).toBe(401);
      expect(await started()).toBe(before);
    },
  );

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
      expect(
        answer.status,
        `${method} ${path} ${JSON.stringify(answer.body)}`,
      ).toBe(200);
    }
  });
});

async function admin(credential: string): Promise<McpConnection> {
  const connection = await connectMcp(
    server.apiUrl,
    credential,
    "2026-07-28",
    "/mcp/admin",
  );
  connections.push(connection);
  return connection;
}

/** A destructive call: the preview first, then the same call with its confirm. */
async function confirmed(
  connection: McpConnection,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolAnswer> {
  const preview = toolResult(await callTool(connection, name, args));
  expect(typeof preview.confirm, JSON.stringify(preview)).toBe("string");
  return callTool(connection, name, { ...args, confirm: preview.confirm });
}

/** The tool refused with the code the API refused the same request with. */
function expectSameRefusal(
  api: { status: number; body: Record<string, unknown> },
  answer: ToolAnswer,
  label: string,
) {
  expect(api.status, `${label} ${JSON.stringify(api.body)}`).toBeGreaterThan(
    399,
  );
  expect(toolError(answer).code, label).toBe(
    (api.body.error as { code: string }).code,
  );
}

/** What each step-up setting is set to by a request a key makes. */
const STEP_UP_SETTINGS: Record<string, unknown> = {
  sign_in_address: "https://elsewhere.example",
  allow_private_addresses: true,
  object_store_bucket: "another-bucket",
  object_store_endpoint: "https://store.example",
  object_store_region: "eu-west-1",
  object_store_path_style: false,
  object_store_prefix: "elsewhere",
  backup_path: "/tmp/elsewhere",
};

/** An item the key writes, by its title. */
async function made(key: string, title: string, type = "core.note") {
  const answer = await call(key, "POST", "/items", {
    type,
    properties: { title },
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return (answer.body.item as { id: string }).id;
}

/** A note in the bin with a comment that went there with it. */
async function trashedWithPart(key: string, run: string) {
  const host = await made(key, `a host ${run}`);
  const part = await made(key, `its comment ${run}`);
  const edge = await call(key, "POST", "/edges", {
    from_id: part,
    to_id: host,
    edge_type: "comments-on",
  });
  expect(edge.status, JSON.stringify(edge.body)).toBe(201);
  expect((await call(key, "DELETE", `/items/${host}`)).status).toBe(200);
  return { host, part };
}

/** The ids in the bin whose title holds `run`, as the owner reads them. */
async function inBin(run: string): Promise<string[]> {
  const read = await local("GET", `/trash?q=${encodeURIComponent(run)}`);
  return (read.body.data as { id: string }[]).map((row) => row.id).sort();
}

describe("the owner tasks at /mcp/admin", () => {
  it("refuses each step-up setting in the settings tool by name and changes nothing, where a setting that is not one changes", async () => {
    const { key } = await mint({ permissions: ["config.manage"] });
    const connection = await admin(key);
    const before = await call(key, "GET", "/config/settings");
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    for (const [name, value] of Object.entries(STEP_UP_SETTINGS)) {
      const refused = toolError(
        await callTool(connection, "marfa_change_settings", {
          settings: { [name]: value },
        }),
      );
      expect(refused.code, name).toBe("app_sign_in_required");
      expect(String(refused.message), name).toContain(name);
    }
    const after = await call(key, "GET", "/config/settings");
    expect(after.body).toEqual(before.body);
    // The API refuses a key the same way.
    const api = await call(key, "PATCH", "/config", {
      sign_in_address: STEP_UP_SETTINGS.sign_in_address,
    });
    expect(api.status).toBe(403);
    expect((api.body.error as { code: string }).code).toBe(
      "app_sign_in_required",
    );
    // The witness: a setting that is not a step-up act changes, and returns.
    const changed = toolResult(
      await callTool(connection, "marfa_change_settings", {
        name: "Named by a tool",
        settings: { trash_retention_days: 61 },
      }),
    );
    expect(changed.name).toBe("Named by a tool");
    const read = toolResult(
      await callTool(connection, "marfa_settings", {}),
    ) as { name: string; settings: { key: string; value: unknown }[] };
    expect(read.name).toBe("Named by a tool");
    expect(
      read.settings.find((line) => line.key === "trash_retention_days")?.value,
    ).toBe(61);
    toolResult(
      await callTool(connection, "marfa_change_settings", {
        name: null,
        settings: { trash_retention_days: null },
      }),
    );
    expect((await call(key, "GET", "/config/settings")).body).toEqual(
      before.body,
    );
  });

  it("refuses a setting that does not exist in the settings tool, as the API does", async () => {
    const { key } = await mint({ permissions: ["config.manage"] });
    const connection = await admin(key);
    const answer = await callTool(connection, "marfa_change_settings", {
      settings: { no_such_setting: 1 },
    });
    expect(toolError(answer).code).toBe("validation_error");
    const api = await call(key, "PATCH", "/config", { no_such_setting: 1 });
    expectSameRefusal(api, answer, "no_such_setting");
  });

  it("previews a purge with the parts that go with its item, purges them on its confirmation, and refuses another credential's, one for another item and a repeated one", async () => {
    const run = randomUUID();
    const writer = await mint({ ...EVERY_TYPE });
    const { host, part } = await trashedWithPart(writer.key, run);
    const other = await made(writer.key, `another ${run}`);
    expect((await call(writer.key, "DELETE", `/items/${other}`)).status).toBe(
      200,
    );
    const purges = {
      permissions: ["items.purge"],
      type_permissions: { "core.note": "write" },
    };
    const purger = await mint(purges);
    const stranger = await mint(purges);
    const connection = await admin(purger.key);
    const listed = toolResult(
      await callTool(connection, "marfa_trash", { q: run }),
    ) as { items: { id: string; version: number }[] };
    const versionOf = (id: string) =>
      listed.items.find((row) => row.id === id)!.version;
    const args = { action: "purge", id: host, version: versionOf(host) };
    const preview = toolResult(
      await callTool(connection, "marfa_purge_trash", args),
    ) as {
      confirm: string;
      preview: { goes: { items: { id: string }[]; count: number } };
    };
    expect(preview.preview.goes.count).toBe(2);
    expect(preview.preview.goes.items.map((row) => row.id)).toEqual([
      host,
      part,
    ]);
    expect(await inBin(run)).toEqual([host, part, other].sort());
    const theirs = toolResult(
      await callTool(await admin(stranger.key), "marfa_purge_trash", args),
    );
    const stale = toolError(
      await callTool(connection, "marfa_purge_trash", {
        ...args,
        confirm: theirs.confirm,
      }),
    );
    expect(stale.code).toBe("confirmation_stale");
    expect(typeof stale.confirm).toBe("string");
    const forOther = toolError(
      await callTool(connection, "marfa_purge_trash", {
        action: "purge",
        id: other,
        version: versionOf(other),
        confirm: preview.confirm,
      }),
    );
    expect(forOther.code).toBe("confirmation_stale");
    expect(await inBin(run)).toEqual([host, part, other].sort());
    const purged = toolResult(
      await callTool(connection, "marfa_purge_trash", {
        ...args,
        confirm: preview.confirm,
      }),
    ) as { purged: number; items: { id: string }[]; not_shown: number };
    expect(purged.purged).toBe(2);
    expect(purged.items.map((row) => row.id).sort()).toEqual(
      [host, part].sort(),
    );
    expect(purged.not_shown).toBe(0);
    expect(await inBin(run)).toEqual([other]);
    const again = await callTool(connection, "marfa_purge_trash", {
      ...args,
      confirm: preview.confirm,
    });
    expect(again.isError, JSON.stringify(again.body)).toBe(true);
    expect(await inBin(run)).toEqual([other]);
  });

  it("refuses a purge confirmation once what goes with the item changed, where the fresh confirmation it returns purges what goes now", async () => {
    const run = randomUUID();
    const writer = await mint({ ...EVERY_TYPE });
    const { host, part } = await trashedWithPart(writer.key, run);
    const purger = await mint({
      permissions: ["items.purge"],
      type_permissions: { "core.note": "write" },
    });
    const connection = await admin(purger.key);
    const listed = toolResult(
      await callTool(connection, "marfa_trash", { q: run }),
    ) as { items: { id: string; version: number }[] };
    const args = {
      action: "purge",
      id: host,
      version: listed.items.find((row) => row.id === host)!.version,
    };
    const preview = toolResult(
      await callTool(connection, "marfa_purge_trash", args),
    );
    // The comment comes back on its own, so it no longer goes with its host.
    expect(
      (await call(writer.key, "POST", `/items/${part}/restore`)).status,
    ).toBe(200);
    const stale = toolError(
      await callTool(connection, "marfa_purge_trash", {
        ...args,
        confirm: preview.confirm,
      }),
    );
    expect(stale.code).toBe("confirmation_stale");
    expect((stale.preview as { goes: { count: number } }).goes.count).toBe(1);
    expect(await inBin(run)).toEqual([host]);
    const purged = toolResult(
      await callTool(connection, "marfa_purge_trash", {
        ...args,
        confirm: stale.confirm,
      }),
    );
    expect(purged.purged).toBe(1);
    expect(await inBin(run)).toEqual([]);
    expect((await call(writer.key, "GET", `/items/${part}`)).status).toBe(200);
  });

  it("empties only the bin's items of the types a credential writes through the tool, page by page, each page on its confirmation", async () => {
    const run = randomUUID();
    const writer = await mint({ ...EVERY_TYPE });
    const binned: Record<string, string> = {};
    for (const type of ["core.note", "core.task"]) {
      binned[type] = await made(
        writer.key,
        `emptied by a tool ${type} ${run}`,
        type,
      );
      await call(writer.key, "DELETE", `/items/${binned[type]}`);
    }
    const purger = await mint({
      permissions: ["items.purge"],
      type_permissions: { "core.note": "write", "core.task": "read" },
    });
    const connection = await admin(purger.key);
    const preview = toolResult(
      await callTool(connection, "marfa_purge_trash", { action: "empty" }),
    ) as { preview: { items: number } };
    expect(preview.preview.items).toBeGreaterThanOrEqual(1);
    expect(await inBin(run)).toHaveLength(2);
    let cursor: string | null = null;
    do {
      const args: Record<string, unknown> = { action: "empty" };
      if (cursor !== null) args.cursor = cursor;
      const page = toolResult(
        await confirmed(connection, "marfa_purge_trash", args),
      );
      expect(page.failures).toEqual([]);
      cursor = page.next_cursor as string | null;
    } while (cursor !== null);
    expect(await inBin(run)).toEqual([binned["core.task"]]);
  });

  it("refuses an empty confirmation once the page changed, and a repeated one where nothing changed, where a fresh confirmation empties", async () => {
    const run = randomUUID();
    const writer = await mint({ ...EVERY_TYPE });
    const trashed = async (title: string) => {
      const id = await made(writer.key, `${title} ${run}`);
      expect((await call(writer.key, "DELETE", `/items/${id}`)).status).toBe(
        200,
      );
      return id;
    };
    const first = await trashed("on the page");
    const purger = await mint({
      permissions: ["items.purge"],
      type_permissions: { "core.note": "write" },
    });
    const connection = await admin(purger.key);
    const empty = { action: "empty" };
    const preview = toolResult(
      await callTool(connection, "marfa_purge_trash", empty),
    );
    const later = await trashed("trashed after the preview");
    const stale = toolError(
      await callTool(connection, "marfa_purge_trash", {
        ...empty,
        confirm: preview.confirm,
      }),
    );
    expect(stale.code).toBe("confirmation_stale");
    expect(await inBin(run)).toEqual([first, later].sort());
    const emptied = toolResult(
      await callTool(connection, "marfa_purge_trash", {
        ...empty,
        confirm: stale.confirm,
      }),
    );
    expect(emptied.failures).toEqual([]);
    expect(await inBin(run)).toEqual([]);
    // The page is the same empty page before and after, so only the spent
    // confirmation refuses the second use.
    const quiet = toolResult(
      await callTool(connection, "marfa_purge_trash", empty),
    );
    expect((quiet.preview as { items: number }).items).toBe(0);
    toolResult(
      await callTool(connection, "marfa_purge_trash", {
        ...empty,
        confirm: quiet.confirm,
      }),
    );
    const repeated = toolError(
      await callTool(connection, "marfa_purge_trash", {
        ...empty,
        confirm: quiet.confirm,
      }),
    );
    expect(repeated.code).toBe("confirmation_stale");
  });

  it("refuses a purge the API refuses, with the API's code, at the preview", async () => {
    const writer = await mint({ ...EVERY_TYPE });
    const id = await made(
      writer.key,
      `read only in the bin ${randomUUID()}`,
      "core.task",
    );
    await call(writer.key, "DELETE", `/items/${id}`);
    const reader = await mint({
      permissions: ["items.purge"],
      type_permissions: { "core.task": "read" },
    });
    const connection = await admin(reader.key);
    for (const target of [id, uuidv7()]) {
      const api = await call(
        reader.key,
        "POST",
        `/items/${target}/purge?version=1`,
      );
      const answer = await callTool(connection, "marfa_purge_trash", {
        action: "purge",
        id: target,
        version: 1,
      });
      expectSameRefusal(api, answer, target);
    }
    // The witness: the item stands in the bin.
    const trashed = (await local("GET", `/trash?q=read%20only`)).body.data as {
      id: string;
    }[];
    expect(trashed.map((row) => row.id)).toContain(id);
  });

  it("refuses a search longer than the API takes and a malformed id in the trash tools, with the API's codes", async () => {
    const { key } = await mint({
      permissions: ["items.purge"],
      type_permissions: { "core.note": "write" },
    });
    const connection = await admin(key);
    const longest = "x".repeat(500);
    expect((await call(key, "GET", `/trash?q=${longest}`)).status).toBe(200);
    toolResult(await callTool(connection, "marfa_trash", { q: longest }));
    const tooLong = `${longest}x`;
    const api = await call(key, "GET", `/trash?q=${tooLong}`);
    expect(api.status).toBe(400);
    expectSameRefusal(
      api,
      await callTool(connection, "marfa_trash", { q: tooLong }),
      "a search of 501 characters",
    );
    const malformed = await call(
      key,
      "POST",
      "/items/not-an-id/purge?version=1",
    );
    expect((malformed.body.error as { code: string }).code).toBe("invalid_id");
    expectSameRefusal(
      malformed,
      await callTool(connection, "marfa_purge_trash", {
        action: "purge",
        id: "not-an-id",
        version: 1,
      }),
      "a malformed id",
    );
  });

  it("lists, narrows and revokes an app's grant through the tools, a revoke on its confirmation", async () => {
    const app = await approvedApp(server, ["core.note:write"]);
    const { key } = await mint({ permissions: ["grants.manage"] });
    const connection = await admin(key);
    const listed = toolResult(await callTool(connection, "marfa_apps", {})) as {
      apps: { id: string; client_id: string; scopes: string[] }[];
    };
    const grant = listed.apps.find((row) => row.client_id === app.clientId)!;
    expect(grant, JSON.stringify(listed)).toBeDefined();
    const stale = await callTool(connection, "marfa_manage_app", {
      action: "narrow",
      id: grant.id,
      scopes: ["core.note:read"],
      expected_scopes: ["core.note:read"],
    });
    expectSameRefusal(
      await call(key, "PATCH", `/grants/${grant.id}`, {
        scopes: ["core.note:read"],
        expected_scopes: ["core.note:read"],
      }),
      stale,
      "a stale expectation",
    );
    const writes = () =>
      call(app.token, "GET", "/items?type=core.note&limit=1");
    expect((await writes()).status).toBe(200);
    const done = toolResult(
      await callTool(connection, "marfa_manage_app", {
        action: "narrow",
        id: grant.id,
        scopes: ["core.note:read"],
        expected_scopes: grant.scopes,
      }),
    );
    expect(done.scopes).toEqual(["core.note:read"]);
    expect((await writes()).status).toBe(401);
    const read = (await call(key, "GET", "/grants")).body.data as {
      id: string;
      scopes: string[];
    }[];
    expect(read.find((row) => row.id === grant.id)?.scopes).toEqual([
      "core.note:read",
    ]);
    const args = { action: "revoke", id: grant.id };
    const preview = toolResult(
      await callTool(connection, "marfa_manage_app", args),
    );
    expect(typeof preview.confirm).toBe("string");
    const stands = (await call(key, "GET", "/grants")).body.data as {
      id: string;
    }[];
    expect(stands.map((row) => row.id)).toContain(grant.id);
    const gone = toolResult(
      await callTool(connection, "marfa_manage_app", {
        ...args,
        confirm: preview.confirm,
      }),
    );
    expect(gone.revoked).toBe(grant.id);
    const left = (await call(key, "GET", "/grants")).body.data as {
      id: string;
    }[];
    expect(left.map((row) => row.id)).not.toContain(grant.id);
  });

  it("refuses a revoke confirmation once the owner approved the app again under the same grant, where the fresh confirmation it returns revokes", async () => {
    const app = await approvedApp(server, ["core.note:read"]);
    const { key } = await mint({ permissions: ["grants.manage"] });
    const connection = await admin(key);
    const grantOf = async () =>
      (
        (await call(key, "GET", "/grants")).body.data as {
          id: string;
          client_id: string;
        }[]
      ).find((row) => row.client_id === app.clientId);
    const grant = (await grantOf())!;
    const args = { action: "revoke", id: grant.id };
    const preview = toolResult(
      await callTool(connection, "marfa_manage_app", args),
    );
    const revoked = await call(key, "DELETE", `/grants/${grant.id}`);
    expect(revoked.status, JSON.stringify(revoked.body)).toBeLessThan(300);
    expect(await grantOf()).toBeUndefined();
    await approvedApp(server, ["core.note:read"], app.clientId);
    expect((await grantOf())?.id).toBe(grant.id);
    const stale = toolError(
      await callTool(connection, "marfa_manage_app", {
        ...args,
        confirm: preview.confirm,
      }),
    );
    expect(stale.code).toBe("confirmation_stale");
    expect(await grantOf()).toBeDefined();
    const gone = toolResult(
      await callTool(connection, "marfa_manage_app", {
        ...args,
        confirm: stale.confirm,
      }),
    );
    expect(gone.revoked).toBe(grant.id);
    expect(await grantOf()).toBeUndefined();
  });

  it("refuses an app task the API refuses, with the API's code", async () => {
    const { key } = await mint({ permissions: ["grants.manage"] });
    const connection = await admin(key);
    const narrow = await callTool(connection, "marfa_manage_app", {
      action: "narrow",
      id: "no-such-grant",
      scopes: [],
      expected_scopes: [],
    });
    expectSameRefusal(
      await call(key, "PATCH", "/grants/no-such-grant", {
        scopes: [],
        expected_scopes: [],
      }),
      narrow,
      "narrow",
    );
    const revoke = await callTool(connection, "marfa_manage_app", {
      action: "revoke",
      id: "no-such-grant",
    });
    expectSameRefusal(
      await call(key, "DELETE", "/grants/no-such-grant"),
      revoke,
      "revoke",
    );
  });

  it("lists, renames and ends a sign-in through the tools, an end on its confirmation, and refuses the confirmation again", async () => {
    const other = await mint({});
    const { key } = await mint({ permissions: ["sign_ins.manage"] });
    const connection = await admin(key);
    const listed = toolResult(
      await callTool(connection, "marfa_sign_ins", {}),
    ) as { sign_ins: { id: string }[]; passkeys: unknown[] };
    expect(listed.sign_ins.map((row) => row.id)).toContain(other.id);
    const renamed = toolResult(
      await callTool(connection, "marfa_manage_sign_in", {
        action: "rename_sign_in",
        id: other.id,
        name: "Renamed by a tool",
      }),
    );
    expect((renamed.sign_in as { name: string }).name).toBe(
      "Renamed by a tool",
    );
    const args = { action: "end_sign_in", id: other.id };
    const preview = toolResult(
      await callTool(connection, "marfa_manage_sign_in", args),
    );
    expect(typeof preview.confirm).toBe("string");
    expect((await call(other.key, "GET", "/keys/current")).status).toBe(200);
    const ended = toolResult(
      await callTool(connection, "marfa_manage_sign_in", {
        ...args,
        confirm: preview.confirm,
      }),
    );
    expect(ended.ended).toBe(other.id);
    expect((await call(other.key, "GET", "/keys/current")).status).toBe(401);
    const again = await callTool(connection, "marfa_manage_sign_in", {
      ...args,
      confirm: preview.confirm,
    });
    expect(again.isError, JSON.stringify(again.body)).toBe(true);
  });

  it("refuses an end confirmation for an app's sign-in once the owner approved the app again, where the fresh confirmation it returns ends it", async () => {
    const app = await approvedApp(server, ["core.note:read"]);
    const { key } = await mint({ permissions: ["sign_ins.manage"] });
    const connection = await admin(key);
    const grants = await mint({ permissions: ["grants.manage"] });
    const grant = (
      (await call(grants.key, "GET", "/grants")).body.data as {
        id: string;
        client_id: string;
      }[]
    ).find((row) => row.client_id === app.clientId)!;
    const args = { action: "end_sign_in", id: grant.id };
    const preview = toolResult(
      await callTool(connection, "marfa_manage_sign_in", args),
    );
    expect(
      (await call(grants.key, "DELETE", `/grants/${grant.id}`)).status,
    ).toBeLessThan(300);
    const again = await approvedApp(server, ["core.note:read"], app.clientId);
    const stale = toolError(
      await callTool(connection, "marfa_manage_sign_in", {
        ...args,
        confirm: preview.confirm,
      }),
    );
    expect(stale.code).toBe("confirmation_stale");
    const reads = () =>
      call(again.token, "GET", "/items?type=core.note&limit=1");
    expect((await reads()).status).toBe(200);
    const ended = toolResult(
      await callTool(connection, "marfa_manage_sign_in", {
        ...args,
        confirm: stale.confirm,
      }),
    );
    expect(ended.ended).toBe(grant.id);
    expect((await reads()).status).toBe(401);
  });

  it("refuses a sign-in or passkey task the API refuses, with the API's code", async () => {
    const { key } = await mint({ permissions: ["sign_ins.manage"] });
    const connection = await admin(key);
    const passkeys = toolResult(
      await callTool(connection, "marfa_sign_ins", {}),
    ).passkeys;
    expect(Array.isArray(passkeys)).toBe(true);
    expectSameRefusal(
      await call(key, "PATCH", "/owner/sign-ins/no-such-sign-in", {
        name: "Renamed",
      }),
      await callTool(connection, "marfa_manage_sign_in", {
        action: "rename_sign_in",
        id: "no-such-sign-in",
        name: "Renamed",
      }),
      "rename a sign-in",
    );
    expectSameRefusal(
      await call(key, "DELETE", "/owner/sign-ins/no-such-sign-in"),
      await callTool(connection, "marfa_manage_sign_in", {
        action: "end_sign_in",
        id: "no-such-sign-in",
      }),
      "end a sign-in",
    );
    expectSameRefusal(
      await call(key, "PATCH", "/owner/passkeys/no-such-passkey", {
        name: "Renamed",
      }),
      await callTool(connection, "marfa_manage_sign_in", {
        action: "rename_passkey",
        id: "no-such-passkey",
        name: "Renamed",
      }),
      "rename a passkey",
    );
    expectSameRefusal(
      await call(key, "DELETE", "/owner/passkeys/no-such-passkey"),
      await callTool(connection, "marfa_manage_sign_in", {
        action: "remove_passkey",
        id: "no-such-passkey",
      }),
      "remove a passkey",
    );
  });

  it("lists backups and takes one now through the tools, with the API's answers, and previews adopting the folder", async () => {
    const { key } = await mint({ permissions: ["backups.manage"] });
    const connection = await admin(key);
    const before = toolResult(
      await callTool(connection, "marfa_backups", {}),
    ) as { backups: unknown[] };
    const api = await call(key, "GET", "/backups");
    expect(before.backups).toHaveLength((api.body.data as unknown[]).length);
    const taken = toolResult(
      await callTool(connection, "marfa_manage_backups", { action: "take" }),
    );
    expect(taken.backup).toBeDefined();
    const after = toolResult(
      await callTool(connection, "marfa_backups", {}),
    ) as { backups: unknown[] };
    expect(after.backups.length).toBeGreaterThan(before.backups.length);
    const preview = toolResult(
      await callTool(connection, "marfa_manage_backups", {
        action: "adopt_folder",
      }),
    ) as { confirm: string; preview: { replaced_store_id: string } };
    expect(typeof preview.confirm).toBe("string");
    // The folder holds the store's marker already, so adopting it is refused
    // past the access check, with the code the API gives.
    const adopt = await callTool(connection, "marfa_manage_backups", {
      action: "adopt_folder",
      confirm: preview.confirm,
    });
    expectSameRefusal(
      await call(key, "POST", "/backups/folder/adopt"),
      adopt,
      "adopt",
    );
  });

  it("adopts the backup folder only in place of the store its confirmation named, where the fresh confirmation it returns adopts", async () => {
    const parent = tempFolder("marfa-owner-tasks-adopt-");
    const root = join(parent, "disk");
    mkdirSync(root);
    const fresh = await bootFreshServer("owner-tasks-adopt", {
      MARFA_OBJECT_STORE_BUCKET: "",
      MARFA_BACKUP_PATH: root,
      MARFA_BACKUP_INTERVAL_SECONDS: "0",
    });
    let connection: McpConnection | undefined;
    try {
      const minted = await controlRequest(fresh.controlSocket, "/keys", {
        method: "POST",
        body: {
          label: "adopts the folder",
          source: `${SOURCE}-adopt`,
          permissions: ["backups.manage"],
        },
      });
      expect(minted.status, JSON.stringify(minted.body)).toBe(201);
      const key = (minted.body as unknown as Minted).key;
      connection = await connectMcp(
        fresh.apiUrl,
        key,
        "2026-07-28",
        "/mcp/admin",
      );
      let disks = 0;
      // A new, empty disk at the folder's place, as when a disk is replaced.
      const replaced = () => {
        disks += 1;
        renameSync(root, join(parent, `old disk ${String(disks)}`));
        mkdirSync(root);
      };
      const adopt = { action: "adopt_folder" };
      replaced();
      const preview = toolResult(
        await callTool(connection, "marfa_manage_backups", adopt),
      ) as { confirm: string; preview: { replaced_store_id: string } };
      const viaApi = await fetch(`${fresh.apiUrl}/backups/folder/adopt`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
      });
      const adoptedByApi = (await viaApi.json()) as {
        store_id: string;
        replaced_store_id: string;
      };
      expect(viaApi.status, JSON.stringify(adoptedByApi)).toBe(200);
      expect(adoptedByApi.replaced_store_id).toBe(
        preview.preview.replaced_store_id,
      );
      replaced();
      const stale = toolError(
        await callTool(connection, "marfa_manage_backups", {
          ...adopt,
          confirm: preview.confirm,
        }),
      );
      expect(stale.code).toBe("confirmation_stale");
      expect(
        (stale.preview as { replaced_store_id: string }).replaced_store_id,
      ).toBe(adoptedByApi.store_id);
      const adopted = toolResult(
        await callTool(connection, "marfa_manage_backups", {
          ...adopt,
          confirm: stale.confirm,
        }),
      ) as { adopted: { replaced_store_id: string } };
      expect(adopted.adopted.replaced_store_id).toBe(adoptedByApi.store_id);
    } finally {
      await connection?.close();
      await fresh.stop();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("runs housekeeping and cancels a job through the maintenance tool, refusing as the API does", async () => {
    const { key } = await mint({ permissions: ["instance.maintain"] });
    const connection = await admin(key);
    const unknown = await callTool(connection, "marfa_maintain", {
      action: "run_housekeeping",
      name: "no-such-job",
    });
    expectSameRefusal(
      await call(key, "POST", "/housekeeping/no-such-job/run"),
      unknown,
      "unknown housekeeping",
    );
    const id = uuidv7();
    expectSameRefusal(
      await call(key, "POST", `/items/bulk-actions/jobs/${id}/cancel`),
      await callTool(connection, "marfa_maintain", {
        action: "cancel_job",
        id,
      }),
      "cancel a job",
    );
    const reader = await mint({ permissions: ["instance.read"] });
    const listed = (await call(reader.key, "GET", "/housekeeping")).body
      .data as { name: string }[];
    expect(listed.length).toBeGreaterThan(0);
    const named = listed[0]!.name;
    const maintainer = await mint({ permissions: ["instance.maintain"] });
    const api = await call(
      maintainer.key,
      "POST",
      `/housekeeping/${named}/run`,
    );
    const run = await callTool(connection, "marfa_maintain", {
      action: "run_housekeeping",
      name: named,
    });
    expect(run.isError, JSON.stringify(run.body)).toBe(api.status >= 400);
  });

  it("adds what instance.read opens to the health tool, and only for a credential that holds it", async () => {
    const reader = await mint({ permissions: ["instance.read"] });
    const opened = [
      "attention",
      "housekeeping_jobs",
      "metrics",
      "storage",
      "settings",
      "update",
    ];
    const read = toolResult(
      await callTool(await admin(reader.key), "marfa_health", {}),
    );
    for (const name of opened) {
      expect(read[name], name).toBeDefined();
    }
    const settings = (await call(reader.key, "GET", "/config/settings")).body
      .data as { key: string }[];
    expect(
      (read.settings as { key: string }[]).map((line) => line.key),
    ).toEqual(settings.map((line) => line.key));
    const update = await call(reader.key, "GET", "/update");
    expect(update.status).toBe(200);
    expect(Object.keys(read.update as object).sort()).toEqual(
      Object.keys(update.body).sort(),
    );
    // The witness: another permission that lists the tool does not add them.
    const connectors = await mint({ permissions: ["connectors.manage"] });
    const plain = toolResult(
      await callTool(await admin(connectors.key), "marfa_health", {}),
    );
    expect(plain.health).toBeDefined();
    for (const name of opened) {
      expect(plain[name], name).toBeUndefined();
    }
  });

  it("answers each part of the health tool on its own, so a bulk job it cannot read leaves the others", async () => {
    const reader = await mint({ permissions: ["instance.read"] });
    const connection = await admin(reader.key);
    const parts = [
      "connectors",
      "attention",
      "housekeeping_jobs",
      "metrics",
      "storage",
      "settings",
      "update",
    ];
    // The witness: without a job_id every part answers and nothing is unread.
    const whole = toolResult(await callTool(connection, "marfa_health", {}));
    for (const name of parts) {
      expect(whole[name], name).toBeDefined();
    }
    expect(whole.unread).toBeUndefined();
    const missing = uuidv7();
    const job = toolResult(
      await callTool(connection, "marfa_health", { job_id: missing }),
    ) as Record<string, unknown> & { unread: { read: string; code: string }[] };
    const api = await call(
      reader.key,
      "GET",
      `/items/bulk-actions/jobs/${missing}`,
    );
    expect(api.status).toBeGreaterThan(399);
    expect(job.unread).toEqual([
      expect.objectContaining({
        read: "job",
        code: (api.body.error as { code: string }).code,
      }),
    ]);
    for (const name of parts) {
      expect(job[name], name).toBeDefined();
    }
  });

  it("lists a connector with its runs, and deletes it only on its confirmation, refusing as the API does and refusing the confirmation again", async () => {
    const owner = await mint({ permissions: ["connectors.manage"] });
    const registered = await call(owner.key, "POST", "/connectors", {
      name: "Read through a tool",
    });
    expect(registered.status, JSON.stringify(registered.body)).toBe(201);
    const id = registered.body.id as string;
    const reported = await call(owner.key, "POST", `/connectors/${id}/runs`, {
      outcome: "succeeded",
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:01:00.000Z",
    });
    expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    const connection = await admin(owner.key);
    const listed = toolResult(
      await callTool(connection, "marfa_connectors", {}),
    ) as { connectors: { id: string }[] };
    expect(listed.connectors.map((row) => row.id)).toContain(id);
    const one = toolResult(
      await callTool(connection, "marfa_connectors", { id }),
    ) as { runs: { id: string }[]; runs_next_cursor: string | null };
    const runs = await call(owner.key, "GET", `/connectors/${id}/runs`);
    expect(one.runs.map((run) => run.id)).toEqual(
      (runs.body.data as { id: string }[]).map((run) => run.id),
    );
    expect(one.runs).toHaveLength(1);
    expect(one.runs_next_cursor).toBeNull();
    const missing = uuidv7();
    expectSameRefusal(
      await call(owner.key, "GET", `/connectors/${missing}`),
      await callTool(connection, "marfa_connectors", { id: missing }),
      "read",
    );
    expectSameRefusal(
      await call(owner.key, "DELETE", `/connectors/${missing}`),
      await callTool(connection, "marfa_manage_connector", {
        action: "delete",
        id: missing,
      }),
      "delete",
    );
    const args = { action: "delete", id };
    const preview = toolResult(
      await callTool(connection, "marfa_manage_connector", args),
    );
    expect(typeof preview.confirm).toBe("string");
    expect((await call(owner.key, "GET", `/connectors/${id}`)).status).toBe(
      200,
    );
    const deleted = toolResult(
      await callTool(connection, "marfa_manage_connector", {
        ...args,
        confirm: preview.confirm,
      }),
    );
    expect(deleted.deleted).toBe(id);
    expect((await call(owner.key, "GET", `/connectors/${id}`)).status).toBe(
      404,
    );
    const again = await callTool(connection, "marfa_manage_connector", {
      ...args,
      confirm: preview.confirm,
    });
    expect(again.isError, JSON.stringify(again.body)).toBe(true);
  });

  it("clears a connector's state only as its confirmation saw it, and only once, keeping newer state", async () => {
    const owner = await mint({ permissions: ["connectors.manage"] });
    const registered = await call(owner.key, "POST", "/connectors", {
      name: "State cleared through a tool",
    });
    expect(registered.status, JSON.stringify(registered.body)).toBe(201);
    const id = registered.body.id as string;
    const held = await call(owner.key, "POST", `/connectors/${id}/hold`, {
      process: "a run",
    });
    expect(held.status, JSON.stringify(held.body)).toBeLessThan(300);
    const put = async (cursor: string) => {
      const answer = await call(owner.key, "PUT", `/connectors/${id}/state`, {
        process: "a run",
        state: { cursor },
      });
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    };
    const state = async () =>
      (await call(owner.key, "GET", `/connectors/${id}/state`)).body.state;
    await put("first");
    const connection = await admin(owner.key);
    const args = { action: "clear_state", id };
    const preview = toolResult(
      await callTool(connection, "marfa_manage_connector", args),
    );
    await put("newer");
    const stale = toolError(
      await callTool(connection, "marfa_manage_connector", {
        ...args,
        confirm: preview.confirm,
      }),
    );
    expect(stale.code).toBe("confirmation_stale");
    expect(await state()).toEqual({ cursor: "newer" });
    const cleared = toolResult(
      await callTool(connection, "marfa_manage_connector", {
        ...args,
        confirm: stale.confirm,
      }),
    );
    expect(cleared.cleared).toBe(id);
    expect(await state()).toEqual({});
    // Nothing is kept before or after, so only the spent confirmation
    // refuses the second use.
    const quiet = toolResult(
      await callTool(connection, "marfa_manage_connector", args),
    );
    toolResult(
      await callTool(connection, "marfa_manage_connector", {
        ...args,
        confirm: quiet.confirm,
      }),
    );
    const repeated = toolError(
      await callTool(connection, "marfa_manage_connector", {
        ...args,
        confirm: quiet.confirm,
      }),
    );
    expect(repeated.code).toBe("confirmation_stale");
  });

  it("retires an endpoint only as its confirmation saw it, where the fresh confirmation it returns retires", async () => {
    const owner = await mint({ permissions: ["connectors.manage"] });
    const registered = await call(owner.key, "POST", "/connectors", {
      name: "Endpoints retired through a tool",
    });
    expect(registered.status, JSON.stringify(registered.body)).toBe(201);
    const id = registered.body.id as string;
    const connection = await admin(owner.key);
    const made = toolResult(
      await callTool(connection, "marfa_manage_connector", {
        action: "make_endpoint",
        id,
        label: "Deliveries",
      }),
    ) as { endpoint: { id: string } };
    const args = {
      action: "retire_endpoint",
      id,
      endpoint_id: made.endpoint.id,
    };
    const preview = toolResult(
      await callTool(connection, "marfa_manage_connector", args),
    );
    const retired = await call(
      owner.key,
      "DELETE",
      `/connectors/${id}/endpoints/${made.endpoint.id}`,
    );
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    const stale = toolError(
      await callTool(connection, "marfa_manage_connector", {
        ...args,
        confirm: preview.confirm,
      }),
    );
    expect(stale.code).toBe("confirmation_stale");
    const again = toolResult(
      await callTool(connection, "marfa_manage_connector", {
        ...args,
        confirm: stale.confirm,
      }),
    ) as { retired: { retired_at: string } };
    expect(again.retired.retired_at).toBe(retired.body.retired_at);
  });

  it("lists a file's copies, drops one only on its confirmation, refuses as the API does and refuses the confirmation again", async () => {
    const { key } = await mint({
      ...EVERY_TYPE,
      permissions: ["blobs.manage"],
    });
    const connection = await admin(key);
    const upload = await fetch(`${server.apiUrl}/blobs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "text/plain",
      },
      body: `a file whose copy is kept ${randomUUID()}`,
    });
    expect(upload.status, await upload.clone().text()).toBeLessThan(300);
    const hash = ((await upload.json()) as { hash: string }).hash;
    const copiesOf = async () =>
      (await call(key, "GET", `/blobs/${hash}/copies`)).body.data as {
        store_id: string;
        kind: string;
      }[];
    // The upload wakes replication, which places the backup folder's copy
    // on its own clock: read once both stores hold one.
    const settled = await waitFor("the backup folder's copy", async () => {
      const copies = await copiesOf();
      return copies.some((copy) => copy.kind === "folder") ? copies : undefined;
    });
    const listed = toolResult(
      await callTool(connection, "marfa_files", { hash }),
    ) as { copies: { store_id: string }[] };
    expect(listed.copies.map((copy) => copy.store_id).sort()).toEqual(
      settled.map((copy) => copy.store_id).sort(),
    );
    const folder = settled.find((copy) => copy.kind === "folder")!.store_id;

    expectSameRefusal(
      await call(key, "DELETE", `/blobs/${hash}/copies/${randomUUID()}`),
      await callTool(connection, "marfa_drop_file_copy", {
        hash,
        store_id: "no-such-store",
      }),
      "a store that holds no copy",
    );

    const args = { hash, store_id: folder };
    const preview = toolResult(
      await callTool(connection, "marfa_drop_file_copy", args),
    );
    expect(typeof preview.confirm).toBe("string");
    expect(
      (await copiesOf()).some((copy) => copy.store_id === folder),
      "a preview drops nothing",
    ).toBe(true);
    const dropped = toolResult(
      await callTool(connection, "marfa_drop_file_copy", {
        ...args,
        confirm: preview.confirm,
      }),
    );
    expect(dropped.dropped).toEqual({ hash, store_id: folder });
    const again = await callTool(connection, "marfa_drop_file_copy", {
      ...args,
      confirm: preview.confirm,
    });
    expect(again.isError, JSON.stringify(again.body)).toBe(true);
  });
});
