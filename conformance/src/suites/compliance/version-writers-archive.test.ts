import { v7 as uuidv7 } from "uuid";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { controlRequest } from "../../utils/control-request.js";
import {
  approvedApp,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  archiveLines,
  editLineFile,
  readLineFile,
  itemsArchive,
} from "../../utils/archive.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

/**
 * Who wrote each version, through an archive: an export carries each
 * version's writer, and a second server takes the archive back with them.
 * The writers are made as `version-writers.test.ts` makes them.
 */
let server: FreshServer;
let target: FreshServer;

beforeAll(async () => {
  [server, target] = await Promise.all([
    bootFreshServer("version-writers-archive"),
    bootFreshServer("version-writers-archive-restore"),
  ]);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([server?.stop(), target?.stop()]);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

interface Writer {
  kind: string;
  id: string;
  name: string;
}

interface Snapshot {
  version: number;
  writer: Writer | null;
}

/** The private local command's request, which carries no credential. */
function local(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return controlRequest(server.controlSocket, path, { method, body });
}

/** A key the local command mints. */
async function mintKey(
  label: string,
  typePermissions: Record<string, string> = { "core.note": "write" },
): Promise<{ id: string; key: string; label: string; source: string }> {
  const minted = await local("POST", "/keys", {
    label,
    source: `version-writers-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
    type_permissions: typePermissions,
  });
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  return minted.body as {
    id: string;
    key: string;
    label: string;
    source: string;
  };
}

async function call(
  bearer: string,
  method: string,
  path: string,
  body?: unknown,
  base = server.apiUrl,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
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

async function createNote(bearer: string, body = "first"): Promise<string> {
  const created = await call(bearer, "POST", "/items", {
    type: "core.note",
    properties: { body },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return (created.body.item as { id: string }).id;
}

async function changeNote(
  bearer: string,
  id: string,
  version: number,
  body: string,
): Promise<void> {
  const changed = await call(bearer, "PATCH", `/items/${id}`, {
    version,
    properties: { body },
  });
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
}

/** Every snapshot of an item that `bearer` may read. */
async function versionsOf(
  bearer: string,
  id: string,
  base = server.apiUrl,
): Promise<Snapshot[]> {
  const page = await call(
    bearer,
    "GET",
    `/items/${id}/versions?limit=200`,
    undefined,
    base,
  );
  expect(page.status, JSON.stringify(page.body)).toBe(200);
  await expectMatchesSchema("GET", "/items/{id}/versions", 200, page.body);
  return page.body.data as Snapshot[];
}

function writers(snapshots: Snapshot[]): (Writer | null)[] {
  return snapshots.map((snapshot) => snapshot.writer);
}

// eslint-disable-next-line no-control-regex
describe("who wrote each version, through an archive", () => {
  it("carries each writer through an archive, the current version's too, and keeps them on restore", async () => {
    const first = await mintKey("archived first writer");
    const second = await mintKey("archived second writer");
    const id = await createNote(first.key);
    await changeNote(second.key, id, 1, "second");
    await changeNote(first.key, id, 2, "third");
    const byFirst = {
      kind: "key",
      id: first.id,
      name: "archived first writer",
    };
    const bySecond = {
      kind: "key",
      id: second.id,
      name: "archived second writer",
    };

    const exporter = await mintKey("exporter", { "core.note": "read" });
    const archive = await new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: exporter.key,
    }).exportArchive({ type: "core.note", source: first.source });
    expect(archive.status).toBe(200);
    const line = (readLineFile(archive.data, "items") ?? "")
      .split("\n")
      .filter((text) => text.trim() !== "")
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find((parsed) => (parsed.item as { id: string }).id === id);
    expect(line, "the archive does not carry the note").toBeDefined();
    const versions = archiveLines<Snapshot & { item_id: string }>(
      archive.data,
      "versions",
    ).filter((snapshot) => snapshot.item_id === id);
    expect(writers(versions)).toEqual([byFirst, bySecond]);
    expect(line!.writer).toEqual(byFirst);

    const owner = new MarfaClient({
      baseUrl: target.apiUrl,
      apiKey: "",
      controlSocket: target.controlSocket,
    });
    const restored = await owner.restoreArchive(archive.data);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(
      writers(await versionsOf(target.workingKey, id, target.apiUrl)),
    ).toEqual([byFirst, bySecond]);
    // The archived current version keeps its writer once it is left behind.
    const changed = await call(
      target.workingKey,
      "PATCH",
      `/items/${id}`,
      { version: 3, properties: { body: "after the restore" } },
      target.apiUrl,
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(
      writers(await versionsOf(target.workingKey, id, target.apiUrl)),
    ).toEqual([byFirst, bySecond, byFirst]);
  });

  it("marks restored app connections inactive without changing their recorded fields", async () => {
    const properties = {
      kind: "app",
      client_id: "archived-client",
      user_id: "archived-owner",
      scopes: [],
      status: "active",
      granted_at: "2026-01-01T00:00:00.000Z",
    };
    const id = uuidv7();
    const owner = new MarfaClient({
      baseUrl: target.apiUrl,
      apiKey: "",
      controlSocket: target.controlSocket,
    });
    const restored = await owner.restoreArchive(
      itemsArchive([
        { id, type: "system.connection", source: "marfa/oauth", properties },
      ]),
    );
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    const row = await new MarfaClient({
      baseUrl: target.apiUrl,
      apiKey: target.workingKey,
    }).getItem(id);
    expect(row.status).toBe(200);
    expect(row.data.item.properties).toEqual({
      ...properties,
      status: "revoked",
    });
  });

  it("restores app-written items twice with their writers and separate natural keys", async () => {
    const app = await approvedApp(server, ["core.note:write"]);
    const sourceId = `restore-app-${String(Date.now())}`;
    const created = await call(app.token, "POST", "/items", {
      type: "core.note",
      source_id: sourceId,
      properties: { body: "old app" },
    });
    expect(created.status).toBe(201);
    const row = created.body.item as { id: string; source: string };
    await changeNote(app.token, row.id, 1, "old app second version");
    const before = await versionsOf(app.token, row.id);
    const exporter = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.workingKey,
    });
    const archive = await exporter.exportArchive({ source: row.source });
    expect(archive.status).toBe(200);
    const owner = new MarfaClient({
      baseUrl: target.apiUrl,
      apiKey: "",
      controlSocket: target.controlSocket,
    });
    const restored = await owner.restoreArchive(archive.data);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(
      (
        await new MarfaClient({
          baseUrl: target.apiUrl,
          apiKey: target.workingKey,
        }).getItem(row.id)
      ).data.item.source,
    ).toBe(`restored:${row.source}`);
    expect(
      writers(await versionsOf(target.workingKey, row.id, target.apiUrl)),
    ).toEqual(writers(before));
    const nextApp = await approvedApp(target, ["core.note:write"]);
    const next = await call(
      nextApp.token,
      "POST",
      "/items",
      {
        type: "core.note",
        source_id: sourceId,
        properties: { body: "new app" },
      },
      target.apiUrl,
    );
    expect(next.status).toBe(201);
    expect((next.body.item as { id: string }).id).not.toBe(row.id);
    const reader = new MarfaClient({
      baseUrl: target.apiUrl,
      apiKey: target.workingKey,
    });
    const again = await reader.exportArchive({
      source: `restored:${row.source}`,
    });
    expect(again.status).toBe(200);
    const secondTarget = await bootFreshServer("app-restore-again");
    try {
      const secondOwner = new MarfaClient({
        baseUrl: secondTarget.apiUrl,
        apiKey: "",
        controlSocket: secondTarget.controlSocket,
      });
      const second = await secondOwner.restoreArchive(again.data);
      expect(second.status, JSON.stringify(second.error)).toBe(200);
      expect(second.data.imported).toBe(1);
      expect(
        (
          await new MarfaClient({
            baseUrl: secondTarget.apiUrl,
            apiKey: secondTarget.workingKey,
          }).getItem(row.id)
        ).data.item.source,
      ).toBe(`restored:${row.source}`);
      expect(
        writers(
          await versionsOf(
            secondTarget.workingKey,
            row.id,
            secondTarget.apiUrl,
          ),
        ),
      ).toEqual(writers(before));
      const changed = await call(
        secondTarget.workingKey,
        "PATCH",
        `/items/${row.id}`,
        { version: 2, properties: { body: "after second restore" } },
        secondTarget.apiUrl,
      );
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      expect(
        writers(
          await versionsOf(
            secondTarget.workingKey,
            row.id,
            secondTarget.apiUrl,
          ),
        ),
      ).toEqual([...writers(before), before[0]!.writer]);
    } finally {
      await secondTarget.stop();
    }
  });

  it("restores an archive that names no writer with none", async () => {
    const minted = await mintKey("writer the archive forgets");
    const id = await createNote(minted.key, "forgotten");
    await changeNote(minted.key, id, 1, "second");
    await changeNote(minted.key, id, 2, "third");
    const exporter = await mintKey("forgetting exporter", {
      "core.note": "read",
    });
    const archive = await new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: exporter.key,
    }).exportArchive({ type: "core.note", source: minted.source });
    expect(archive.status).toBe(200);
    let stripped = 0;
    const unwritten = (body: string) =>
      body
        .split("\n")
        .filter((text) => text.trim() !== "")
        .map((text) => {
          const line = JSON.parse(text) as Record<string, unknown>;
          // The witness: the export named a writer to take out.
          if (line.writer) stripped += 1;
          delete line.writer;
          return `${JSON.stringify(line)}\n`;
        })
        .join("");
    const forgotten = editLineFile(
      editLineFile(archive.data, "items", unwritten),
      "versions",
      unwritten,
    );
    expect(stripped).toBe(3);
    const owner = new MarfaClient({
      baseUrl: target.apiUrl,
      apiKey: "",
      controlSocket: target.controlSocket,
    });
    const restored = await owner.restoreArchive(forgotten);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(
      writers(await versionsOf(target.workingKey, id, target.apiUrl)),
    ).toEqual([null, null]);
    const changed = await call(
      target.workingKey,
      "PATCH",
      `/items/${id}`,
      { version: 3, properties: { body: "after the restore" } },
      target.apiUrl,
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(
      writers(await versionsOf(target.workingKey, id, target.apiUrl)),
    ).toEqual([null, null, null]);
  });

  it("refuses an archive that names a malformed writer", async () => {
    const minted = await mintKey("archive source");
    const id = await createNote(minted.key, "malformed source");
    await changeNote(minted.key, id, 1, "second");
    const exporter = await mintKey("malformed exporter", {
      "core.note": "read",
    });
    const archive = await new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: exporter.key,
    }).exportArchive({ type: "core.note", source: minted.source });
    expect(archive.status).toBe(200);
    const owner = new MarfaClient({
      baseUrl: target.apiUrl,
      apiKey: "",
      controlSocket: target.controlSocket,
    });

    const edits: [
      string,
      "items" | "versions",
      (line: Record<string, unknown>) => void,
    ][] = [
      [
        "versions.1.writer.kind",
        "versions",
        (l) => {
          l.writer = { kind: "robot", id: "x", name: "x" };
        },
      ],
      [
        "versions.1.writer.name",
        "versions",
        (l) => {
          l.writer = { kind: "key", id: "x", name: "a\u0007b" };
        },
      ],
      [
        "writer.id",
        "items",
        (l) => {
          l.writer = { kind: "key", id: "", name: "x" };
        },
      ],
      [
        "writer",
        "items",
        (l) => {
          l.writer = "a key";
        },
      ],
    ];
    for (const [field, file, edit] of edits) {
      const edited = editLineFile(archive.data, file, (body) =>
        body
          .split("\n")
          .filter((text) => text.trim() !== "")
          .map((text) => {
            const parsed = JSON.parse(text) as Record<string, unknown>;
            const owner =
              file === "items"
                ? (parsed.item as { id: string }).id
                : (parsed.item_id as string);
            if (owner === id && (file === "items" || parsed.version === 1)) {
              edit(parsed);
            }
            return `${JSON.stringify(parsed)}\n`;
          })
          .join(""),
      );
      const refused = await owner.restoreArchive(edited);
      expect(refused.status, field).toBe(400);
      expect(refused.error?.error.code, field).toBe("validation_error");
      expect(
        (refused.error?.error.details as { field?: string } | undefined)?.field,
        field,
      ).toBe(field);
    }
  });
});
