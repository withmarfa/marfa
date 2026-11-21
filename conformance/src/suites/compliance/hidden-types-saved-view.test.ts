import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";

/**
 * A view saved before app items were hidden can name an app type, which a view
 * door now refuses. Arranged in the stored file, on a server of its own: the
 * view is saved naming a user type, the server stops, the stored query is
 * rewritten to name the app type as well, and the server boots on that file.
 */

const HIDDEN = "app.acme.setting";
const SHOWN = "user.saved_view_witness";

let server: FreshServer | undefined;
let client: MarfaClient;
let viewId: string;
let hiddenId: string;
let shownId: string;

beforeAll(async () => {
  server = await bootFreshServer("hidden-types-saved-view");
  client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  for (const id of [HIDDEN, SHOWN]) {
    const registered = await client.registerType({
      id,
      fields: { name: { type: "string" } },
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  }
  const made = async (type: string) => {
    const created = await client.createItem({
      type,
      properties: { name: "saved" },
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    return created.data.item.id;
  };
  hiddenId = await made(HIDDEN);
  shownId = await made(SHOWN);
  const view = await client.createView({
    title: "saved",
    query: { types: [SHOWN] },
  });
  expect(view.status, JSON.stringify(view.error)).toBe(201);
  viewId = view.data.item.id;
  await server.restart(() => {
    const changed = withInstanceDatabase(server!.sqlitePath, (db) =>
      db
        .prepare(
          "UPDATE items SET properties = jsonb_set(properties, '$.query.types', jsonb(?)) WHERE id = ?",
        )
        .run(JSON.stringify([HIDDEN, SHOWN]), viewId),
    );
    expect(Number(changed.changes)).toBe(1);
  });
  client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

it("lists no app item in a view saved with a query that names the app type", async () => {
  const listed = await client.listViewItems(viewId, { limit: 200 });
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  const ids = listed.data.data.map((item) => item.id);
  expect(ids, "the witness is in the view").toContain(shownId);
  expect(ids).not.toContain(hiddenId);

  // The witness: a listing that names the app type finds the item.
  const named = await client.rawRequest<{ data: { id: string }[] }>(
    `/items?type=${HIDDEN}`,
  );
  expect(named.data.data.map((item) => item.id)).toContain(hiddenId);
});
