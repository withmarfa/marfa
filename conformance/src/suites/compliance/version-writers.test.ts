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
import { connect, issuerOrigin, registerApp } from "../../utils/signed-in.js";
import {
  listTarGzEntries,
  readTarGzEntry,
  tarGz,
} from "../../utils/archive.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

/**
 * Who wrote each version: the sign-in whose request wrote it, kept with the
 * version. Each kind of sign-in writes here the way it does in use: a key and
 * an app through the item operations, the owner's browser and the local
 * command through the sign-in operations that change an app's record, and the
 * enrichment sweep on its own. A second server takes the archive back.
 */
let server: FreshServer;
let target: FreshServer;
let origin: string;

const CLIENT_HEADER = "x-conformance-client";
const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
let addresses = 0;

beforeAll(async () => {
  [server, target] = await Promise.all([
    bootFreshServer("version-writers", {
      TRUSTED_PROXY_HEADER: CLIENT_HEADER,
      MARFA_ENRICHMENT_ENABLED: "true",
      // Driven through the housekeeping operation rather than the scheduler.
      MARFA_ENRICHMENT_INTERVAL_MS: "3600000",
    }),
    bootFreshServer("version-writers-restore"),
  ]);
  origin = await issuerOrigin(server);
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

interface Browser {
  cookie: string;
}

/** The owner signs in from a browser of its own address. */
async function signIn(userAgent = SAFARI): Promise<Browser> {
  addresses += 1;
  const response = await fetch(`${server.apiUrl}/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "user-agent": userAgent,
      [CLIENT_HEADER]: `198.51.100.${String(addresses)}`,
    },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.password }),
  });
  expect(response.status).toBe(200);
  const cookie = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
    response.headers.get("set-cookie") ?? "",
  )?.[1];
  expect(cookie, "sign-in set no session cookie").toBeTruthy();
  return { cookie: cookie! };
}

interface ListedSignIn {
  id: string;
  kind: string;
  name: string;
  current: boolean;
}

async function signIns(browser: Browser): Promise<ListedSignIn[]> {
  const response = await fetch(`${server.apiUrl}/owner/sign-ins`, {
    headers: { cookie: browser.cookie },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: ListedSignIn[] }).data;
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

function renameApp(
  browser: Browser,
  id: string,
  name: string,
): Promise<Response> {
  return fetch(`${server.apiUrl}/owner/sign-ins/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      cookie: browser.cookie,
      origin,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name }),
  });
}

function endSignIn(browser: Browser, id: string): Promise<Response> {
  return fetch(`${server.apiUrl}/owner/sign-ins/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { cookie: browser.cookie, origin },
  });
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

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
    const browser = await signIn();
    const listed = (await signIns(browser)).find(
      (row) => row.kind === "app" && row.name === "conformance",
    );
    expect(listed, "the device's app is not listed").toBeDefined();
    expect(writers(await versionsOf(app.token, id))).toEqual([
      { kind: "app", id: listed!.id, name: "conformance" },
    ]);

    // The name the owner gives the app names what it writes next.
    expect((await renameApp(browser, listed!.id, "Desk laptop")).status).toBe(
      200,
    );
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
    const session = (await signIns(browser)).find((row) => row.current)!;
    expect(session.name).toBe("Safari on macOS");
    await approveApp(browser, "record app");
    const record = listedApp(await signIns(browser), "record app");
    expect(
      (await renameApp(browser, record.id, "renamed in Safari")).status,
    ).toBe(200);
    const renamed = await local("PATCH", `/owner/sign-ins/${record.id}`, {
      name: "renamed locally",
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(
      (await local("PATCH", `/owner/sign-ins/${record.id}`, { name: "last" }))
        .status,
    ).toBe(200);

    const reader = await mintKey("record reader", {
      "system.connection": "read",
    });
    const byBrowser = {
      kind: "browser",
      id: session.id,
      name: "Safari on macOS",
    };
    expect(writers(await versionsOf(reader.key, record.id))).toEqual([
      // The approval, the browser's rename, then the local command's.
      byBrowser,
      byBrowser,
      { kind: "local", id: "local", name: "Local command" },
    ]);
  });

  it("still names each writer once the key is revoked, the app ended and the browser session ended", async () => {
    const browser = await signIn();
    const other = await signIn();
    const otherSession = (await signIns(other)).find((row) => row.current)!;
    const app = await approveApp(other, "app that ends");
    const appRow = listedApp(await signIns(browser), "app that ends");
    const minted = await mintKey("key that ends");
    const reader = await mintKey("reader that stays", {
      "core.note": "read",
      "system.connection": "read",
    });

    const note = await createNote(minted.key);
    await changeNote(app.accessToken, note, 1, "by the app");
    await changeNote(minted.key, note, 2, "by the key");
    // The record of the app that the other browser approved and renamed.
    expect((await renameApp(other, appRow.id, "app that ended")).status).toBe(
      200,
    );

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

    expect((await endSignIn(browser, minted.id)).status).toBe(200);
    expect((await endSignIn(browser, appRow.id)).status).toBe(200);
    expect((await endSignIn(browser, otherSession.id)).status).toBe(200);
    // Each is gone from the listing, so nothing live is left to name it.
    const live = (await signIns(browser)).map((row) => row.id);
    expect(live).not.toContain(minted.id);
    expect(live).not.toContain(appRow.id);
    expect(live).not.toContain(otherSession.id);

    expect(await versionsOf(reader.key, note)).toEqual(noteBefore);
    // Ending the app wrote its record once more, which left the rename the
    // ended browser made behind it.
    const recordAfter = await versionsOf(reader.key, appRow.id);
    expect(recordAfter.slice(0, 1)).toEqual(recordBefore);
    expect(writers(recordAfter)).toEqual([byOther, byOther]);
  });

  it("takes the writer from the credential, drops one a create names and refuses one an update names", async () => {
    const minted = await mintKey("honest key");
    const forged = { kind: "key", id: "someone-else", name: "Someone else" };
    const created = await call(minted.key, "POST", "/items", {
      type: "core.note",
      properties: { body: "first" },
      writer: forged,
    });
    // The witness: the create happened, with the body's own fields.
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
    expect(run.data.outcome, run.data.error ?? "").toBe("ok");
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
    const line = (readTarGzEntry(archive.data, "items.ndjson") ?? "")
      .split("\n")
      .filter((text) => text.trim() !== "")
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find((parsed) => (parsed.item as { id: string }).id === id);
    expect(line, "the archive does not carry the note").toBeDefined();
    expect(writers(line!.versions as Snapshot[])).toEqual([byFirst, bySecond]);
    expect(line!.writer).toEqual(byFirst);

    const owner = new MarfaClient({
      baseUrl: target.apiUrl,
      apiKey: "",
      ownerCookie: target.ownerCookie,
      ownerCredentials: OWNER,
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
      ownerCookie: target.ownerCookie,
      ownerCredentials: OWNER,
    });

    const edits: [string, (line: Record<string, unknown>) => void][] = [
      [
        "versions.0.writer.kind",
        (l) => {
          (l.versions as Record<string, unknown>[])[0]!.writer = {
            kind: "robot",
            id: "x",
            name: "x",
          };
        },
      ],
      [
        "versions.0.writer.name",
        (l) => {
          (l.versions as Record<string, unknown>[])[0]!.writer = {
            kind: "key",
            id: "x",
            name: "a\u0007b",
          };
        },
      ],
      [
        "writer.id",
        (l) => {
          l.writer = { kind: "key", id: "", name: "x" };
        },
      ],
      [
        "writer",
        (l) => {
          l.writer = "a key";
        },
      ],
    ];
    for (const [field, edit] of edits) {
      const edited = tarGz(
        listTarGzEntries(archive.data).map((entry) => ({
          name: entry.name,
          body:
            entry.name === "items.ndjson"
              ? Buffer.from(
                  entry.body
                    .toString("utf8")
                    .split("\n")
                    .filter((text) => text.trim() !== "")
                    .map((text) => {
                      const parsed = JSON.parse(text) as Record<
                        string,
                        unknown
                      >;
                      if ((parsed.item as { id: string }).id === id)
                        edit(parsed);
                      return `${JSON.stringify(parsed)}\n`;
                    })
                    .join(""),
                )
              : entry.body,
        })),
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

  it("bounds a writer's name to 200 characters with no control characters", async () => {
    const label = `long\tlabel\u0007${"k".repeat(300)}`;
    const minted = await mintKey(label);
    const id = await createNote(minted.key);
    await changeNote(minted.key, id, 1, "second");
    const [snapshot] = await versionsOf(minted.key, id);
    expect(snapshot!.writer!.kind).toBe("key");
    expect(Array.from(snapshot!.writer!.name).length).toBe(200);
    expect(snapshot!.writer!.name).not.toMatch(CONTROL);
    expect(snapshot!.writer!.name.startsWith("long label k")).toBe(true);

    const appName = `app\u0001${"a".repeat(400)}`;
    const browser = await signIn();
    const app = await approveApp(browser, appName);
    const note = await createNote(app.accessToken);
    await changeNote(app.accessToken, note, 1, "second");
    const [byApp] = await versionsOf(app.accessToken, note);
    expect(byApp!.writer!.kind).toBe("app");
    expect(Array.from(byApp!.writer!.name).length).toBeLessThanOrEqual(200);
    expect(byApp!.writer!.name).not.toMatch(CONTROL);
  });
});
