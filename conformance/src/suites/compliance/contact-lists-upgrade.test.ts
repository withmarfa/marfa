import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { MarfaItem } from "../../client/types.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import { streamHead } from "../../utils/stream-tap.js";

/**
 * A database a release before the contact lists wrote, holding `email`,
 * `phone` and `place` on entities. The fixture writes them as the
 * undeclared properties they now are, then drops the bin-order index and the
 * `source_names` and `trash_with_hosts` tables that later versions add and
 * stamps the database with the schema version before the update, so the next
 * start updates it.
 */
const SOURCE = "contact-lists-upgrade";
const BEFORE_CONTACT_LISTS = 3;

let server: FreshServer;
let head: string;
const made: Record<string, MarfaItem> = {};
const after: Record<string, MarfaItem> = {};

function working(): MarfaClient {
  return new MarfaClient({ baseUrl: server.apiUrl, apiKey: server.workingKey });
}

/** An item as a read answers it; one in the bin is read from the listing. */
async function read(item: MarfaItem): Promise<MarfaItem> {
  if (item.state !== "trashed") {
    const got = await working().getItem(item.id);
    expect(got.ok, JSON.stringify(got.error)).toBe(true);
    return got.data.item;
  }
  const listed = await working().listItems({
    state: "trashed",
    source: SOURCE,
  });
  expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
  const found = listed.data.data.find((row) => row.id === item.id);
  expect(found, `${item.id} in the bin`).toBeDefined();
  return found!;
}

const STORED: Record<
  string,
  { type: string; properties: Record<string, unknown> }
> = {
  moved: {
    type: "core.entity.person",
    properties: {
      name: "Moved",
      email: "moved@example.com",
      phone: "+44 20 7946 0000",
      place: "1 High Street",
    },
  },
  odd: {
    type: "core.entity",
    properties: { name: "Odd", email: "", phone: 42, place: "  " },
  },
  invalid: {
    type: "core.entity.person",
    properties: {
      name: "Invalid",
      email: "not an email",
      phone: "+1 555 0100",
      phones: [{ value: "+1 555 0199" }],
    },
  },
  held: {
    type: "core.entity.person",
    properties: {
      name: "Held",
      email: "held@example.com",
      emails: [
        { value: "main@example.com" },
        { value: "held@example.com", label: "work" },
      ],
      place: "3 Side Lane",
      addresses: [{ street_address: "3 Side Lane", locality: "Town" }],
    },
  },
  binned: {
    type: "core.entity.place",
    properties: { name: "Binned", place: "2 Low Road" },
  },
  note: {
    type: "core.note",
    properties: { body: "not an entity", email: "note@example.com" },
  },
};

beforeAll(async () => {
  server = await bootFreshServer(SOURCE);
  for (const [name, { type, properties }] of Object.entries(STORED)) {
    const created = await working().createItem({
      type,
      source: SOURCE,
      properties,
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    made[name] = created.data.item;
  }
  const binned = await working().deleteItem(made.binned!.id);
  expect(binned.ok, JSON.stringify(binned.error)).toBe(true);
  made.binned = await read({ ...made.binned!, state: "trashed" });
  head = await streamHead(server.apiUrl, server.workingKey);
  await server.restart({
    whileStopped: () => {
      withInstanceDatabase(server.sqlitePath, (db) => {
        db.exec("DROP INDEX idx_items_state_binned_at");
        db.exec("DROP TABLE source_names");
        db.exec("DROP TABLE trash_with_hosts");
        db.exec(`PRAGMA user_version = ${String(BEFORE_CONTACT_LISTS)}`);
      });
    },
  });
  for (const [name, item] of Object.entries(made))
    after[name] = await read(item);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

describe("starting on a database written before the contact lists", () => {
  it("moves a stored email, phone and place into one-entry lists", () => {
    expect(after.moved!.properties).toEqual({
      name: "Moved",
      emails: [{ value: "moved@example.com" }],
      phones: [{ value: "+44 20 7946 0000" }],
      addresses: [{ street_address: "1 High Street" }],
    });
    expect(after.binned!.state).toBe("trashed");
    expect(after.binned!.properties).toEqual({
      name: "Binned",
      addresses: [{ street_address: "2 Low Road" }],
    });
    expect(after.note!.properties).toEqual(made.note!.properties);
    expect(after.note!.version).toBe(made.note!.version);
  });

  it("removes an empty email and keeps a value it cannot move under its own field", () => {
    expect(after.odd!.properties).toEqual({ name: "Odd", phone: 42 });
    expect(after.invalid!.properties).toEqual({
      name: "Invalid",
      email: "not an email",
      phone: "+1 555 0100",
      phones: [{ value: "+1 555 0199" }],
    });
    expect(after.invalid!.version).toBe(made.invalid!.version);
  });

  it("removes an email and a place their lists already hold, and leaves the lists as they were", () => {
    expect(after.held!.properties).toEqual({
      name: "Held",
      emails: [
        { value: "main@example.com" },
        { value: "held@example.com", label: "work" },
      ],
      addresses: [{ street_address: "3 Side Lane", locality: "Town" }],
    });
  });

  it("gives a changed item its next version, with the old one in its history and an item.updated event", async () => {
    const moved = after.moved!;
    for (const name of ["moved", "held"]) {
      expect(after[name]!.version, name).toBe(made[name]!.version + 1);
      const history = await working().getVersions(made[name]!.id);
      expect(history.ok, JSON.stringify(history.error)).toBe(true);
      const old = history.data.data.find(
        (version) => version.version === made[name]!.version,
      );
      expect(old?.properties, name).toEqual(STORED[name]!.properties);
    }
    const sentinel = await working().createItem({
      type: "core.note",
      source: SOURCE,
      properties: { body: "after the update" },
    });
    expect(sentinel.status).toBe(201);
    await withStream(
      server.apiUrl,
      server.workingKey,
      { lastEventId: head },
      async (stream) => {
        const { events } = await collectUntil(
          stream,
          (frames) =>
            frames.some(
              (frame) =>
                (frame.data as { item?: { id?: string } }).item?.id ===
                sentinel.data.item.id,
            ),
          "the replay to reach the item written after the update",
          AbortSignal.timeout(60_000),
        );
        const updated = events
          .filter((frame) => frame.event === "item.updated")
          .map((frame) => (frame.data as { item: MarfaItem }).item);
        expect(updated.map((item) => item.id).sort()).toEqual(
          [made.moved!.id, made.odd!.id, made.held!.id, made.binned!.id].sort(),
        );
        for (const item of [moved, after.held!]) {
          expect(updated.find((frame) => frame.id === item.id)).toMatchObject({
            version: item.version,
            properties: item.properties,
          });
        }
      },
    );

    // The writer of a version is read from its snapshot, which the next
    // change writes.
    const renamed = await working().updateItem(moved.id, {
      version: moved.version,
      properties: { name: "Moved again" },
    });
    expect(renamed.ok, JSON.stringify(renamed.error)).toBe(true);
    const later = await working().getVersions(moved.id);
    expect(
      later.data.data.find((version) => version.version === moved.version),
    ).toMatchObject({ properties: moved.properties, writer: null });
  });
});
