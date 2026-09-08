/**
 * A space's own subtype answers a filter on its parent, on both stream
 * paths.
 *
 * `?type=core.note` selects a subtree, and a space may put its own type
 * into that subtree by declaring `core.note` as the parent — registration
 * accepts a child whose identifier sits in another namespace entirely, so
 * `user.annotated_note` is a note as far as every read surface is
 * concerned. Resolving that lineage needs the space, because a custom
 * type lives in the space's overlay and nowhere else: a matcher called
 * without one classifies core and system types and silently misses
 * everything the space registered for itself.
 *
 * The direction of the failure is what makes it worth a suite. A filter
 * that admits too much is visible in the first frame a client did not
 * expect; a filter that is short delivers a 200 and an empty-looking
 * stream, and a durable client applying events by id has no way to notice
 * that the events it never received exist.
 *
 * **Both paths, because they are two pieces of code.** The subscription
 * filters live frames and the replay re-reads `event_log` and decides for
 * itself, and they agree only by passing the same arguments to the same
 * function. A fix applied to one is the shape this whole area keeps
 * producing: a view that narrows on reconnect and widens again while
 * connected.
 *
 * The route is mounted directly with a synthetic space-scoped credential
 * rather than driven through a provisioned space. What is under test is
 * which space the filter resolves against, and that is a property of the
 * credential the route reads; standing up a space to reach it would add a
 * fixture and test the provisioning path instead.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { ApiKey } from "@withmarfa/shared";
import {
  registerTypeSchema,
  unregisterTypeSchema,
  SPACE_PERMISSIONS,
} from "@withmarfa/shared";
import { createTestContext, readSse, settle } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { emitWake, type ItemEventWithId } from "../pubsub.js";
import { eventRoutes } from "./events.js";
import type { AppEnv } from "../middleware/auth.js";

const SPACE = "space-events-custom-subtype";
/** Named outside `core.note`'s namespace on purpose: a name-prefix match
 *  reaches a child called `core.note.annotated`, so a type spelled that
 *  way would pass whether or not the declared chain was resolved. */
const CUSTOM_SUBTYPE = "user.annotated_note";

let ctx: TestContext;
let app: Hono<AppEnv>;

beforeAll(async () => {
  ctx = await createTestContext();
  registerTypeSchema(
    { id: CUSTOM_SUBTYPE, version: 1, parent: "core.note", fields: {} },
    SPACE,
  );
  app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("apiKey", {
      id: "key-events-custom-subtype",
      name: "space viewer",
      key_hash: "unused",
      space_permissions: [...SPACE_PERMISSIONS],
      space_id: SPACE,
      type_permissions: { "*": "read" },
      extension_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
      created_at: new Date().toISOString(),
    } as unknown as ApiKey);
    await next();
  });
  app.route(
    "/events",
    eventRoutes(ctx.storage, { rlsEnforce: false, pgClient: null }),
  );
});

afterAll(async () => {
  unregisterTypeSchema(CUSTOM_SUBTYPE, SPACE);
  await ctx.cleanup();
});

/** A stored item row, as the publisher writes one. */
async function appendItemRow(id: string, type: string): Promise<bigint> {
  return ctx.storage.eventLog.append({
    event_type: "created",
    item_id: id,
    space_id: SPACE,
    payload: JSON.stringify({
      type: "item.created",
      item: { id, type, properties: {} },
    }),
  });
}

function emitItem(id: string, type: string): void {
  emitWake({
    type: "created",
    item: { id, type, properties: {} } as unknown as ItemEventWithId["item"],
    spaceId: SPACE,
    originatingConnectionId: null,
    hopCount: 0,
  });
}

describe("a space's own subtype under a parent-type filter", () => {
  it("is delivered on the live stream", async () => {
    const res = await app.request("/events?type=core.note");
    expect(res.status).toBe(200);

    // No budget of its own. The reads below are satisfied by an emit that
    // happens in the same tick, so any number tight enough to be worth
    // writing would be reporting on how loaded the machine is rather than
    // on whether the filter resolved.
    const reading = readSse(res, { until: (t) => t.includes("ZZanchorZZ") });
    // Lets the subscription attach before anything is published, so the
    // emits below cannot land while there is no listener.
    await settle();

    emitItem("ZZcustomZZ", CUSTOM_SUBTYPE);
    // Emitted last, and of the filtered type itself, so the read has a
    // terminator that arrives whether or not the subtype does — otherwise
    // proving the subtype absent would mean waiting out a budget and
    // reporting a delivery gap as an expired clock.
    emitItem("ZZanchorZZ", "core.note");

    const { text } = await reading;
    expect(text).toContain("ZZanchorZZ");
    expect(text).toContain("ZZcustomZZ");
  });

  it("is delivered on the Last-Event-ID replay", async () => {
    // A row for the cursor to point at: `Last-Event-ID: 0` against a log
    // whose oldest row is higher answers `catchup_too_old` and replays
    // nothing.
    const cursor = await appendItemRow("ZZseedZZ", "core.note");
    await appendItemRow("ZZreplayedcustomZZ", CUSTOM_SUBTYPE);
    await appendItemRow("ZZreplayedanchorZZ", "core.note");

    const res = await app.request("/events?type=core.note", {
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(res.status).toBe(200);

    const { text } = await readSse(res, {
      until: (t) => t.includes("ZZreplayedanchorZZ"),
    });
    expect(text).toContain("ZZreplayedanchorZZ");
    expect(text).toContain("ZZreplayedcustomZZ");
  });

  it("is not delivered to a filter naming an unrelated type", async () => {
    // The subtree resolution has to stay a resolution rather than become
    // "deliver everything a space registered", which is the way a fix for
    // the above passes both cases while filtering nothing.
    const cursor = await appendItemRow("ZZseed2ZZ", "core.media");
    await appendItemRow("ZZoutsideZZ", CUSTOM_SUBTYPE);
    await appendItemRow("ZZmediaanchorZZ", "core.media");

    const res = await app.request("/events?type=core.media", {
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(res.status).toBe(200);

    const { text } = await readSse(res, {
      until: (t) => t.includes("ZZmediaanchorZZ"),
    });
    expect(text).not.toContain("ZZoutsideZZ");
  });
});
