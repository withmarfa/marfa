import { signInOwnerWithPassword } from "../../client/owner-session.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { TEST_OWNER as OWNER } from "../../utils/target.js";
import { controlRequest } from "../../utils/control-request.js";
import {
  approvedApp,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { QUIET_SCHEDULE } from "../../utils/moved-clock.js";
import { connect, issuerOrigin, registerApp } from "../../utils/signed-in.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

/**
 * Who wrote each version: the sign-in whose request wrote it, kept with the
 * version. Each kind of sign-in writes here the way it does in use: a key and
 * an app through the item operations, the owner's browser through the approval
 * that records an app, the local command through the sign-in operations that
 * change that record, and the enrichment sweep on its own. How an archive
 * carries writers is in `version-writers-archive.test.ts`.
 */
let server: FreshServer;
let origin: string;

const CLIENT_HEADER = "x-conformance-client";
const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
let addresses = 0;

beforeAll(async () => {
  server = await bootFreshServer("version-writers", {
    ...QUIET_SCHEDULE,
    MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
    MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
    MARFA_ENRICHMENT_ENABLED: "true",
  });
  origin = await issuerOrigin(server);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

interface Writer {
  kind: string;
  id: string;
  name: string;
}

interface Snapshot {
  version: number;
  writer: Writer | null;
}

interface Browser {
  cookie: string;
  /** Its session's ID in the sign-in listing. */
  id: string;
}

/** The owner signs in from a browser of its own address. */
async function signIn(userAgent = SAFARI): Promise<Browser> {
  const before = new Set((await signIns()).map((row) => row.id));
  addresses += 1;
  const cookie = await signInOwnerWithPassword(
    server.apiUrl,
    origin,
    { username: OWNER.username, password: OWNER.password },
    {
      "user-agent": userAgent,
      [CLIENT_HEADER]: `198.51.100.${String(addresses)}`,
    },
  );
  const own = (await signIns()).find(
    (row) => row.kind === "browser" && !before.has(row.id),
  );
  expect(own, "the listing holds no new browser session").toBeDefined();
  return { cookie, id: own!.id };
}

interface ListedSignIn {
  id: string;
  kind: string;
  name: string;
}

async function signIns(): Promise<ListedSignIn[]> {
  const response = await local("GET", "/owner/sign-ins");
  expect(response.status).toBe(200);
  return response.body.data as ListedSignIn[];
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
  permissions: string[] = [],
): Promise<{ id: string; key: string; label: string; source: string }> {
  const minted = await local("POST", "/keys", {
    label,
    source: `version-writers-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
    permissions,
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

const APP_SCOPE = "core.note:read core.note:write offline_access";

/** An app registered under `name` and approved in `browser`. */
async function approveApp(
  browser: Browser,
  name: string,
): Promise<{ accessToken: string; clientId: string }> {
  const app = await registerApp(server, APP_SCOPE, { client_name: name });
  const tokens = await connect(server, origin, browser.cookie, app, APP_SCOPE);
  expect(tokens.access_token).toBeTruthy();
  return { accessToken: tokens.access_token!, clientId: app.clientId };
}

function listedApp(rows: ListedSignIn[], name: string): ListedSignIn {
  const row = rows.find((r) => r.kind === "app" && r.name === name);
  expect(row, `no app named ${name} is listed`).toBeDefined();
  return row!;
}

async function renameApp(id: string, name: string): Promise<number> {
  return (
    await local("PATCH", `/owner/sign-ins/${encodeURIComponent(id)}`, { name })
  ).status;
}

async function endSignIn(id: string): Promise<number> {
  return (await local("DELETE", `/owner/sign-ins/${encodeURIComponent(id)}`))
    .status;
}

// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

describe("who wrote each version", () => {
  it("names the key that wrote each version by its id and label", async () => {
    const minted = await mintKey("the writing key");
    const id = await createNote(minted.key);
    await changeNote(minted.key, id, 1, "second");
    await changeNote(minted.key, id, 2, "third");
    const byKey = { kind: "key", id: minted.id, name: "the writing key" };
    expect(writers(await versionsOf(minted.key, id))).toEqual([byKey, byKey]);

    const read = await call(minted.key, "GET", `/items/${id}?include=versions`);
    expect(read.status).toBe(200);
    const carried = (read.body.versions as { data: Snapshot[] }).data;
    expect(writers(carried)).toEqual([byKey, byKey]);
  });

  it("names the app that wrote a version by the id and name the sign-in listing gives it", async () => {
    // A device's sign-in: the device grant, approved in the owner's browser.
    const app = await approvedApp(server, ["core.note:write"]);
    const id = await createNote(app.token);
    await changeNote(app.token, id, 1, "second");
    const listed = (await signIns()).find(
      (row) => row.kind === "app" && row.name === "conformance",
    );
    expect(listed, "the device's app is not listed").toBeDefined();
    expect(writers(await versionsOf(app.token, id))).toEqual([
      { kind: "app", id: listed!.id, name: "conformance" },
    ]);

    // The name the owner gives the app names what it writes next.
    expect(await renameApp(listed!.id, "Desk laptop")).toBe(200);
    await changeNote(app.token, id, 2, "third");
    await changeNote(app.token, id, 3, "fourth");
    expect(writers(await versionsOf(app.token, id))).toEqual([
      { kind: "app", id: listed!.id, name: "conformance" },
      { kind: "app", id: listed!.id, name: "conformance" },
      { kind: "app", id: listed!.id, name: "Desk laptop" },
    ]);
  });

  it("names the owner's browser and the local command that changed an app's record", async () => {
    const browser = await signIn();
    const session = (await signIns()).find((row) => row.id === browser.id)!;
    expect(session.name).toBe("Safari on macOS");
    await approveApp(browser, "record app");
    const record = listedApp(await signIns(), "record app");
    expect(await renameApp(record.id, "renamed first")).toBe(200);
    const renamed = await local("PATCH", `/owner/sign-ins/${record.id}`, {
      name: "renamed locally",
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(
      (await local("PATCH", `/owner/sign-ins/${record.id}`, { name: "last" }))
        .status,
    ).toBe(200);

    const reader = await mintKey(
      "record reader",
      { "system.connection": "read" },
      ["grants.manage"],
    );
    const byBrowser = {
      kind: "browser",
      id: session.id,
      name: "Safari on macOS",
    };
    expect(writers(await versionsOf(reader.key, record.id))).toEqual([
      // The browser's approval, then the local command's renames.
      byBrowser,
      { kind: "local", id: "local", name: "Local command" },
      { kind: "local", id: "local", name: "Local command" },
    ]);
  });

  it("still names each writer once the key is revoked, the app ended and the browser session ended", async () => {
    const other = await signIn();
    const otherSession = (await signIns()).find((row) => row.id === other.id)!;
    const app = await approveApp(other, "app that ends");
    const appRow = listedApp(await signIns(), "app that ends");
    const minted = await mintKey("key that ends");
    const reader = await mintKey(
      "reader that stays",
      { "core.note": "read", "system.connection": "read" },
      ["grants.manage"],
    );

    const note = await createNote(minted.key);
    await changeNote(app.accessToken, note, 1, "by the app");
    await changeNote(minted.key, note, 2, "by the key");
    // The record of the app that the other browser approved, renamed by the
    // local command.
    expect(await renameApp(appRow.id, "app that ended")).toBe(200);

    const noteBefore = await versionsOf(reader.key, note);
    const recordBefore = await versionsOf(reader.key, appRow.id);
    const byKey = { kind: "key", id: minted.id, name: "key that ends" };
    const byApp = { kind: "app", id: appRow.id, name: "app that ends" };
    const byOther = {
      kind: "browser",
      id: otherSession.id,
      name: "Safari on macOS",
    };
    expect(writers(noteBefore)).toEqual([byKey, byApp]);
    expect(writers(recordBefore)).toEqual([byOther]);

    expect(await endSignIn(minted.id)).toBe(200);
    expect(await endSignIn(appRow.id)).toBe(200);
    expect(await endSignIn(otherSession.id)).toBe(200);
    // Each is gone from the listing, so nothing live is left to name it.
    const live = (await signIns()).map((row) => row.id);
    expect(live).not.toContain(minted.id);
    expect(live).not.toContain(appRow.id);
    expect(live).not.toContain(otherSession.id);

    expect(await versionsOf(reader.key, note)).toEqual(noteBefore);
    // Ending the app wrote its record once more, which left the local
    // command's rename behind it.
    const recordAfter = await versionsOf(reader.key, appRow.id);
    expect(recordAfter.slice(0, 1)).toEqual(recordBefore);
    expect(writers(recordAfter)).toEqual([
      byOther,
      { kind: "local", id: "local", name: "Local command" },
    ]);
  });

  it("takes the writer from the credential, and refuses one a create or an update names", async () => {
    const minted = await mintKey("honest key");
    const forged = { kind: "key", id: "someone-else", name: "Someone else" };
    const refusedCreate = await call(minted.key, "POST", "/items", {
      type: "core.note",
      properties: { body: "first" },
      writer: forged,
    });
    expect(refusedCreate.status).toBe(400);
    expect(refusedCreate.body.error).toMatchObject({
      code: "validation_error",
    });
    expect(JSON.stringify(refusedCreate.body)).toContain("writer");

    // The witness: the same body without `writer` is created.
    const created = await call(minted.key, "POST", "/items", {
      type: "core.note",
      properties: { body: "first" },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = (created.body.item as { id: string }).id;
    expect(created.body.item).not.toHaveProperty("writer");

    const refused = await call(minted.key, "PATCH", `/items/${id}`, {
      version: 1,
      properties: { body: "second" },
      writer: forged,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: "validation_error" });
    expect(JSON.stringify(refused.body)).toContain("writer");

    await changeNote(minted.key, id, 1, "second");
    expect(writers(await versionsOf(minted.key, id))).toEqual([
      { kind: "key", id: minted.id, name: "honest key" },
    ]);
  });

  it("names the sign-in that sends a queued write, not the one that read the version it is based on", async () => {
    const author = await mintKey("author");
    const reader = await mintKey("device before it signed in again");
    const sender = await mintKey("device after it signed in again");
    const id = await createNote(author.key);
    // The device reads version 1 under its first sign-in and queues an edit.
    const read = await call(reader.key, "GET", `/items/${id}`);
    expect(read.status).toBe(200);
    expect((read.body.item as { version: number }).version).toBe(1);
    await changeNote(author.key, id, 1, "changed meanwhile");

    // It sends the edit later, under its new sign-in, based on version 1.
    const sent = await call(sender.key, "PATCH", `/items/${id}`, {
      version: 1,
      properties: { title: "queued offline" },
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect((sent.body.item as { version: number }).version).toBe(3);
    await changeNote(author.key, id, 3, "after the drain");

    expect(writers(await versionsOf(author.key, id))).toEqual([
      { kind: "key", id: author.id, name: "author" },
      { kind: "key", id: author.id, name: "author" },
      { kind: "key", id: sender.id, name: "device after it signed in again" },
    ]);
  });

  it("names the sign-in whose write lost as the writer of the copy that keeps it", async () => {
    const winner = await mintKey("winning key");
    const loser = await mintKey("losing key");
    const created = await call(winner.key, "POST", "/items", {
      type: "core.note",
      properties: { title: "both edit", body: "original" },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = (created.body.item as { id: string }).id;
    await changeNote(winner.key, id, 1, "from the winner");
    const resolved = await call(
      loser.key,
      "PATCH",
      `/items/${id}?conflict=auto`,
      {
        version: 1,
        properties: { body: "from the loser" },
      },
    );
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const copyId = (
      resolved.body.conflict_resolution as { conflicted_copy_id?: string }
    ).conflicted_copy_id;
    expect(copyId, "the resolution kept no copy").toBeTruthy();

    await changeNote(winner.key, copyId!, 1, "the copy, read");
    expect(writers(await versionsOf(winner.key, copyId!))).toEqual([
      { kind: "key", id: loser.id, name: "losing key" },
    ]);
    expect(writers(await versionsOf(winner.key, id))).toEqual([
      { kind: "key", id: winner.id, name: "winning key" },
      { kind: "key", id: winner.id, name: "winning key" },
    ]);
  });

  it("names no writer for a version the enrichment sweep wrote", async () => {
    const minted = await mintKey("file writer", { "core.file": "write" });
    const bytes = new TextEncoder().encode("the bilby ledger, page one");
    const client = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: minted.key,
    });
    const upload = await client.uploadBlob(bytes, "text/plain");
    expect(upload.status).toBe(201);
    const created = await call(minted.key, "POST", "/items", {
      type: "core.file",
      properties: {
        blob_ref: upload.data.hash,
        mime_type: "text/plain",
        title: "ledger",
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = (created.body.item as { id: string }).id;

    const operator = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.managementKey,
    });
    const run = await operator.runHousekeeping("enrichment-sweep");
    expect(run.status).toBe(200);
    expect(run.data.outcome, run.data.error ?? "").toBe("succeeded");
    const enriched = await call(minted.key, "GET", `/items/${id}`);
    const item = enriched.body.item as {
      version: number;
      properties: Record<string, unknown>;
    };
    // The witness: the sweep wrote a version of its own.
    expect(item.properties.extracted_text).toBe("the bilby ledger, page one");
    expect(item.version).toBe(2);

    const changed = await call(minted.key, "PATCH", `/items/${id}`, {
      version: 2,
      properties: { title: "ledger, read" },
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(writers(await versionsOf(minted.key, id))).toEqual([
      { kind: "key", id: minted.id, name: "file writer" },
      null,
    ]);
  });

  it("names a key or an app whose chosen name is unprintable or too long as the listing does", async () => {
    const browser = await signIn();
    for (const label of [
      `long\tlabel\u0007`,
      `over\u202eride`,
      "k".repeat(201),
    ]) {
      const minted = await mintKey(label);
      const id = await createNote(minted.key);
      await changeNote(minted.key, id, 1, "second");
      const listed = (await signIns()).find((row) => row.id === minted.id);
      // The witness: the listing gives this key its id, not its label.
      expect(listed?.name).toBe(minted.id);
      expect(writers(await versionsOf(minted.key, id))).toEqual([
        { kind: "key", id: minted.id, name: minted.id },
      ]);
    }

    const app = await approveApp(browser, `app\u0001${"a".repeat(90)}`);
    const note = await createNote(app.accessToken);
    await changeNote(app.accessToken, note, 1, "second");
    const [byApp] = await versionsOf(app.accessToken, note);
    expect(byApp!.writer).toMatchObject({ kind: "app", name: app.clientId });
    expect(byApp!.writer!.name.length).toBeLessThanOrEqual(200);
    expect(byApp!.writer!.name).not.toMatch(UNPRINTABLE);
  });
});

interface Answered {
  id: string;
  version: number;
  writer?: Writer | null;
}

/** `GET /items/{id}` as `bearer` reads it, naming `include` and `state` as given. */
async function readItem(
  bearer: string,
  id: string,
  query = "include=writer",
): Promise<{ status: number; item: Answered; body: Record<string, unknown> }> {
  const read = await call(bearer, "GET", `/items/${id}?${query}`);
  if (read.status === 200) {
    await expectMatchesSchema("GET", "/items/{id}", 200, read.body);
  }
  return {
    status: read.status,
    item: read.body.item as Answered,
    body: read.body,
  };
}

/** `POST /items/bulk-get` as `bearer` reads it. */
async function bulkGet(
  bearer: string,
  ids: string[],
  include: string[] = ["writer"],
): Promise<Answered[]> {
  const read = await call(bearer, "POST", "/items/bulk-get", { ids, include });
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  await expectMatchesSchema("POST", "/items/bulk-get", 200, read.body);
  return read.body.data as Answered[];
}

describe("who wrote an item's current version", () => {
  it("answers the key that wrote the current version, from version 1 on, on both doors", async () => {
    const creator = await mintKey("creating key");
    const editor = await mintKey("editing key");
    const id = await createNote(creator.key);
    const byCreator = { kind: "key", id: creator.id, name: "creating key" };
    const byEditor = { kind: "key", id: editor.id, name: "editing key" };

    // The item is still at version 1, which no snapshot holds.
    expect(await versionsOf(creator.key, id)).toEqual([]);
    const first = await readItem(creator.key, id);
    expect(first.status).toBe(200);
    expect(first.item.version).toBe(1);
    expect(first.item.writer).toEqual(byCreator);

    await changeNote(editor.key, id, 1, "second");
    const second = await readItem(creator.key, id);
    expect(second.item.version).toBe(2);
    expect(second.item.writer).toEqual(byEditor);

    const other = await createNote(creator.key, "another");
    const bulk = await bulkGet(creator.key, [other, id, other]);
    expect(bulk.map((item) => item.id)).toEqual([other, id]);
    expect(bulk.map((item) => item.writer)).toEqual([byCreator, byEditor]);
  });

  it("answers the app, the owner's browser and the local command that wrote an app's record", async () => {
    const browser = await signIn();
    const session = (await signIns()).find((row) => row.id === browser.id)!;
    const app = await approveApp(browser, "writer app");
    const record = listedApp(await signIns(), "writer app");
    const reader = await mintKey(
      "current writer reader",
      { "system.connection": "read", "core.note": "write" },
      ["grants.manage"],
    );

    const approved = await readItem(reader.key, record.id);
    expect(approved.item.writer).toEqual({
      kind: "browser",
      id: session.id,
      name: "Safari on macOS",
    });
    expect(await renameApp(record.id, "writer app renamed")).toBe(200);
    const renamed = await readItem(reader.key, record.id);
    expect(renamed.item.writer).toEqual({
      kind: "local",
      id: "local",
      name: "Local command",
    });

    const note = await createNote(app.accessToken);
    const byApp = {
      kind: "app",
      id: record.id,
      name: "writer app renamed",
    };
    expect((await readItem(reader.key, note)).item.writer).toEqual(byApp);
    const hidden = await bulkGet(
      reader.key,
      [record.id, note],
      ["writer", "hidden"],
    );
    expect(hidden.map((item) => item.writer)).toEqual([
      { kind: "local", id: "local", name: "Local command" },
      byApp,
    ]);
  });

  it("answers null for a current version the enrichment sweep wrote", async () => {
    const minted = await mintKey("sweep file writer", { "core.file": "write" });
    const client = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: minted.key,
    });
    const upload = await client.uploadBlob(
      new TextEncoder().encode("the bilby ledger, page two"),
      "text/plain",
    );
    expect(upload.status).toBe(201);
    const created = await call(minted.key, "POST", "/items", {
      type: "core.file",
      properties: {
        blob_ref: upload.data.hash,
        mime_type: "text/plain",
        title: "second ledger",
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = (created.body.item as { id: string }).id;
    // The witness: before the sweep a sign-in is the writer.
    expect((await readItem(minted.key, id)).item.writer).toEqual({
      kind: "key",
      id: minted.id,
      name: "sweep file writer",
    });

    const operator = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.managementKey,
    });
    const run = await operator.runHousekeeping("enrichment-sweep");
    expect(run.status).toBe(200);
    expect(run.data.outcome, run.data.error ?? "").toBe("succeeded");
    const swept = await readItem(minted.key, id);
    expect(swept.item.version).toBe(2);
    expect(swept.item.writer).toBeNull();
    expect(swept.body.item).toHaveProperty("writer", null);
    expect((await bulkGet(minted.key, [id]))[0]!.writer).toBeNull();
  });

  it("answers the sign-in whose write merged, and the one whose write lost as the copy's writer", async () => {
    const author = await mintKey("merge author");
    const merger = await mintKey("merging key");
    const loser = await mintKey("conflicting key");
    const created = await call(author.key, "POST", "/items", {
      type: "core.note",
      properties: { title: "both edit", body: "original" },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = (created.body.item as { id: string }).id;
    await changeNote(author.key, id, 1, "from the author");

    // A stale write to a field nobody changed merges over version 2.
    const merged = await call(merger.key, "PATCH", `/items/${id}`, {
      version: 1,
      properties: { title: "both edit, retitled" },
    });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect((merged.body.item as { version: number }).version).toBe(3);
    const afterMerge = await readItem(author.key, id);
    expect(afterMerge.item.version).toBe(3);
    expect(afterMerge.item.writer).toEqual({
      kind: "key",
      id: merger.id,
      name: "merging key",
    });

    const resolved = await call(
      loser.key,
      "PATCH",
      `/items/${id}?conflict=auto`,
      { version: 1, properties: { body: "from the loser" } },
    );
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const copyId = (
      resolved.body.conflict_resolution as { conflicted_copy_id?: string }
    ).conflicted_copy_id;
    expect(copyId, "the resolution kept no copy").toBeTruthy();
    expect((await readItem(author.key, copyId!)).item.writer).toEqual({
      kind: "key",
      id: loser.id,
      name: "conflicting key",
    });
  });

  it("answers the writer a revoked key had, with the name it had when it wrote", async () => {
    const minted = await mintKey("key that is revoked");
    const reader = await mintKey("current writer survivor", {
      "core.note": "read",
    });
    const id = await createNote(minted.key);
    await changeNote(minted.key, id, 1, "second");
    const byKey = { kind: "key", id: minted.id, name: "key that is revoked" };
    expect((await readItem(reader.key, id)).item.writer).toEqual(byKey);

    expect(await endSignIn(minted.id)).toBe(200);
    expect((await signIns()).map((row) => row.id)).not.toContain(minted.id);
    expect((await readItem(reader.key, id)).item.writer).toEqual(byKey);
    expect((await bulkGet(reader.key, [id]))[0]!.writer).toEqual(byKey);
  });

  it("answers the current writer of an archived item, and of one in the bin where the read names the state", async () => {
    const minted = await mintKey("lifecycle writer");
    const mover = await mintKey("lifecycle mover");
    const id = await createNote(minted.key);
    const byKey = { kind: "key", id: minted.id, name: "lifecycle writer" };
    const client = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: mover.key,
    });

    expect((await client.transitionItem(id, "archived")).status).toBe(200);
    // The move wrote no version, so the writer is the one who wrote it.
    const archived = await readItem(minted.key, id);
    expect(archived.status).toBe(200);
    expect(archived.item.writer).toEqual(byKey);
    expect((await bulkGet(minted.key, [id]))[0]!.writer).toEqual(byKey);

    expect((await client.transitionItem(id, "trashed")).status).toBe(200);
    // The witness: the bin refuses a read that names no state.
    expect((await readItem(minted.key, id)).status).toBe(404);
    const trashed = await readItem(
      minted.key,
      id,
      "include=writer&state=trashed",
    );
    expect(trashed.status, JSON.stringify(trashed.body)).toBe(200);
    expect(trashed.item.writer).toEqual(byKey);
    expect(await bulkGet(minted.key, [id])).toEqual([]);
  });

  it("leaves the writer off an item read that does not name it, and off every other member", async () => {
    const minted = await mintKey("quiet writer");
    const id = await createNote(minted.key);
    // The witness: the same read names the writer when asked.
    expect((await readItem(minted.key, id)).item).toHaveProperty("writer");
    expect((await bulkGet(minted.key, [id]))[0]).toHaveProperty("writer");

    for (const query of [
      "",
      "include=metadata",
      "include=versions,backrefs,neighbors",
    ]) {
      const read = await readItem(minted.key, id, query);
      expect(read.status).toBe(200);
      expect(read.item).not.toHaveProperty("writer");
      expect(read.body).not.toHaveProperty("writer");
    }
    for (const include of [[], ["metadata", "edges", "extensions"]]) {
      expect((await bulkGet(minted.key, [id], include))[0]).not.toHaveProperty(
        "writer",
      );
    }
    const listed = await call(minted.key, "GET", "/items?include=metadata");
    expect(listed.status).toBe(200);
    for (const item of listed.body.data as Answered[]) {
      expect(item).not.toHaveProperty("writer");
    }
  });

  it("gives a key that may not read the item's type no writer, and no refusal other than the item's", async () => {
    const minted = await mintKey("writer of a closed type");
    const narrow = await mintKey("reader of another type", {
      "core.task": "read",
    });
    const wide = await mintKey("reader of the type", { "core.note": "read" });
    const id = await createNote(minted.key);

    // The witness: a key that reads the type is told.
    expect((await readItem(wide.key, id)).item.writer).toMatchObject({
      id: minted.id,
    });
    expect((await bulkGet(wide.key, [id]))[0]!.writer).toMatchObject({
      id: minted.id,
    });

    const refused = await readItem(narrow.key, id);
    expect(refused.status).toBe(404);
    expect(JSON.stringify(refused.body)).not.toContain(minted.id);
    expect(JSON.stringify(refused.body)).not.toContain("writer of a closed");
    expect(await bulkGet(narrow.key, [id])).toEqual([]);
    const nothing = await call(
      (await mintKey("reader of no type", {})).key,
      "POST",
      "/items/bulk-get",
      { ids: [id], include: ["writer"] },
    );
    expect(nothing.status).toBe(403);
  });

  it("refuses an include value it does not know beside writer, on both doors", async () => {
    const minted = await mintKey("include writer");
    const id = await createNote(minted.key);
    const unknown = await readItem(minted.key, id, "include=writer,authors");
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatchObject({ code: "validation_error" });
    const bulk = await call(minted.key, "POST", "/items/bulk-get", {
      ids: [id],
      include: ["writer", "authors"],
    });
    expect(bulk.status).toBe(400);
    expect(bulk.body.error).toMatchObject({ code: "validation_error" });

    // The witness: each door takes writer beside the extras it knows.
    const known = await readItem(minted.key, id, "include=metadata,writer");
    expect(known.status).toBe(200);
    expect(known.item.writer).toMatchObject({ id: minted.id });
    expect(
      (await bulkGet(minted.key, [id], ["writer", "metadata"]))[0]!.writer,
    ).toMatchObject({ id: minted.id });
  });
});
