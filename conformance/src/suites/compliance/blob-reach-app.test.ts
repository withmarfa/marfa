/**
 * A signed-in app is a credential no key can stand in for, and an instance
 * has one owner to approve it, which the run's shared server does not have,
 * so this boots a server of its own.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  approvedApp,
  bootFreshServer,
  refreshedAppToken,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

let server: FreshServer;
let owner: MarfaClient;
let app: MarfaClient;
let appLabel: string;

const UNKNOWN = {
  bytes: [404, "blob_not_found"],
  head: [404, undefined],
  link: [404, "blob_not_found"],
  locations: [404, "blob_not_found"],
};

const SERVED = {
  bytes: [200, undefined],
  head: [200, undefined],
  link: [200, undefined],
  locations: [200, undefined],
};

const REFUSED = {
  bytes: [403, "type_not_permitted"],
  head: [403, undefined],
  link: [403, "type_not_permitted"],
  locations: [403, "type_not_permitted"],
};

/** The operator key of a server, which reads every blob it holds, referenced
 *  or not. */
function operatorOf(on: FreshServer): MarfaClient {
  return new MarfaClient({ baseUrl: on.apiUrl, apiKey: on.operatorKey });
}

/** Each reading door's status and error code for one credential. A `HEAD`
 *  answer has no body to carry a code. */
async function readingDoors(
  reader: MarfaClient,
  hash: string,
): Promise<Record<string, [number, string | undefined]>> {
  const bytes = await reader.downloadBlob(hash);
  const head = await reader.headBlob(hash);
  const link = await reader.getBlobUrl(hash);
  const locations = await reader.listBlobLocations(hash);
  return {
    bytes: [bytes.status, bytes.error?.error.code],
    head: [head.status, undefined],
    link: [link.status, link.error?.error.code],
    locations: [locations.status, locations.error?.error.code],
  };
}

/** Bytes unique to this server's story, sent by `as`; the hash they have. */
async function sendBlob(as: MarfaClient, words: string): Promise<string> {
  const res = await as.uploadBlob(
    new TextEncoder().encode(words),
    "text/plain",
  );
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.data.hash;
}

async function noteBy(as: MarfaClient, body: string): Promise<string> {
  const res = await as.createItem({ type: "core.note", properties: { body } });
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  return res.data.item.id;
}

beforeAll(async () => {
  server = await bootFreshServer("blob-reach-app");
  owner = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  const approved = await approvedApp(server, ["core.note:read"]);
  app = new MarfaClient({ baseUrl: server.apiUrl, apiKey: approved.token });
  const person = await new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.operatorKey,
  }).getOwner();
  expect(person.ok, JSON.stringify(person.error)).toBe(true);
  appLabel = `oauth:${approved.clientId}:${person.data.id}`;
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

describe("a signed-in app and an extension namespace", () => {
  it("is not served a blob an extension names under the app's own label", async () => {
    const bytes = new TextEncoder().encode("named under an app's label");
    const sent = await owner.uploadBlob(bytes, "text/plain");
    expect(sent.status).toBe(201);
    const note = await owner.createItem({
      type: "core.note",
      properties: { body: "an item an app may read" },
    });
    expect(note.ok, JSON.stringify(note.error)).toBe(true);
    const written = await owner.setItemExtension(note.data.item.id, appLabel, {
      cover: sent.data.hash,
    });
    expect(written.ok, JSON.stringify(written.error)).toBe(true);

    // The witness: a key of the same label is served the blob, and the app
    // reads the item the extension sits on.
    const keyed = await owner.createKey({
      label: appLabel,
      source: "blob-reach-app-keyed",
      type_permissions: { "core.note": "read" },
    });
    expect(keyed.ok, JSON.stringify(keyed.error)).toBe(true);
    const sameLabel = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: keyed.data.key,
    });
    expect((await sameLabel.downloadBlob(sent.data.hash)).status).toBe(200);
    expect((await app.getItem(note.data.item.id)).status).toBe(200);
    const refused = await app.downloadBlob(sent.data.hash);
    expect(refused.status).toBe(404);
    expect(refused.error?.error.code).toBe("blob_not_found");
  });

  it("does not serve a blob named only in an edge's properties to an app that holds no edge scope", async () => {
    const hash = await sendBlob(owner, "named only by an edge no scope reads");
    const source = await noteBy(owner, "an edge's source");
    const target = await noteBy(owner, "an edge's target");
    const edge = await owner.createEdge({
      source_id: source,
      target_id: target,
      edge_type: "about",
      properties: { cover: hash },
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);

    // The witness: the owner's key reads the edge and is served, and the app
    // reads both notes the edge joins.
    expect(await readingDoors(owner, hash)).toEqual(SERVED);
    expect((await app.getItem(source)).status).toBe(200);
    expect((await app.getItem(target)).status).toBe(200);
    expect(await readingDoors(app, hash)).toEqual(UNKNOWN);
  });

  it("is held to its granted type scopes: it reads a note's blob, not a file's, and uploads nothing", async () => {
    const send = async (words: string) => {
      const res = await owner.uploadBlob(
        new TextEncoder().encode(words),
        "text/plain",
      );
      expect(res.status).toBe(201);
      return res.data.hash;
    };
    const asFile = await send("named by a file an app may not read");
    const asNote = await send("linked from a note an app may read");
    const file = await owner.createItem({
      type: "core.file",
      properties: { blob_ref: asFile, mime_type: "text/plain" },
    });
    expect(file.ok, JSON.stringify(file.error)).toBe(true);
    const note = await owner.createItem({
      type: "core.note",
      properties: { body: `![it](${asNote})` },
    });
    expect(note.ok, JSON.stringify(note.error)).toBe(true);

    expect((await owner.downloadBlob(asFile)).status).toBe(200);
    expect((await app.downloadBlob(asNote)).status).toBe(200);
    const hidden = await app.downloadBlob(asFile);
    expect(hidden.status).toBe(404);
    expect(hidden.error?.error.code).toBe("blob_not_found");

    const refused = await app.uploadBlob(
      new TextEncoder().encode("an upload no scope covers"),
      "text/plain",
    );
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("type_not_permitted");
  });
});

describe("a signed-in app's uploads", () => {
  let writing: FreshServer;

  beforeAll(async () => {
    // An instance approves one owner's apps, and the app above may not
    // write, so the app that uploads gets a server of its own.
    writing = await bootFreshServer("blob-reach-app-refresh");
  }, FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await writing?.stop();
  }, FRESH_SERVER_TIMEOUT_MS);

  it("are credited to its grant, so a digest it names after a refresh lends", async () => {
    const approved = await approvedApp(writing, [
      "core.note:read",
      "core.note:write",
      "offline_access",
    ]);
    expect(approved.refreshToken, "no refresh token was issued").toBeTruthy();
    const before = new MarfaClient({
      baseUrl: writing.apiUrl,
      apiKey: approved.token,
    });
    const owner = new MarfaClient({
      baseUrl: writing.apiUrl,
      apiKey: writing.workingKey,
    });
    const sent = await before.uploadBlob(
      new TextEncoder().encode("uploaded under the token a refresh replaces"),
      "text/plain",
    );
    expect(sent.status, JSON.stringify(sent.error)).toBe(201);
    const notSent = await owner.uploadBlob(
      new TextEncoder().encode("uploaded by the owner, never by the app"),
      "text/plain",
    );
    expect(notSent.status, JSON.stringify(notSent.error)).toBe(201);

    const after = new MarfaClient({
      baseUrl: writing.apiUrl,
      apiKey: await refreshedAppToken(
        writing,
        approved.clientId,
        String(approved.refreshToken),
      ),
    });
    const sentNote = await after.createItem({
      type: "core.note",
      properties: { body: `![sent](${sent.data.hash})` },
    });
    expect(sentNote.ok, JSON.stringify(sentNote.error)).toBe(true);
    const notSentNote = await after.createItem({
      type: "core.note",
      properties: { body: `![not sent](${notSent.data.hash})` },
    });
    expect(notSentNote.ok, JSON.stringify(notSentNote.error)).toBe(true);

    expect((await owner.downloadBlob(sent.data.hash)).status).toBe(200);
    expect((await after.downloadBlob(sent.data.hash)).status).toBe(200);
    // The witness: a digest the app never sent does not lend from its note.
    expect((await owner.downloadBlob(notSent.data.hash)).status).toBe(404);
  });
});

describe("a signed-in app's scopes and a blob it reads", () => {
  let reaching: FreshServer;
  let owner: MarfaClient;
  let app: MarfaClient;

  beforeAll(async () => {
    // An instance approves one owner's apps, so the app that reads and writes
    // notes and the `about` edge gets a server of its own.
    reaching = await bootFreshServer("blob-reach-app-edges");
    owner = new MarfaClient({
      baseUrl: reaching.apiUrl,
      apiKey: reaching.workingKey,
    });
    const approved = await approvedApp(reaching, [
      "core.note:read",
      "core.note:write",
      "edge.about:read",
      "edge.about:write",
    ]);
    app = new MarfaClient({ baseUrl: reaching.apiUrl, apiKey: approved.token });
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await reaching?.stop();
  }, FRESH_SERVER_TIMEOUT_MS);

  it("answers a blob nothing references as an unknown one to the app that uploaded it", async () => {
    const hash = await sendBlob(app, "an app's bytes nothing names yet");

    // The witness: the instance holds the bytes.
    expect((await operatorOf(reaching).downloadBlob(hash)).status).toBe(200);
    expect(await readingDoors(app, hash)).toEqual(UNKNOWN);

    const note = await app.createItem({
      type: "core.note",
      properties: { body: `![it](${hash})` },
    });
    expect(note.ok, JSON.stringify(note.error)).toBe(true);
    expect(await readingDoors(app, hash)).toEqual(SERVED);
  });

  it("serves a blob named only in an edge's properties to an app that reads the edge, and to no other", async () => {
    const viaAbout = await sendBlob(owner, "named only by an about edge");
    const viaReferences = await sendBlob(
      owner,
      "named only by a references edge",
    );
    const viaFileSource = await sendBlob(
      owner,
      "named only by an about edge from a file",
    );
    const fileContent = await sendBlob(owner, "the file the edge starts from");
    const source = await noteBy(owner, "an edge's source");
    const target = await noteBy(owner, "an edge's target");
    const file = await owner.createItem({
      type: "core.file",
      properties: {
        blob_ref: fileContent,
        mime_type: "text/plain",
        title: "an edge's source file",
      },
    });
    expect(file.ok, JSON.stringify(file.error)).toBe(true);

    // The witnesses: the instance holds every blob, and the app is served
    // none while nothing names them.
    for (const hash of [viaAbout, viaReferences, viaFileSource]) {
      expect((await operatorOf(reaching).downloadBlob(hash)).status).toBe(200);
      expect(await readingDoors(app, hash)).toEqual(UNKNOWN);
    }

    const edges = [
      await owner.createEdge({
        source_id: source,
        target_id: target,
        edge_type: "about",
        properties: { cover: viaAbout },
      }),
      await owner.createEdge({
        source_id: source,
        target_id: target,
        edge_type: "references",
        properties: { cover: viaReferences },
      }),
      await owner.createEdge({
        source_id: file.data.item.id,
        target_id: target,
        edge_type: "about",
        properties: { cover: viaFileSource },
      }),
    ];
    for (const edge of edges) {
      expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
    }

    // The app reads the `about` edge between notes, and no edge of another
    // type and none from a type it may not read.
    expect(await readingDoors(app, viaAbout)).toEqual(SERVED);
    expect(await readingDoors(app, viaReferences)).toEqual(UNKNOWN);
    expect(await readingDoors(app, viaFileSource)).toEqual(UNKNOWN);

    const about = edges[0];
    expect((await owner.deleteEdge(about.data.edge.id)).ok).toBe(true);
    expect(await readingDoors(app, viaAbout)).toEqual(UNKNOWN);
    expect((await operatorOf(reaching).downloadBlob(viaAbout)).status).toBe(
      200,
    );
  });

  it("lends through an edge only a digest the app proved", async () => {
    const sent = await sendBlob(app, "an app sent these bytes, an edge names");
    const notSent = await sendBlob(owner, "the app never sent these bytes");
    const source = await noteBy(owner, "a planted edge's source");
    const target = await noteBy(owner, "a planted edge's target");

    const edge = await app.createEdge({
      source_id: source,
      target_id: target,
      edge_type: "about",
      properties: { cover: sent, alt: notSent },
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);

    // The app reads the edge, and is served what it sent and nothing else it
    // named. The owner's key reads every edge and is served the same, so the
    // dead reference is the digest's and not the reader's.
    expect(await readingDoors(app, sent)).toEqual(SERVED);
    expect(await readingDoors(owner, sent)).toEqual(SERVED);
    expect(await readingDoors(app, notSent)).toEqual(UNKNOWN);
    expect(await readingDoors(owner, notSent)).toEqual(UNKNOWN);
    expect((await operatorOf(reaching).downloadBlob(notSent)).status).toBe(200);
  });
});

describe("a signed-in app whose scopes reach no registered type", () => {
  let bare: FreshServer;
  let owner: MarfaClient;

  beforeAll(async () => {
    bare = await bootFreshServer("blob-reach-app-no-type");
    owner = new MarfaClient({
      baseUrl: bare.apiUrl,
      apiKey: bare.workingKey,
    });
  }, FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await bare?.stop();
  }, FRESH_SERVER_TIMEOUT_MS);

  it("answers a blob as unknown to an app whose scopes reach no registered type", async () => {
    const approved = await approvedApp(bare, ["user.*:read"]);
    const app = new MarfaClient({
      baseUrl: bare.apiUrl,
      apiKey: approved.token,
    });
    const hash = await sendBlob(
      owner,
      "bytes an unregistered scope cannot reach",
    );
    const note = await owner.createItem({
      type: "core.note",
      properties: { body: `![it](${hash})` },
    });
    expect(note.ok, JSON.stringify(note.error)).toBe(true);

    // The witness: the owner is served the blob, and the app's scope is a
    // pattern, so it reaches a type and is told what any credential that may
    // not read the blob is.
    expect(await readingDoors(owner, hash)).toEqual(SERVED);
    expect(await readingDoors(app, hash)).toEqual(UNKNOWN);
  });
});

describe("a signed-in app whose scopes name no type at all", () => {
  let bare: FreshServer;
  let owner: MarfaClient;

  beforeAll(async () => {
    bare = await bootFreshServer("blob-reach-app-no-scope");
    owner = new MarfaClient({
      baseUrl: bare.apiUrl,
      apiKey: bare.workingKey,
    });
  }, FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await bare?.stop();
  }, FRESH_SERVER_TIMEOUT_MS);

  it("is refused every blob door as a key reaching no type is", async () => {
    const approved = await approvedApp(bare, ["edge.about:read"]);
    const app = new MarfaClient({
      baseUrl: bare.apiUrl,
      apiKey: approved.token,
    });
    const hash = await sendBlob(owner, "bytes an edge scope cannot reach");
    const note = await owner.createItem({
      type: "core.note",
      properties: { body: `![it](${hash})` },
    });
    expect(note.ok, JSON.stringify(note.error)).toBe(true);

    expect(await readingDoors(owner, hash)).toEqual(SERVED);
    expect(await readingDoors(app, hash)).toEqual(REFUSED);
    const unknown = `sha256:${"f".repeat(64)}`;
    expect(await readingDoors(app, unknown)).toEqual(REFUSED);
    const upload = await app.uploadBlob(
      new TextEncoder().encode("an upload no scope covers"),
      "text/plain",
    );
    expect(upload.status).toBe(403);
    expect(upload.error?.error.code).toBe("type_not_permitted");
  });
});
