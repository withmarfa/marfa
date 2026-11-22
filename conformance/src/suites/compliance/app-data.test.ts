import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { controlRequest } from "../../utils/control-request.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  connect,
  issuerOrigin,
  registerApp,
  signIn,
  type App,
} from "../../utils/signed-in.js";
import {
  callTool,
  connectMcp,
  toolError,
  toolNames,
  toolResult,
} from "../../utils/mcp.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

/**
 * What an app keeps under its `app.<vendor>` namespaces: the owner lists it,
 * removes it, and can remove it when the app is disconnected. Apps are signed
 * in by a person, and the owner's view is the whole instance, so this file
 * boots a server of its own.
 */
let server: FreshServer;
let origin: string;
let cookie: string;
/** An owner's key holding grants.manage and items.purge, and no content. */
let owner: string;

const REGISTERS = "content:write metadata.types:write";
const BIG = 1_050;

beforeAll(async () => {
  server = await bootFreshServer("app-data");
  origin = await issuerOrigin(server);
  cookie = await signIn(server, origin);
  owner = await mint(["grants.manage", "items.purge", "sign_ins.manage"]);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

interface Signed {
  app: App;
  token: string;
}

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

interface Listed {
  vendor: string;
  client_id: string | null;
  types: Array<{
    type: string;
    active: number;
    archived: number;
    trashed: number;
  }>;
  data: Array<{ id: string; type: string; state: string }>;
  next_cursor: string | null;
}

interface Removed {
  vendor: string;
  removed_items: number;
  removed_types: number;
  remaining_items: number;
}

async function mint(
  permissions: string[],
  types: Record<string, string> = {},
): Promise<string> {
  const minted = await controlRequest(server.controlSocket, "/keys", {
    method: "POST",
    body: {
      label: "app-data",
      source: `app-data-${randomUUID().slice(0, 8)}`,
      type_permissions: types,
      permissions,
    },
  });
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  return minted.body.key as string;
}

async function signedIn(scope: string): Promise<Signed> {
  const app = await registerApp(server, scope);
  const answer = await connect(server, origin, cookie, app, scope);
  return { app, token: answer.access_token! };
}

async function answer(
  credential: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Answer> {
  const response = await fetch(`${server.apiUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${credential}`,
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

function ok(got: Answer, status = 200): Record<string, unknown> {
  expect(got.status, JSON.stringify(got.body)).toBe(status);
  return got.body;
}

function refused(got: Answer, status: number) {
  expect(got.status, JSON.stringify(got.body)).toBe(status);
  return got.body.error as { code: string; details?: Record<string, unknown> };
}

/** A vendor no earlier attempt of a test used, so a retry starts from no holder. */
function freshVendor(): string {
  const tag = Array.from({ length: 8 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join("");
  return `app.data${tag}`;
}

async function registerType(
  credential: string,
  id: string,
  parent?: string,
): Promise<void> {
  ok(
    await answer(credential, "/types", {
      method: "POST",
      body: {
        id,
        version: 1,
        ...(parent === undefined ? {} : { parent }),
        fields: { title: { type: "string" } },
      },
    }),
    201,
  );
}

async function createItem(
  credential: string,
  type: string,
  title: string,
): Promise<string> {
  const made = ok(
    await answer(credential, "/items", {
      method: "POST",
      body: { type, properties: { title } },
    }),
    201,
  );
  return (made.item as { id: string }).id;
}

async function manyItems(
  credential: string,
  type: string,
  count: number,
): Promise<void> {
  const run = randomUUID().slice(0, 8);
  const made = ok(
    await answer(credential, "/items/bulk", {
      method: "POST",
      body: {
        mode: "create_only",
        items: Array.from({ length: count }, (_, i) => ({
          type,
          source_id: `${run}-${i}`,
          properties: { title: `setting ${i}` },
        })),
      },
    }),
  );
  expect((made.counts as { created: number }).created).toBe(count);
}

async function dataOf(credential: string, vendor: string): Promise<Listed> {
  const got = await answer(credential, `/app-vendors/${vendor}/data?limit=200`);
  const body = ok(got);
  await expectMatchesSchema("GET", "/app-vendors/{vendor}/data", 200, body);
  return body as unknown as Listed;
}

async function removeData(credential: string, vendor: string): Promise<Answer> {
  return answer(credential, `/app-vendors/${vendor}/data`, {
    method: "DELETE",
  });
}

async function removed(credential: string, vendor: string): Promise<Removed> {
  const body = ok(await removeData(credential, vendor));
  await expectMatchesSchema("DELETE", "/app-vendors/{vendor}/data", 200, body);
  return body as unknown as Removed;
}

async function typeExists(id: string): Promise<boolean> {
  const got = await answer(server.managementKey, `/types/${id}`);
  if (got.status === 404) return false;
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  return true;
}

async function typeListed(id: string): Promise<boolean> {
  const got = ok(await answer(server.managementKey, "/types"));
  return (got.data as Array<{ id: string }>).some((type) => type.id === id);
}

async function grantOf(app: App): Promise<{ id: string; vendors: string[] }> {
  const grants = ok(await answer(server.managementKey, "/grants"));
  const grant = (
    grants.data as Array<{ id: string; client_id: string; vendors: string[] }>
  ).find((one) => one.client_id === app.clientId);
  expect(grant, app.clientId).toBeDefined();
  return grant!;
}

async function grantListed(app: App): Promise<boolean> {
  const grants = ok(await answer(server.managementKey, "/grants"));
  return (grants.data as Array<{ client_id: string }>).some(
    (one) => one.client_id === app.clientId,
  );
}

async function holder(vendor: string): Promise<string | null | undefined> {
  const page = ok(await answer(server.managementKey, "/app-vendors"));
  await expectMatchesSchema("GET", "/app-vendors", 200, page);
  return (
    page.data as Array<{ vendor: string; client_id: string | null }>
  ).find((one) => one.vendor === vendor)?.client_id;
}

function ids(listed: Listed): string[] {
  return listed.data.map((item) => item.id).sort();
}

/** An app holding a vendor with an item in each state, a subtype and its item. */
async function appWithData(scope = REGISTERS): Promise<{
  vendor: string;
  signed: Signed;
  items: string[];
  types: string[];
}> {
  const vendor = freshVendor();
  const signed = await signedIn(scope);
  const setting = `${vendor}.setting`;
  const child = `${vendor}.child`;
  const cache = `${vendor}.cache`;
  await registerType(signed.token, setting);
  await registerType(signed.token, child, setting);
  await registerType(signed.token, cache);
  const active = await createItem(signed.token, setting, "active");
  const archived = await createItem(signed.token, cache, "archived");
  ok(
    await answer(signed.token, `/items/${archived}/transition`, {
      method: "POST",
      body: { state: "archived" },
    }),
  );
  const trashed = await createItem(signed.token, setting, "trashed copy");
  ok(await answer(signed.token, `/items/${trashed}`, { method: "DELETE" }));
  const inherited = await createItem(signed.token, child, "child");
  return {
    vendor,
    signed,
    items: [active, archived, trashed, inherited].sort(),
    types: [cache, child, setting],
  };
}

describe("listing an app's hidden data", () => {
  it("lists the named vendor's types with counts by state and its items in every state, and nothing of another vendor", async () => {
    const first = await appWithData();
    const second = await appWithData();

    const listed = await dataOf(owner, first.vendor);
    expect(listed.vendor).toBe(first.vendor);
    expect(listed.client_id).toBe(first.signed.app.clientId);
    expect(listed.next_cursor).toBeNull();
    expect(listed.types.map((entry) => entry.type)).toEqual(first.types);
    const counted = Object.fromEntries(
      listed.types.map((entry) => [
        entry.type,
        [entry.active, entry.archived, entry.trashed],
      ]),
    );
    expect(counted[`${first.vendor}.setting`]).toEqual([1, 0, 1]);
    expect(counted[`${first.vendor}.cache`]).toEqual([0, 1, 0]);
    expect(counted[`${first.vendor}.child`]).toEqual([1, 0, 0]);
    expect(ids(listed)).toEqual(first.items);
    expect(new Set(listed.data.map((item) => item.state))).toEqual(
      new Set(["active", "archived", "trashed"]),
    );
    for (const item of second.items) expect(ids(listed)).not.toContain(item);
    // The witness: the other vendor's own listing holds its items.
    expect(ids(await dataOf(owner, second.vendor))).toEqual(second.items);
  });

  it("pages a vendor's items with next_cursor", async () => {
    const { vendor, items } = await appWithData();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? "" : `&cursor=${cursor}`;
      const page = ok(
        await answer(owner, `/app-vendors/${vendor}/data?limit=1${query}`),
      ) as unknown as Listed;
      expect(page.data.length).toBeLessThanOrEqual(1);
      seen.push(...page.data.map((item) => item.id));
      cursor = page.next_cursor;
    } while (cursor !== null);
    expect(seen.sort()).toEqual(items);
  });

  it("names each app's vendors in GET /grants and each holder's name in GET /app-vendors", async () => {
    const { vendor, signed } = await appWithData();
    expect((await grantOf(signed.app)).vendors).toEqual([vendor]);
    const page = ok(await answer(server.managementKey, "/app-vendors"));
    const binding = (
      page.data as Array<{ vendor: string; client_name: string | null }>
    ).find((one) => one.vendor === vendor);
    expect(binding).toBeDefined();
    expect(binding!.client_name).not.toBeUndefined();
  });

  it("answers 404 not_found for a vendor nobody holds and 400 for a name that is no vendor", async () => {
    const error = refused(
      await answer(owner, `/app-vendors/${freshVendor()}/data`),
      404,
    );
    expect(error.code).toBe("not_found");
    expect(refused(await removeData(owner, freshVendor()), 404).code).toBe(
      "not_found",
    );
    expect(
      refused(await answer(owner, "/app-vendors/core.note/data"), 400).code,
    ).toBe("validation_error");
  });

  it("refuses a credential without grants.manage with 403 naming it, and a removal without items.purge with 403 naming that", async () => {
    const { vendor, items } = await appWithData();
    const noGrants = await mint(["items.purge"]);
    const listing = refused(
      await answer(noGrants, `/app-vendors/${vendor}/data`),
      403,
    );
    expect(listing.details?.required_scope).toBe("grants.manage");
    expect(
      refused(await removeData(noGrants, vendor), 403).details?.required_scope,
    ).toBe("grants.manage");

    const noPurge = await mint(["grants.manage"]);
    // The witness: grants.manage alone lists the data.
    expect(ids(await dataOf(noPurge, vendor))).toEqual(items);
    const removal = refused(await removeData(noPurge, vendor), 403);
    expect(removal.details?.required_scope).toBe("items.purge");
    expect(ids(await dataOf(owner, vendor))).toEqual(items);
  });

  it("lets an app's sign-in list and remove only the data of its own vendors", async () => {
    const own = await appWithData(`${REGISTERS} grants.manage items.purge`);
    const other = await appWithData();
    expect(ids(await dataOf(own.signed.token, own.vendor))).toEqual(own.items);
    const listing = refused(
      await answer(own.signed.token, `/app-vendors/${other.vendor}/data`),
      403,
    );
    expect(listing.code).toBe("forbidden");
    expect(
      refused(await removeData(own.signed.token, other.vendor), 403).code,
    ).toBe("forbidden");
    expect(ids(await dataOf(owner, other.vendor))).toEqual(other.items);

    const taken = await removed(own.signed.token, own.vendor);
    expect(taken.removed_items).toBe(own.items.length);
  });
});

describe("removing an app's hidden data", () => {
  it("removes every item of the vendor in every state, then its types children first, and leaves the vendor with its app", async () => {
    const first = await appWithData();
    const second = await appWithData();
    for (const type of first.types) expect(await typeListed(type)).toBe(true);

    const taken = await removed(owner, first.vendor);
    expect(taken).toEqual({
      vendor: first.vendor,
      removed_items: first.items.length,
      removed_types: first.types.length,
      remaining_items: 0,
    });
    const after = await dataOf(owner, first.vendor);
    expect(after.data).toEqual([]);
    expect(after.types).toEqual([]);
    for (const type of first.types) {
      expect(await typeExists(type)).toBe(false);
      expect(await typeListed(type)).toBe(false);
    }
    expect(await holder(first.vendor)).toBe(first.signed.app.clientId);
    // The app keeps its access and registers under its vendor again.
    await registerType(first.signed.token, `${first.vendor}.setting`);

    expect(ids(await dataOf(owner, second.vendor))).toEqual(second.items);
    for (const type of second.types) expect(await typeExists(type)).toBe(true);
  });

  it("answers zero counts for a second removal", async () => {
    const { vendor } = await appWithData();
    await removed(owner, vendor);
    expect(await removed(owner, vendor)).toEqual({
      vendor,
      removed_items: 0,
      removed_types: 0,
      remaining_items: 0,
    });
  });

  it("removes what another app wrote under the vendor through a grant that names it, and leaves that app's own vendor", async () => {
    const holderApp = await appWithData();
    const third = await appWithData(`${REGISTERS} ${holderApp.vendor}.*:write`);
    const written = await createItem(
      third.signed.token,
      `${holderApp.vendor}.setting`,
      "written by another app",
    );
    expect(ids(await dataOf(owner, holderApp.vendor))).toContain(written);

    const taken = await removed(owner, holderApp.vendor);
    expect(taken.removed_items).toBe(holderApp.items.length + 1);
    expect(ids(await dataOf(owner, third.vendor))).toEqual(third.items);

    // Removing the third app's own vendor leaves what the holder writes anew.
    await registerType(holderApp.signed.token, `${holderApp.vendor}.again`);
    const kept = await createItem(
      holderApp.signed.token,
      `${holderApp.vendor}.again`,
      "kept",
    );
    await removed(owner, third.vendor);
    expect(ids(await dataOf(owner, holderApp.vendor))).toEqual([kept]);
  });

  it("keeps a person's item that links to an app item, and drops only the edge", async () => {
    const { vendor, items } = await appWithData();
    const person = await mint([], { "core.note": "write", "app.*": "write" });
    const note = await createItem(person, "core.note", "about a setting");
    const toApp = ok(
      await answer(person, "/edges", {
        method: "POST",
        body: { from_id: note, to_id: items[0], edge_type: "about" },
      }),
      201,
    );
    const fromApp = ok(
      await answer(person, "/edges", {
        method: "POST",
        body: { from_id: items[0], to_id: note, edge_type: "about" },
      }),
      201,
    );
    const edgeIds = [toApp, fromApp].map(
      (made) => (made.edge as { id: string }).id,
    );
    for (const edge of edgeIds) {
      expect((await answer(person, `/edges/${edge}`)).status).toBe(200);
    }

    await removed(owner, vendor);
    expect((await answer(person, `/items/${note}`)).status).toBe(200);
    for (const edge of edgeIds) {
      expect((await answer(person, `/edges/${edge}`)).status).toBe(404);
    }
  });

  it("refuses with 409 type_in_use and removes nothing while a view or another credential's webhook names one of its types", async () => {
    const { vendor, items, types } = await appWithData();
    const person = await mint(["webhooks.manage"], {
      "system.view": "write",
      "app.*": "read",
    });
    const view = ok(
      await answer(person, "/views", {
        method: "POST",
        body: {
          title: "app settings",
          query: { types: [`${vendor}.setting`] },
        },
      }),
      201,
    );
    const byView = refused(await removeData(owner, vendor), 409);
    expect(byView.code).toBe("type_in_use");
    expect(JSON.stringify(byView.details?.settings)).toContain(
      view.id as string,
    );
    expect(ids(await dataOf(owner, vendor))).toEqual(items);
    for (const type of types) expect(await typeExists(type)).toBe(true);

    ok(
      await answer(person, `/views/${view.id as string}`, { method: "DELETE" }),
    );
    const hook = ok(
      await answer(person, "/webhooks", {
        method: "POST",
        body: {
          url: "http://receiver.invalid/app-data",
          events: ["item.created"],
          type_filter: `${vendor}.cache`,
        },
      }),
      201,
    );
    const byHook = refused(await removeData(owner, vendor), 409);
    expect(byHook.code).toBe("type_in_use");
    expect(JSON.stringify(byHook.details?.settings)).toContain(
      hook.id as string,
    );
    expect(ids(await dataOf(owner, vendor))).toEqual(items);

    ok(
      await answer(person, `/webhooks/${hook.id as string}`, {
        method: "DELETE",
      }),
    );
    await removed(owner, vendor);
  });

  it("drops a webhook the app made naming one of its types with its data", async () => {
    const { vendor, signed } = await appWithData(
      `${REGISTERS} webhooks.manage`,
    );
    const hook = ok(
      await answer(signed.token, "/webhooks", {
        method: "POST",
        body: {
          url: "http://receiver.invalid/app-own",
          events: ["item.created"],
          type_filter: `${vendor}.setting`,
        },
      }),
      201,
    );
    const listedHooks = async () =>
      (
        ok(await answer(signed.token, "/webhooks")).data as Array<{
          id: string;
        }>
      ).map((one) => one.id);
    expect(await listedHooks()).toContain(hook.id);

    await removed(owner, vendor);
    expect(await listedHooks()).not.toContain(hook.id);
  });

  it("removes more than 1,000 items over several calls, its types going in the call that empties it", async () => {
    const vendor = freshVendor();
    const signed = await signedIn(REGISTERS);
    const type = `${vendor}.setting`;
    await registerType(signed.token, type);
    await manyItems(signed.token, type, BIG);

    const first = await removed(owner, vendor);
    expect(first).toEqual({
      vendor,
      removed_items: 1_000,
      removed_types: 0,
      remaining_items: BIG - 1_000,
    });
    expect(await typeExists(type)).toBe(true);

    const last = await removed(owner, vendor);
    expect(last).toEqual({
      vendor,
      removed_items: BIG - 1_000,
      removed_types: 1,
      remaining_items: 0,
    });
    expect(await typeExists(type)).toBe(false);
  });
});

describe("removing an app's data when it is disconnected", () => {
  it("keeps the app's data and types when its grant is revoked without remove_data", async () => {
    const { vendor, signed, items, types } = await appWithData();
    const grant = await grantOf(signed.app);
    ok(await answer(owner, `/grants/${grant.id}`, { method: "DELETE" }));
    expect(await grantListed(signed.app)).toBe(false);
    expect(ids(await dataOf(owner, vendor))).toEqual(items);
    for (const type of types) expect(await typeExists(type)).toBe(true);
    expect(await holder(vendor)).toBe(signed.app.clientId);
  });

  it("removes the app's data in the write that ends its grant with remove_data, and leaves another app's and the owner's vendors", async () => {
    const leaving = await appWithData(`${REGISTERS} keys.mint`);
    const staying = await appWithData();
    const ownerVendor = freshVendor();
    const ownerKey = await mint([], { "app.*": "write" });
    ok(
      await answer(ownerKey, "/types", {
        method: "POST",
        body: {
          id: `${ownerVendor}.setting`,
          version: 1,
          fields: { title: { type: "string" } },
        },
      }),
      201,
    );
    const ownerItem = await createItem(
      ownerKey,
      `${ownerVendor}.setting`,
      "the owner's",
    );
    expect(await holder(ownerVendor)).toBeNull();
    const appMade = ok(
      await answer(leaving.signed.token, "/keys", {
        method: "POST",
        body: {
          label: "app-made",
          source: `app-made-${randomUUID().slice(0, 8)}`,
          type_permissions: {},
          permissions: [],
        },
      }),
      201,
    ).key as string;

    const grant = await grantOf(leaving.signed.app);
    ok(
      await answer(owner, `/grants/${grant.id}?remove_data=true`, {
        method: "DELETE",
      }),
    );
    expect(await grantListed(leaving.signed.app)).toBe(false);
    expect((await answer(leaving.signed.token, "/keys/current")).status).toBe(
      401,
    );
    expect((await answer(appMade, "/keys/current")).status).toBe(200);
    const after = await dataOf(owner, leaving.vendor);
    expect(after.data).toEqual([]);
    for (const type of leaving.types) {
      expect(await typeExists(type)).toBe(false);
      expect(await typeListed(type)).toBe(false);
    }
    expect(ids(await dataOf(owner, staying.vendor))).toEqual(staying.items);
    expect(ids(await dataOf(owner, ownerVendor))).toEqual([ownerItem]);
  });

  it("ends the app's keys and removes its data with remove_data and revoke_keys together", async () => {
    const { vendor, signed } = await appWithData(`${REGISTERS} keys.mint`);
    const appMade = ok(
      await answer(signed.token, "/keys", {
        method: "POST",
        body: {
          label: "app-made",
          source: `app-made-${randomUUID().slice(0, 8)}`,
          type_permissions: {},
          permissions: [],
        },
      }),
      201,
    ).key as string;
    const grant = await grantOf(signed.app);
    ok(
      await answer(
        owner,
        `/grants/${grant.id}?revoke_keys=true&remove_data=true`,
        { method: "DELETE" },
      ),
    );
    expect((await answer(appMade, "/keys/current")).status).toBe(401);
    expect((await dataOf(owner, vendor)).data).toEqual([]);
  });

  it("refuses a remove_data that is neither true nor false, or is named twice, 400, and ends nothing", async () => {
    const { vendor, signed, items } = await appWithData();
    const grant = await grantOf(signed.app);
    for (const query of [
      "remove_data=yes",
      "remove_data=1",
      "remove_data=true&remove_data=true",
    ]) {
      const error = refused(
        await answer(owner, `/grants/${grant.id}?${query}`, {
          method: "DELETE",
        }),
        400,
      );
      expect(error.code).toBe("validation_error");
      const signIns = refused(
        await answer(owner, `/owner/sign-ins/${grant.id}?${query}`, {
          method: "DELETE",
        }),
        400,
      );
      expect(signIns.code).toBe("validation_error");
    }
    expect(await grantListed(signed.app)).toBe(true);
    expect(ids(await dataOf(owner, vendor))).toEqual(items);
  });

  it("refuses remove_data to a credential without items.purge with 403 naming it, and ends nothing", async () => {
    const { vendor, signed, items } = await appWithData();
    const grant = await grantOf(signed.app);
    const noPurge = await mint(["grants.manage", "sign_ins.manage"]);
    const error = refused(
      await answer(noPurge, `/grants/${grant.id}?remove_data=true`, {
        method: "DELETE",
      }),
      403,
    );
    expect(error.details?.required_scope).toBe("items.purge");
    const signIns = refused(
      await answer(noPurge, `/owner/sign-ins/${grant.id}?remove_data=true`, {
        method: "DELETE",
      }),
      403,
    );
    expect(signIns.details?.required_scope).toBe("items.purge");
    expect(await grantListed(signed.app)).toBe(true);
    expect(ids(await dataOf(owner, vendor))).toEqual(items);
  });

  it("refuses an app's sign-in removing another app's data as it ends that app, and ends nothing", async () => {
    const other = await appWithData();
    const manager = await signedIn("grants.manage items.purge");
    const grant = await grantOf(other.signed.app);
    const error = refused(
      await answer(manager.token, `/grants/${grant.id}?remove_data=true`, {
        method: "DELETE",
      }),
      403,
    );
    expect(error.code).toBe("forbidden");
    expect(await grantListed(other.signed.app)).toBe(true);
    expect(ids(await dataOf(owner, other.vendor))).toEqual(other.items);
  });

  it("refuses a disconnect with remove_data while the app holds more than 1,000 items, and leaves the grant standing", async () => {
    const vendor = freshVendor();
    const signed = await signedIn(REGISTERS);
    await registerType(signed.token, `${vendor}.setting`);
    await manyItems(signed.token, `${vendor}.setting`, BIG);
    const grant = await grantOf(signed.app);
    const error = refused(
      await answer(owner, `/grants/${grant.id}?remove_data=true`, {
        method: "DELETE",
      }),
      400,
    );
    expect(error.code).toBe("bulk_cap_exceeded");
    expect(error.details?.cap).toBe(1_000);
    expect(await grantListed(signed.app)).toBe(true);
    expect((await answer(signed.token, "/keys/current")).status).toBe(200);
    const listed = ok(
      await answer(owner, `/app-vendors/${vendor}/data?limit=1`),
    ) as unknown as Listed;
    expect(listed.types[0]!.active).toBe(BIG);
  });

  it("ends an app with its data at DELETE /owner/sign-ins/{id} with remove_data, and refuses remove_data for a sign-in that is no app", async () => {
    const { vendor, signed, items } = await appWithData();
    const grant = await grantOf(signed.app);
    const keyId = (ok(await answer(owner, "/keys/current")) as { id: string })
      .id;
    const notApp = refused(
      await answer(owner, `/owner/sign-ins/${keyId}?remove_data=true`, {
        method: "DELETE",
      }),
      400,
    );
    expect(notApp.code).toBe("validation_error");
    expect((await answer(owner, "/keys/current")).status).toBe(200);
    expect(ids(await dataOf(owner, vendor))).toEqual(items);

    ok(
      await answer(owner, `/owner/sign-ins/${grant.id}?remove_data=true`, {
        method: "DELETE",
      }),
    );
    expect(await grantListed(signed.app)).toBe(false);
    expect((await dataOf(owner, vendor)).data).toEqual([]);
  });
});

describe("an app's hidden data over MCP", () => {
  it("lists marfa_app_data to a credential holding grants.manage", async () => {
    const mcp = await connectMcp(
      server.apiUrl,
      owner,
      "2026-07-28",
      "/mcp/admin",
    );
    try {
      expect(await toolNames(mcp)).toContain("marfa_app_data");
    } finally {
      await mcp.close();
    }
  });

  it("previews a vendor's data with marfa_app_data, deletes nothing on a stale confirmation, and deletes it on a fresh one", async () => {
    const { vendor, signed, items } = await appWithData();
    const mcp = await connectMcp(
      server.apiUrl,
      owner,
      "2026-07-28",
      "/mcp/admin",
    );
    try {
      const preview = toolResult(
        await callTool(mcp, "marfa_app_data", { vendor }),
      );
      expect(preview.items).toBe(items.length);
      expect(preview.client_id).toBe(signed.app.clientId);
      const confirm = preview.confirm as string;
      expect(typeof confirm).toBe("string");

      await createItem(signed.token, `${vendor}.setting`, "written since");
      const stale = toolError(
        await callTool(mcp, "marfa_app_data", { vendor, confirm }),
      );
      expect(stale.code).toBe("confirmation_stale");
      expect((await dataOf(owner, vendor)).data.length).toBe(items.length + 1);

      const again = toolResult(
        await callTool(mcp, "marfa_app_data", { vendor }),
      );
      const done = toolResult(
        await callTool(mcp, "marfa_app_data", {
          vendor,
          confirm: again.confirm as string,
        }),
      );
      expect(done.removed_items).toBe(items.length + 1);
      expect(done.remaining_items).toBe(0);
      expect((await dataOf(owner, vendor)).data).toEqual([]);
      expect(await typeExists(`${vendor}.setting`)).toBe(false);
    } finally {
      await mcp.close();
    }
  });

  it("previews ending an app with remove_data naming its data, ends nothing on a stale confirmation, and ends it with its data on a fresh one", async () => {
    const { vendor, signed, items } = await appWithData();
    const grant = await grantOf(signed.app);
    const mcp = await connectMcp(
      server.apiUrl,
      owner,
      "2026-07-28",
      "/mcp/admin",
    );
    try {
      const kept = toolResult(
        await callTool(mcp, "marfa_end_sign_in", { id: grant.id }),
      );
      expect(kept.data).toBeUndefined();
      const preview = toolResult(
        await callTool(mcp, "marfa_end_sign_in", {
          id: grant.id,
          remove_data: true,
        }),
      );
      const data = preview.data as Array<{ vendor: string; items: number }>;
      expect(data).toEqual([
        expect.objectContaining({ vendor, items: items.length }),
      ]);

      // A confirmation for ending the app without its data does not end it with it.
      const without = toolError(
        await callTool(mcp, "marfa_end_sign_in", {
          id: grant.id,
          remove_data: true,
          confirm: kept.confirm as string,
        }),
      );
      expect(without.code).toBe("confirmation_stale");

      await createItem(signed.token, `${vendor}.setting`, "written since");
      const stale = toolError(
        await callTool(mcp, "marfa_end_sign_in", {
          id: grant.id,
          remove_data: true,
          confirm: preview.confirm as string,
        }),
      );
      expect(stale.code).toBe("confirmation_stale");
      expect(await grantListed(signed.app)).toBe(true);
      expect((await dataOf(owner, vendor)).data.length).toBe(items.length + 1);

      // The stale answer carries a new preview with its own confirmation.
      const confirm = stale.confirm as string;
      expect(typeof confirm).toBe("string");
      const ended = toolResult(
        await callTool(mcp, "marfa_end_sign_in", {
          id: grant.id,
          remove_data: true,
          confirm,
        }),
      );
      expect(ended.ended).toBe(true);
      expect(await grantListed(signed.app)).toBe(false);
      expect((await dataOf(owner, vendor)).data).toEqual([]);
    } finally {
      await mcp.close();
    }
  });

  it("refuses remove_data in marfa_end_sign_in to a credential without items.purge", async () => {
    const { vendor, signed, items } = await appWithData();
    const grant = await grantOf(signed.app);
    const noPurge = await mint(["grants.manage"]);
    const mcp = await connectMcp(
      server.apiUrl,
      noPurge,
      "2026-07-28",
      "/mcp/admin",
    );
    try {
      const error = toolError(
        await callTool(mcp, "marfa_end_sign_in", {
          id: grant.id,
          remove_data: true,
        }),
      );
      expect(error.code).toBe("forbidden");
    } finally {
      await mcp.close();
    }
    expect(await grantListed(signed.app)).toBe(true);
    expect(ids(await dataOf(owner, vendor))).toEqual(items);
  });
});
