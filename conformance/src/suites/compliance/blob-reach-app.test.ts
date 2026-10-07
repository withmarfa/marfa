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
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

let server: FreshServer;
let owner: MarfaClient;
let app: MarfaClient;
let appLabel: string;

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
