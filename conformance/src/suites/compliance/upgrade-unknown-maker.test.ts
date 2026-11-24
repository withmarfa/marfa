import { createHmac } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished } from "vitest";
import { controlRequest } from "../../utils/control-request.js";
import {
  FRESH_SERVER_TIMEOUT_MS,
  keepStatusLog,
} from "../../utils/fresh-server.js";
import { stopServerAtCleanup } from "../../utils/refused-boot.js";
import { KEY_SALT, loadDump, WORKING_KEY } from "../../utils/release-dump.js";
import { tempFolder } from "../../utils/temp-folder.js";
import {
  bootUnclaimedServer,
  stopServer,
} from "../../../scripts/marfa-server.js";

/**
 * Keys of unknown maker, made by upgrading a database an earlier release wrote.
 *
 * v0.0.90 did not keep who made each key. The dump in `fixtures/` holds one
 * key, the working key, whose `key.create` record names the local command, so
 * the upgrade records it as the owner's. Each test starts two servers on that
 * dump. On the first, the working key's `key.create` record is removed before
 * the start, so no record of the instance shows the owner made it, and the
 * upgrade records it of unknown maker. On the second the record stays, so the
 * same key upgrades as the owner's. Each refusal on the first is held against
 * the same request, from the same key, succeeding on the second.
 *
 * Besides the working key, the dump gets a key it minted (the child), a key a
 * signed-in app's grant minted, a key a grant that has ended minted, and the
 * types and items an app holds. They are added to the loaded copy before the
 * upgrade, with every column of their rows and audit records set as v0.0.90
 * wrote it. The vendors the owner holds, their items, the type with guidance
 * and the working key's type map are made through the owner after the start.
 */

const WORKING_ID = "01a20551-502b-763f-8813-6908e83cb77c";
const OWNER_ID = "01a20551-501c-7195-83a1-94de5e30d8fc";
/** Keys the working key and two apps' grants minted, made up for this file. */
const CHILD_KEY = `marfa_k1_${"c1".repeat(32)}`;
const APP_KEY = `marfa_k1_${"a9".repeat(32)}`;
const ENDED_KEY = `marfa_k1_${"b7".repeat(32)}`;
const CHILD_ID = "01f00000-0000-7000-8000-0000000000c1";
const APP_KEY_ID = "01f00000-0000-7000-8000-0000000000a9";
const ENDED_KEY_ID = "01f00000-0000-7000-8000-0000000000b7";
const CLIENT = "client-acme";
const GRANT = "grant-acme";
/** An app whose consent is gone, which only the grant's records name. */
const ENDED_CLIENT = "client-ended";
const ENDED_GRANT = "grant-ended";
const AT = "2026-11-22T22:13:00.000Z";
/** The owner's browser session that approved the ended grant's app. */
const SESSION = "01f00000-0000-7000-8000-0000000000e5";
/** Keys of the two apps that minted the keys above, whose rows cleanup had reaped. */
const APP_MINTER_ID = "01f00000-0000-7000-8000-0000000000f1";
const ENDED_MINTER_ID = "01f00000-0000-7000-8000-0000000000f2";

/** A vendor the app holds, and one it holds that a test removes the data of. */
const HELD = "app.acme";
const HELD_ITEM = "01f00000-0000-7000-8000-0000000000b1";
const GONE = "app.gone";
const GONE_ITEM = "01f00000-0000-7000-8000-0000000000b3";
/** A vendor the app of the ended grant holds, through a key it made. */
const ENDED = "app.ended";
const ENDED_ITEM = "01f00000-0000-7000-8000-0000000000b4";
/** Vendors the owner holds, made after the start. */
const OWNED = "app.mine";
const OWNED_ITEM = "01f00000-0000-7000-8000-0000000000b2";
/** An owner-held vendor a test gives to the app. */
const MOVED = "app.moved";
const MOVED_ITEM = "01f00000-0000-7000-8000-0000000000b5";
/** A type that has guidance. */
const GUIDED = "user.guided";

/** The body "a core note", as the dump stores a property bag. */
const NOTE_BODY = "x'cc1147626f6479b76120636f7265206e6f7465'";
/** How v0.0.90 names an app's key as the actor of a write: the grant, and the key's label. */
const APP_ACTOR = { kind: "app", id: GRANT, name: "upgrade-app" };
const ENDED_ACTOR = { kind: "app", id: ENDED_GRANT, name: "upgrade-ended" };
const APP_MAKER = JSON.stringify({ kind: "app", id: GRANT, name: "Acme" });

function hashOf(secret: string): string {
  return createHmac("sha256", KEY_SALT).update(secret).digest("hex");
}

function quoted(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function typeRow(id: string, createdBy: string): string {
  const parent = "core.note";
  return `INSERT INTO types (id, parent, origin, created_by, definition, created_at, updated_at)
    VALUES (${quoted(id)}, '${parent}', 'user', ${quoted(createdBy)},
      ${quoted(JSON.stringify({ id, version: 0, fields: {}, parent, label: id }))},
      '${AT}', '${AT}');`;
}

function itemRow(id: string, type: string): string {
  return `INSERT INTO items (id, type, state, tier, source, version, schema_version, occurred_at,
      created_at, updated_at, last_activity_at, properties)
    VALUES (${quoted(id)}, ${quoted(type)}, 'active', 'library', 'upgrade-fixture', 1, 0,
      '${AT}', '${AT}', '${AT}', '${AT}', ${NOTE_BODY});`;
}

function keyRow(
  id: string,
  secret: string,
  source: string,
  types: object,
  permissions: string[],
): string {
  return `INSERT INTO api_keys (id, hash, label, source, permissions, type_permissions,
      edge_permissions, extension_permissions, metadata_permissions, profile_permissions, created_at)
    VALUES (${quoted(id)}, '${hashOf(secret)}', ${quoted(source)}, ${quoted(source)},
      ${quoted(JSON.stringify(permissions))}, ${quoted(JSON.stringify(types))},
      '{"*":"write"}', '{"*":"write"}', '{"*":"write"}', '{"*":"write"}', '${AT}');`;
}

/**
 * A `key.create` record as v0.0.90 wrote it for a request made with the minting
 * key: its id as `key_id`, the actor, the request's address, and the actor's id
 * in `details`. An app that minted an owner's key adds `owner_key`.
 */
function mintRecord(
  id: string,
  resourceId: string,
  minter: { keyId: string; actor: object; ownerKey?: boolean },
): string {
  const details = {
    actor: minter.keyId,
    ...(minter.ownerKey ? { owner_key: true } : {}),
  };
  return `INSERT INTO audit_log (id, created_at, key_id, actor, action, kind, resource_type,
      resource_id, client_ip, details)
    VALUES (${quoted(id)}, '${AT}', ${quoted(minter.keyId)}, ${quoted(JSON.stringify(minter.actor))},
      'key.create', 'access', 'key', ${quoted(resourceId)}, '127.0.0.1', ${quoted(JSON.stringify(details))});`;
}

const WORKING_PERMISSIONS = [
  "schema.write",
  "grants.manage",
  "items.purge",
  "keys.mint",
  "config.manage",
  "audit.read",
  "webhooks.manage",
];

/** Adds what the tests need to the dump, as the file an earlier release left. */
function seed(db: DatabaseSync, recordKept: boolean): void {
  const stored = db
    .prepare("SELECT hash FROM api_keys WHERE id = ?")
    .get(WORKING_ID)?.hash;
  expect(stored, "the dump's working key hashes under its salt").toBe(
    hashOf(WORKING_KEY),
  );
  // The ended grant has no consent row, as when the owner ended it. What
  // v0.0.90 kept of it is a record of the grant (`authorize.rs`,
  // `auth.grant.reused`) that names the client as its resource and the grant
  // in `details.grant_item_id`.
  db.exec(`
    INSERT INTO oauth_clients (client_id, application_type, redirect_uris, grant_types,
      response_types, scopes, contacts, created_at)
    VALUES ('${CLIENT}', 'native', '[]', '[]', '[]', '["content:write","metadata.types:write"]', '[]', '${AT}'),
      ('${ENDED_CLIENT}', 'native', '[]', '[]', '[]', '["content:write","metadata.types:write"]', '[]', '${AT}');
    INSERT INTO oauth_consents (client_id, owner_id, grant_id, scopes, created_at, updated_at)
    VALUES ('${CLIENT}', '${OWNER_ID}', '${GRANT}', '["content:write","metadata.types:write"]',
      '${AT}', '${AT}');
    INSERT INTO audit_log (id, created_at, key_id, actor, action, kind, resource_type,
      resource_id, client_ip, details)
    VALUES ('01f00000-0000-7000-8000-0000000000d3', '${AT}', 'owner:${SESSION}',
      '{"kind":"browser","id":"${SESSION}","name":"Browser"}', 'auth.grant.reused', 'access',
      'oauth_grant', '${ENDED_CLIENT}', '127.0.0.1',
      '{"client_id":"${ENDED_CLIENT}","owner_id":"${OWNER_ID}","scopes":["content:write","metadata.types:write"],"grant_item_id":"${ENDED_GRANT}"}');
    ${typeRow(`${HELD}.note`, APP_MAKER)}
    ${typeRow(`${GONE}.note`, APP_MAKER)}
    ${typeRow(`${ENDED}.note`, JSON.stringify({ kind: "key", id: ENDED_KEY_ID, name: "upgrade-ended" }))}
    ${itemRow(HELD_ITEM, `${HELD}.note`)}
    ${itemRow(GONE_ITEM, `${GONE}.note`)}
    ${itemRow(ENDED_ITEM, `${ENDED}.note`)}
    ${keyRow(CHILD_ID, CHILD_KEY, "upgrade-child", { "*": "write" }, WORKING_PERMISSIONS)}
    ${mintRecord("01f00000-0000-7000-8000-0000000000d1", CHILD_ID, { keyId: WORKING_ID, actor: { kind: "key", id: WORKING_ID, name: "upgrade-fixture" } })}
    ${keyRow(APP_KEY_ID, APP_KEY, "upgrade-app", { [`${HELD}.*`]: "write" }, [])}
    ${mintRecord("01f00000-0000-7000-8000-0000000000d2", APP_KEY_ID, { keyId: APP_MINTER_ID, actor: APP_ACTOR, ownerKey: true })}
    ${keyRow(ENDED_KEY_ID, ENDED_KEY, "upgrade-ended", { [`${ENDED}.*`]: "write" }, [])}
    ${mintRecord("01f00000-0000-7000-8000-0000000000d4", ENDED_KEY_ID, { keyId: ENDED_MINTER_ID, actor: ENDED_ACTOR, ownerKey: true })}
  `);
  if (!recordKept) {
    db.prepare(
      "DELETE FROM audit_log WHERE action = 'key.create' AND resource_id = ?",
    ).run(WORKING_ID);
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM audit_log WHERE action = 'key.create' AND resource_id = ?",
        )
        .get(WORKING_ID)?.n,
    ).toBe(0);
  }
}

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

interface Upgraded {
  url: string;
  /** How many items of a type the owner's listing of its vendor's data counts. */
  itemsOf(vendor: string, type: string): Promise<number>;
  answer(
    key: string,
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<Answer>;
  /** The same request, from the owner through the private socket. */
  owner(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<Answer>;
}

function typeBody(id: string, guidance?: string): object {
  return {
    id,
    version: 0,
    fields: {},
    parent: "core.note",
    label: id,
    ...(guidance === undefined ? {} : { guidance }),
  };
}

/**
 * Starts the server on the dump after the upgrade's inputs are seeded, with the
 * working key's mint record removed or kept, then has the owner make what an
 * owner can make. Both the server and its log end with the test.
 */
async function upgraded(
  recordKept: boolean,
  alter: (db: DatabaseSync) => void = () => undefined,
): Promise<Upgraded> {
  const state = tempFolder("marfa-unknown-maker-");
  loadDump(join(state, "marfa.db"), (db) => {
    seed(db, recordKept);
    alter(db);
  });
  const { url, controlSocket } = await bootUnclaimedServer({
    state,
    env: { MARFA_KEY_SALT: KEY_SALT },
  });
  stopServerAtCleanup(state);
  onTestFinished(async () => {
    keepStatusLog(state);
    await stopServer({ state });
  }, FRESH_SERVER_TIMEOUT_MS);
  const owner: Upgraded["owner"] = (path, init = {}) =>
    controlRequest(controlSocket, path, init);
  const answer: Upgraded["answer"] = async (key, path, init = {}) => {
    const response = await fetch(`${url}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${key}`,
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
  };
  const made = async (path: string, body: object, as?: string) => {
    const got =
      as === undefined
        ? await owner(path, { method: "POST", body })
        : await answer(as, path, { method: "POST", body });
    expect(got.status, JSON.stringify(got.body)).toBe(201);
    return got;
  };
  // The private socket writes no item, so a key the owner mints through it does.
  const writer = (
    await made("/keys", {
      label: "owner-writer",
      source: "upgrade-owner-writer",
      type_permissions: { "*": "write", "app.*": "write" },
    })
  ).body.key as string;
  for (const [vendor, id] of [
    [OWNED, OWNED_ITEM],
    [MOVED, MOVED_ITEM],
  ] as const) {
    await made("/types", typeBody(`${vendor}.note`));
    await made(
      "/items",
      { id, type: `${vendor}.note`, properties: { body: "owner's" } },
      writer,
    );
  }
  await made("/types", typeBody(GUIDED, "Kept."));
  return {
    url,
    owner,
    async itemsOf(vendor, type) {
      const listed = await owner(`/app-vendors/${vendor}/data`);
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      const row = (
        listed.body.types as Array<{
          type: string;
          active: number;
          archived: number;
          trashed: number;
        }>
      ).find((entry) => entry.type === type);
      return row === undefined ? 0 : row.active + row.archived + row.trashed;
    },
    answer,
  };
}

/** The pair every test holds a refusal against: no record of the maker, and the record kept. */
async function pair(
  alter?: (db: DatabaseSync) => void,
): Promise<{ unknown: Upgraded; known: Upgraded }> {
  return {
    unknown: await upgraded(false, alter),
    known: await upgraded(true, alter),
  };
}

/** The owner sets the working key's type map on both servers, which leaves who made it as it was. */
async function narrow(
  servers: { unknown: Upgraded; known: Upgraded },
  type_permissions: Record<string, string>,
): Promise<void> {
  for (const server of [servers.unknown, servers.known]) {
    const patched = await server.owner(`/keys/${WORKING_ID}`, {
      method: "PATCH",
      body: { type_permissions },
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  }
}

function code(got: Answer): unknown {
  return (got.body.error as { code?: string } | undefined)?.code;
}

/** A refusal for who the key is, not for a scope it lacks. */
function expectRefused(got: Answer, expected: string = "forbidden"): void {
  expect(got.status, JSON.stringify(got.body)).toBe(403);
  expect(code(got), JSON.stringify(got.body)).toBe(expected);
  expect(
    (got.body.error as { details?: Record<string, unknown> }).details
      ?.required_scope,
    JSON.stringify(got.body),
  ).toBeUndefined();
}

/** An item a key may not reach is answered as one that does not exist. */
function expectConcealed(got: Answer): void {
  expect(got.status, JSON.stringify(got.body)).toBe(404);
  expect(code(got), JSON.stringify(got.body)).toBe("item_not_found");
}

function expectOk(got: Answer, status = 200): void {
  expect(got.status, JSON.stringify(got.body)).toBe(status);
}

const give = (vendor: string) => ({
  method: "PUT",
  body: { client_id: CLIENT },
  path: `/app-vendors/${vendor}`,
});

async function holder(server: Upgraded, vendor: string): Promise<unknown> {
  const listed = await server.owner("/app-vendors");
  expectOk(listed);
  const entry = (
    listed.body.data as Array<{ vendor: string; client_id: string | null }>
  ).find((row) => row.vendor === vendor);
  return entry?.client_id;
}

const readItem = (server: Upgraded, key: string, id: string) =>
  server.answer(key, `/items/${id}`);

describe("a key of unknown maker after an upgrade", () => {
  it(
    "records as of unknown maker a key and the key it minted when no record shows the owner made them, and as the owner's when the record stays",
    async () => {
      const { unknown, known } = await pair();
      // Owner-made keys reach an app's item through `*`, so a refusal below is
      // the maker's doing.
      expectOk(await readItem(known, WORKING_KEY, HELD_ITEM));
      expectOk(await readItem(known, CHILD_KEY, HELD_ITEM));
      // The consent names the app whose grant minted the app's key, so that key
      // is not of unknown maker on either: it reaches the app's vendor.
      expectOk(await readItem(known, APP_KEY, HELD_ITEM));
      expectOk(await readItem(unknown, APP_KEY, HELD_ITEM));
      // No record names who made the working key or the key it minted.
      for (const key of [WORKING_KEY, CHILD_KEY]) {
        expectConcealed(await readItem(unknown, key, HELD_ITEM));
      }
      // The app holds the vendor on both.
      expect(await holder(known, HELD)).toBe(CLIENT);
      expect(await holder(unknown, HELD)).toBe(CLIENT);
    },
    FRESH_SERVER_TIMEOUT_MS * 3,
  );

  it(
    "records as of unknown maker a key whose minting key was removed with its record, and as the owner's when the record stays",
    async () => {
      // A v0.0.90 server reaped key rows (`keys/reap.rs`), so the working key
      // may be gone while its child and its mint record remain.
      const { unknown, known } = await pair((db) => {
        db.prepare("DELETE FROM api_keys WHERE id = ?").run(WORKING_ID);
      });
      // The witness: the working key is gone on both.
      expect((await readItem(known, WORKING_KEY, HELD_ITEM)).status).toBe(401);
      expect((await readItem(unknown, WORKING_KEY, HELD_ITEM)).status).toBe(
        401,
      );
      // The record kept: the child is the owner's, so `*` reaches the app's item.
      expectOk(await readItem(known, CHILD_KEY, HELD_ITEM));
      expectOk(await readItem(known, CHILD_KEY, OWNED_ITEM));
      // The record removed: nothing names who made the child.
      expectConcealed(await readItem(unknown, CHILD_KEY, HELD_ITEM));
      expectConcealed(await readItem(unknown, CHILD_KEY, OWNED_ITEM));
    },
    FRESH_SERVER_TIMEOUT_MS * 3,
  );

  it(
    "records as an app's the key a grant that has ended minted, named through the records of the grant",
    async () => {
      const server = await upgraded(true);
      // Only the records of the grant pair it with its app: the consent is gone.
      expect(await holder(server, ENDED)).toBe(ENDED_CLIENT);
      expectOk(await readItem(server, ENDED_KEY, ENDED_ITEM));
      expectConcealed(await readItem(server, ENDED_KEY, HELD_ITEM));
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "records as of unknown maker the key an unknown key mints",
    async () => {
      const { unknown, known } = await pair();
      const mint = async (server: Upgraded) => {
        const minted = await server.answer(WORKING_KEY, "/keys", {
          method: "POST",
          body: {
            label: "descendant",
            source: "upgrade-descendant",
            permissions: ["grants.manage", "schema.write"],
            type_permissions: { "*": "write" },
          },
        });
        expectOk(minted, 201);
        return minted.body.key as string;
      };
      const fromUnknown = await mint(unknown);
      const fromKnown = await mint(known);
      const move = give(MOVED);
      // The witness: the descendant holds grants.manage, so it lists vendors,
      // and the owner's key's child moves a vendor.
      expectOk(await unknown.answer(fromUnknown, "/app-vendors"));
      expectOk(
        await known.answer(fromKnown, move.path, {
          method: move.method,
          body: move.body,
        }),
      );
      expectRefused(
        await unknown.answer(fromUnknown, move.path, {
          method: move.method,
          body: move.body,
        }),
      );
      expect(await holder(unknown, MOVED)).toBeNull();
    },
    FRESH_SERVER_TIMEOUT_MS * 3,
  );

  it(
    "reaches the items of a type under app.* only as its map names them there, and only where the owner holds the vendor, never where an app holds it",
    async () => {
      const patch = (server: Upgraded, id: string) =>
        server.answer(WORKING_KEY, `/items/${id}`, {
          method: "PATCH",
          body: { version: 1, properties: { body: "changed" } },
        });
      const writes = await pair();
      await narrow(writes, { "*": "write", "app.*": "write" });
      // The witness: the same key with its record kept reaches both vendors.
      expectOk(await readItem(writes.known, WORKING_KEY, OWNED_ITEM));
      expectOk(await readItem(writes.known, WORKING_KEY, HELD_ITEM));
      // Named under app.*, the owner's vendor is reached, and written, and the app's is not.
      expectOk(await readItem(writes.unknown, WORKING_KEY, OWNED_ITEM));
      expectOk(await patch(writes.unknown, OWNED_ITEM));
      expectConcealed(await readItem(writes.unknown, WORKING_KEY, HELD_ITEM));

      // Named read for one vendor, that vendor reads and is not written, and
      // another owner-held vendor the map does not name is not reached.
      const reads = await pair();
      await narrow(reads, { "*": "write", [`${OWNED}.*`]: "read" });
      expectOk(await readItem(reads.known, WORKING_KEY, MOVED_ITEM));
      expectOk(await readItem(reads.unknown, WORKING_KEY, OWNED_ITEM));
      expectRefused(
        await patch(reads.unknown, OWNED_ITEM),
        "type_not_permitted",
      );
      expectConcealed(await readItem(reads.unknown, WORKING_KEY, MOVED_ITEM));
    },
    FRESH_SERVER_TIMEOUT_MS * 5,
  );

  it(
    "reaches nothing under app.* through the entry * alone",
    async () => {
      const { unknown, known } = await pair();
      expectOk(await readItem(known, WORKING_KEY, OWNED_ITEM));
      expectConcealed(await readItem(unknown, WORKING_KEY, OWNED_ITEM));
    },
    FRESH_SERVER_TIMEOUT_MS * 3,
  );

  it(
    "is refused a vendor move whatever permissions it holds, and the vendor stays with its holder",
    async () => {
      const { unknown, known } = await pair();
      const move = give(MOVED);
      // The witness: the key holds grants.manage, so it lists vendors.
      expectOk(await unknown.answer(WORKING_KEY, "/app-vendors"));
      expect(await holder(unknown, MOVED)).toBeNull();
      expectRefused(
        await unknown.answer(WORKING_KEY, move.path, {
          method: move.method,
          body: move.body,
        }),
      );
      expect(await holder(unknown, MOVED)).toBeNull();
      expectOk(
        await known.answer(WORKING_KEY, move.path, {
          method: move.method,
          body: move.body,
        }),
      );
      expect(await holder(known, MOVED)).toBe(CLIENT);
    },
    FRESH_SERVER_TIMEOUT_MS * 3,
  );

  it(
    "is refused the list and the removal of an app's vendor data, and removes nothing",
    async () => {
      const { unknown, known } = await pair();
      const data = `/app-vendors/${GONE}/data`;
      // The vendor is one an app holds on the server under test.
      expect(await holder(unknown, GONE)).toBe(CLIENT);
      expectRefused(await unknown.answer(WORKING_KEY, data));
      expectRefused(
        await unknown.answer(WORKING_KEY, data, { method: "DELETE" }),
      );
      // The witness: the owner's key lists the data and removes it.
      expectOk(await known.answer(WORKING_KEY, data));
      expect(await known.itemsOf(GONE, `${GONE}.note`)).toBe(1);
      expectOk(await known.answer(WORKING_KEY, data, { method: "DELETE" }));
      expect(await unknown.itemsOf(GONE, `${GONE}.note`)).toBe(1);
      expect(await known.itemsOf(GONE, `${GONE}.note`)).toBe(0);
    },
    FRESH_SERVER_TIMEOUT_MS * 3,
  );

  it(
    "is refused adding, changing or removing a type's guidance, and the type stays as it was",
    async () => {
      const { unknown, known } = await pair();
      const body = (guidance?: string) => ({
        version: 0,
        fields: {},
        parent: "core.note",
        label: "Guided",
        ...(guidance === undefined ? {} : { guidance }),
      });
      const put = (server: Upgraded, guidance?: string) =>
        server.answer(WORKING_KEY, `/types/${GUIDED}`, {
          method: "PUT",
          body: { id: GUIDED, ...body(guidance) },
        });
      const add = (server: Upgraded, id: string, guidance?: string) =>
        server.answer(WORKING_KEY, "/types", {
          method: "POST",
          body: { id, ...body(guidance) },
        });
      // The witness: the unknown key keeps guidance as it is, and registers a
      // type with none, so it is the change that is refused.
      expectOk(await put(unknown, "Kept."));
      expectOk(await add(unknown, "user.plain"), 201);
      expectRefused(await add(unknown, "user.advised", "Use it."));
      expectRefused(await put(unknown, "Changed."));
      expectRefused(await put(unknown));
      const read = await unknown.answer(WORKING_KEY, `/types/${GUIDED}`);
      expectOk(read);
      expect(read.body.guidance).toBe("Kept.");
      expect(
        (await unknown.answer(WORKING_KEY, "/types/user.advised")).status,
      ).toBe(404);
      // The same three changes, with the record kept.
      expectOk(await add(known, "user.advised", "Use it."), 201);
      expectOk(await put(known, "Changed."));
      expectOk(await put(known));
    },
    FRESH_SERVER_TIMEOUT_MS * 3,
  );
});
