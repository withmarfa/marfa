import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
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
import {
  DAY_MS,
  movedClock,
  QUIET_SCHEDULE,
  quiet,
  writerOf,
} from "../../utils/moved-clock.js";
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
const ownServers: FreshServer[] = [];

afterAll(async () => {
  await Promise.all(connections.map((connection) => connection.close()));
  await Promise.all(ownServers.map((own) => own.stop()));
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

/** What each setting that needs a recent sign-in is set to by a request a key makes. */
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

/** A connector the key registers, by its name. */
async function registered(key: string, name: string): Promise<string> {
  const answer = await call(key, "POST", "/connectors", { name });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body.id as string;
}

describe("the owner tasks at /mcp/admin", () => {
  it("refuses a key each setting that needs a recent sign-in in the settings tool with app_sign_in_required, as the API does, and changes nothing, where a setting that is not one changes", async () => {
    const { key } = await mint({ permissions: ["config.manage"] });
    const connection = await admin(key);
    const before = await call(key, "GET", "/config/settings");
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    const lines = (before.body as { data: { key: string; value: unknown }[] })
      .data;
    for (const [name, wanted] of Object.entries(STEP_UP_SETTINGS)) {
      // A value the setting already has changes nothing, so the switches are turned over.
      const now = lines.find((line) => line.key === name)?.value;
      const value = typeof wanted === "boolean" ? now !== true : wanted;
      const answer = await callTool(connection, "marfa_change_settings", {
        name: "Named beside a setting that needs a recent sign-in",
        settings: { [name]: value },
      });
      expect(toolError(answer).code, name).toBe("app_sign_in_required");
      const api = await call(key, "PATCH", "/config", { [name]: value });
      expect(api.status, name).toBe(403);
      expectSameRefusal(api, answer, name);
    }
    expect(
      String(
        toolError(
          await callTool(connection, "marfa_change_settings", {
            settings: { sign_in_address: STEP_UP_SETTINGS.sign_in_address },
          }),
        ).message,
      ),
    ).toContain("sign_in_address");
    const after = await call(key, "GET", "/config/settings");
    expect(after.body).toEqual(before.body);
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

  it("lists only the bin's items of the types a credential reads in the trash tool, as the API does", async () => {
    const run = randomUUID();
    const writer = await mint({ ...EVERY_TYPE });
    const binned: Record<string, string> = {};
    for (const type of ["core.note", "core.task"]) {
      binned[type] = await made(writer.key, `listed ${type} ${run}`, type);
      expect(
        (await call(writer.key, "DELETE", `/items/${binned[type]}`)).status,
      ).toBe(200);
    }
    const purger = await mint({
      permissions: ["items.purge"],
      type_permissions: { "core.note": "write" },
    });
    const listed = toolResult(
      await callTool(await admin(purger.key), "marfa_trash", { q: run }),
    ) as { items: { id: string }[]; next_cursor: string | null };
    const api = await call(purger.key, "GET", `/trash?q=${run}`);
    expect(listed.items.map((row) => row.id)).toEqual(
      (api.body.data as { id: string }[]).map((row) => row.id),
    );
    expect(listed.items.map((row) => row.id)).toEqual([binned["core.note"]]);
    expect(listed.next_cursor).toBeNull();
    // The witness: the owner reads both in the bin.
    const owner = (await local("GET", `/trash?q=${run}`)).body.data as {
      id: string;
    }[];
    expect(owner.map((row) => row.id).sort()).toEqual(
      Object.values(binned).sort(),
    );
  });

  it("pages the trash that does not fit one answer, each page continuing where the last stopped", async () => {
    const run = randomUUID();
    const writer = await mint({ ...EVERY_TYPE });
    const long = "a long title ".repeat(160);
    const count = 150;
    for (let index = 0; index < count; index += 1) {
      const id = await made(writer.key, `${run} ${String(index)} ${long}`);
      expect((await call(writer.key, "DELETE", `/items/${id}`)).status).toBe(
        200,
      );
    }
    const purger = await mint({
      permissions: ["items.purge"],
      type_permissions: { "core.note": "write" },
    });
    const connection = await admin(purger.key);
    const whole = await call(
      purger.key,
      "GET",
      `/trash?q=${run}&limit=${String(count)}`,
    );
    const expected = (whole.body.data as { id: string }[]).map((row) => row.id);
    expect(expected).toHaveLength(count);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const args: Record<string, unknown> = { q: run, limit: count };
      if (cursor !== null) args.cursor = cursor;
      const page = toolResult(
        await callTool(connection, "marfa_trash", args),
      ) as { items: { id: string }[]; next_cursor: string | null };
      expect(page.items.length).toBeGreaterThan(0);
      seen.push(...page.items.map((row) => row.id));
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor !== null && pages < count);
    // More than one page, so a page was cut short and its cursor followed it.
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(expected);
  });

  it("refuses a search longer than the API takes in the trash tool, with the API's code", async () => {
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
  });

  it("lists and narrows an app's grant through the tools, refusing a stale expectation as the API does", async () => {
    const app = await approvedApp(server, ["core.note:write"]);
    const { key } = await mint({ permissions: ["grants.manage"] });
    const connection = await admin(key);
    const listed = toolResult(await callTool(connection, "marfa_apps", {})) as {
      apps: { id: string; client_id: string; scopes: string[] }[];
    };
    const grant = listed.apps.find((row) => row.client_id === app.clientId)!;
    expect(grant, JSON.stringify(listed)).toBeDefined();
    const stale = await callTool(connection, "marfa_narrow_app", {
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
      await callTool(connection, "marfa_narrow_app", {
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
  });

  it("refuses an app task the API refuses, with the API's code", async () => {
    const { key } = await mint({ permissions: ["grants.manage"] });
    const connection = await admin(key);
    expectSameRefusal(
      await call(key, "PATCH", "/grants/no-such-grant", {
        scopes: [],
        expected_scopes: [],
      }),
      await callTool(connection, "marfa_narrow_app", {
        id: "no-such-grant",
        scopes: [],
        expected_scopes: [],
      }),
      "narrow",
    );
    expectSameRefusal(
      await call(key, "PATCH", "/grants/no-such-grant", { scopes: [] }),
      await callTool(connection, "marfa_narrow_app", {
        id: "no-such-grant",
        scopes: [],
      }),
      "narrow without the expected scopes",
    );
  });

  it("lists and renames a sign-in through the tools", async () => {
    const other = await mint({});
    const { key } = await mint({ permissions: ["sign_ins.manage"] });
    const connection = await admin(key);
    const listed = toolResult(
      await callTool(connection, "marfa_sign_ins", {}),
    ) as { sign_ins: { id: string }[]; passkeys: unknown[] };
    expect(listed.sign_ins.map((row) => row.id)).toContain(other.id);
    expect(Array.isArray(listed.passkeys)).toBe(true);
    const renamed = toolResult(
      await callTool(connection, "marfa_rename_sign_in", {
        kind: "sign_in",
        id: other.id,
        name: "Renamed by a tool",
      }),
    );
    expect((renamed.sign_in as { name: string }).name).toBe(
      "Renamed by a tool",
    );
    const api = (await call(key, "GET", "/owner/sign-ins")).body.data as {
      id: string;
      name: string;
    }[];
    expect(api.find((row) => row.id === other.id)?.name).toBe(
      "Renamed by a tool",
    );
    expect((await call(other.key, "GET", "/keys/current")).status).toBe(200);
  });

  it("refuses a sign-in or passkey task the API refuses, with the API's code", async () => {
    const { key } = await mint({ permissions: ["sign_ins.manage"] });
    const connection = await admin(key);
    expectSameRefusal(
      await call(key, "PATCH", "/owner/sign-ins/no-such-sign-in", {
        name: "Renamed",
      }),
      await callTool(connection, "marfa_rename_sign_in", {
        kind: "sign_in",
        id: "no-such-sign-in",
        name: "Renamed",
      }),
      "rename a sign-in",
    );
    expectSameRefusal(
      await call(key, "PATCH", "/owner/passkeys/no-such-passkey", {
        name: "Renamed",
      }),
      await callTool(connection, "marfa_rename_sign_in", {
        kind: "passkey",
        id: "no-such-passkey",
        name: "Renamed",
      }),
      "rename a passkey",
    );
  });

  it("lists backups and takes one now through the tools, with the API's answers", async () => {
    const { key } = await mint({ permissions: ["backups.manage"] });
    const connection = await admin(key);
    const before = toolResult(
      await callTool(connection, "marfa_backups", {}),
    ) as { backups: unknown[] };
    const api = await call(key, "GET", "/backups");
    expect(before.backups).toHaveLength((api.body.data as unknown[]).length);
    const taken = toolResult(
      await callTool(connection, "marfa_take_backup", {}),
    );
    expect(taken.backup).toBeDefined();
    const after = toolResult(
      await callTool(connection, "marfa_backups", {}),
    ) as { backups: unknown[] };
    expect(after.backups.length).toBeGreaterThan(before.backups.length);
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
      "update",
    ];
    const read = toolResult(
      await callTool(await admin(reader.key), "marfa_health", {}),
    );
    for (const name of opened) {
      expect(read[name], name).toBeDefined();
    }
    expect(read.unread).toBeUndefined();
    const update = await call(reader.key, "GET", "/update");
    expect(update.status).toBe(200);
    expect(Object.keys(read.update as object).sort()).toEqual(
      Object.keys(update.body).sort(),
    );
    // The witness: another permission that lists the tool does not add them,
    // and names the bulk job it asked for and may not read.
    const connectors = await mint({ permissions: ["connectors.manage"] });
    const plain = toolResult(
      await callTool(await admin(connectors.key), "marfa_health", {}),
    );
    expect(plain.health).toBeDefined();
    expect(plain.connectors).toBeDefined();
    for (const name of opened) {
      expect(plain[name], name).toBeUndefined();
    }
    expect(plain.unread).toBeUndefined();
    const asked = toolResult(
      await callTool(await admin(connectors.key), "marfa_health", {
        job_id: uuidv7(),
      }),
    ) as Record<string, unknown> & { unread: { read: string; code: string }[] };
    expect(asked.unread).toEqual([
      expect.objectContaining({ read: "job", code: "forbidden" }),
    ]);
    expect(asked.connectors).toBeDefined();
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

  it("lists a connector with its runs and makes an endpoint for it, refusing as the API does", async () => {
    const owner = await mint({ permissions: ["connectors.manage"] });
    const id = await registered(owner.key, "Read through a tool");
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
    ) as {
      runs: { id: string }[];
      runs_next_cursor: string | null;
      endpoints: { id: string }[];
    };
    const runs = await call(owner.key, "GET", `/connectors/${id}/runs`);
    expect(one.runs.map((run) => run.id)).toEqual(
      (runs.body.data as { id: string }[]).map((run) => run.id),
    );
    expect(one.runs).toHaveLength(1);
    expect(one.runs_next_cursor).toBeNull();
    expect(one.endpoints).toEqual([]);
    const missing = uuidv7();
    expectSameRefusal(
      await call(owner.key, "GET", `/connectors/${missing}`),
      await callTool(connection, "marfa_connectors", { id: missing }),
      "read",
    );
    expectSameRefusal(
      await call(owner.key, "POST", `/connectors/${missing}/endpoints`, {
        label: "Deliveries",
      }),
      await callTool(connection, "marfa_make_endpoint", {
        id: missing,
        label: "Deliveries",
      }),
      "make an endpoint",
    );
    const made = toolResult(
      await callTool(connection, "marfa_make_endpoint", {
        id,
        label: "Deliveries",
      }),
    ) as { endpoint: { id: string } };
    const endpoints = await call(
      owner.key,
      "GET",
      `/connectors/${id}/endpoints`,
    );
    expect(
      (endpoints.body.data as { id: string }[]).map((row) => row.id),
    ).toEqual([made.endpoint.id]);
  });

  it("pages a connector's runs that do not fit one answer, each page continuing where the last stopped", async () => {
    const owner = await mint({ permissions: ["connectors.manage"] });
    const id = await registered(owner.key, "Runs paged through a tool");
    const count = 24;
    for (let index = 0; index < count; index += 1) {
      const minute = String(index).padStart(2, "0");
      const reported = await call(owner.key, "POST", `/connectors/${id}/runs`, {
        outcome: "failed",
        started_at: `2026-01-01T00:${minute}:00.000Z`,
        finished_at: `2026-01-01T00:${minute}:30.000Z`,
        summary: `run ${minute} `.repeat(250).slice(0, 2000),
        error: `failed ${minute} `.repeat(200).slice(0, 2000),
      });
      expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    }
    const whole = await call(
      owner.key,
      "GET",
      `/connectors/${id}/runs?limit=200`,
    );
    const expected = (whole.body.data as { id: string }[]).map((run) => run.id);
    expect(expected).toHaveLength(count);
    const connection = await admin(owner.key);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const args: Record<string, unknown> = { id, runs_limit: count };
      if (cursor !== null) args.runs_cursor = cursor;
      const page = toolResult(
        await callTool(connection, "marfa_connectors", args),
      ) as { runs: { id: string }[]; runs_next_cursor: string | null };
      expect(page.runs.length).toBeGreaterThan(0);
      seen.push(...page.runs.map((run) => run.id));
      cursor = page.runs_next_cursor;
      pages += 1;
    } while (cursor !== null && pages < count);
    // More than one page, so a page was cut short and its cursor followed it.
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(expected);
  });

  it("answers a connector's metadata with its first page of runs only, so every page of a connector with many declared types stays within the budget", async () => {
    const owner = await mint({ permissions: ["connectors.manage"] });
    const declared = Array.from(
      { length: 900 },
      (_, n) => `acme.declared.${"t".repeat(38)}${String(n).padStart(4, "0")}`,
    );
    const created = await call(owner.key, "POST", "/connectors", {
      name: "Many declared types",
      read_only_types: declared,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    const count = 6;
    for (let index = 0; index < count; index += 1) {
      const reported = await call(owner.key, "POST", `/connectors/${id}/runs`, {
        outcome: "succeeded",
        started_at: `2026-01-01T00:0${String(index)}:00.000Z`,
        finished_at: `2026-01-01T00:0${String(index)}:30.000Z`,
        summary: `run ${String(index)}`,
      });
      expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    }
    const whole = await call(owner.key, "GET", `/connectors/${id}`);
    expect(whole.body.read_only_types).toEqual(declared);
    const expected = (
      (await call(owner.key, "GET", `/connectors/${id}/runs?limit=200`)).body
        .data as { id: string }[]
    ).map((run) => run.id);
    expect(expected).toHaveLength(count);

    const connection = await admin(owner.key);
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const args: Record<string, unknown> = { id, runs_limit: 2 };
      if (cursor !== null) args.runs_cursor = cursor;
      const answer = await callTool(connection, "marfa_connectors", args);
      const page = toolResult(answer) as {
        connector?: {
          read_only_types: string[];
          read_only_types_left_out?: number;
        };
        endpoints?: unknown[];
        runs: { id: string }[];
        runs_next_cursor: string | null;
      };
      sizes.push(answer.text.length);
      expect(page.runs.length).toBeGreaterThan(0);
      seen.push(...page.runs.map((run) => run.id));
      if (pages === 0) {
        const kept = page.connector?.read_only_types ?? [];
        expect(page.endpoints).toEqual([]);
        expect(kept.length).toBeGreaterThan(0);
        expect(kept).toEqual(declared.slice(0, kept.length));
        expect(
          kept.length + (page.connector?.read_only_types_left_out ?? 0),
        ).toBe(declared.length);
      } else {
        expect(page.connector).toBeUndefined();
        expect(page.endpoints).toBeUndefined();
      }
      cursor = page.runs_next_cursor;
      pages += 1;
    } while (cursor !== null && pages < count);
    expect(pages).toBe(3);
    expect(seen).toEqual(expected);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(40_000);
    // The witness: a connector that declares few types answers them all.
    const other = await mint({ permissions: ["connectors.manage"] });
    const small = await registered(other.key, "Few declared types");
    const read = toolResult(
      await callTool(await admin(other.key), "marfa_connectors", { id: small }),
    ) as { connector: Record<string, unknown> };
    expect(read.connector.read_only_types).toEqual([]);
    expect(read.connector.read_only_types_left_out).toBeUndefined();
  });

  it("lists a file's copies through the files tool, as the API does", async () => {
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
  });

  it(
    "runs the trash's retention through the maintenance tool, removing only what the retention makes eligible and no chosen item",
    async () => {
      // A server of its own: the item's age is a clock the file's server keeps.
      const own = await bootFreshServer(
        "owner-tasks-retention",
        QUIET_SCHEDULE,
      );
      ownServers.push(own);
      const connection = await (async () => {
        const minted = await controlRequest(own.controlSocket, "/keys", {
          method: "POST",
          body: {
            label: "owner tasks retention",
            source: "retention-maintainer",
            permissions: ["instance.maintain", "items.purge"],
            type_permissions: { "core.note": "write" },
          },
        });
        expect(minted.status, JSON.stringify(minted.body)).toBe(201);
        const opened = await connectMcp(
          own.apiUrl,
          (minted.body as unknown as Minted).key,
          "2026-07-28",
          "/mcp/admin",
        );
        connections.push(opened);
        return opened;
      })();
      await quiet(own, ["trash-purge"]);
      const writer = writerOf(own);
      const config = (await writer.getConfig()).data as Record<string, unknown>;
      expect(
        (await writer.updateConfig({ ...config, trash_retention_days: 1 }))
          .status,
      ).toBe(200);
      const binned = async (title: string) => {
        const made = await writer.createItem({
          type: "core.note",
          properties: { body: title },
        });
        expect(made.ok, JSON.stringify(made.error)).toBe(true);
        expect((await writer.deleteItem(made.data.item.id)).ok).toBe(true);
        return made.data.item.id;
      };
      const inBin = async (id: string) =>
        (await writer.getItem(id, "trashed")).status === 200;
      const old = await binned("trashed before the retention ended");
      await movedClock(own).advance(2 * DAY_MS);
      const recent = await binned("trashed inside the retention period");
      // The witness: both are in the bin, and the tool names no item to purge.
      expect(await inBin(old)).toBe(true);
      expect(await inBin(recent)).toBe(true);
      const { tools } = await connection.client.listTools();
      const maintain = tools.find((tool) => tool.name === "marfa_maintain");
      expect(
        Object.keys(maintain?.inputSchema.properties ?? {}).sort(),
      ).toEqual(["action", "confirm", "id", "name"]);

      const run = toolResult(
        await callTool(connection, "marfa_maintain", {
          action: "run_housekeeping",
          name: "trash-purge",
        }),
      ) as { ended: { outcome: string } };
      expect(run.ended.outcome).toBe("succeeded");
      // Eligible by the policy: gone for good. Inside the retention: still there.
      expect((await writer.getItem(old, "any")).status).toBe(404);
      expect(await inBin(recent)).toBe(true);
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});
