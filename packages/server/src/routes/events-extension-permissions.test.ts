/**
 * The stream shows a subscriber only the extension namespaces it may read.
 *
 * `filterMetadataForCaller` narrows an item's `extensions` map to what the
 * caller's `extension_permissions` admit, and every REST read of metadata
 * goes through it. The event path did not: `GET /events` narrows on the
 * item *type* alone, and the frame carries `event.metadata` verbatim — so
 * a credential holding no permission on a namespace still received its
 * contents, live and on replay, for every item whose type it could read.
 *
 * The realtime and webhooks pages both say payloads are filtered by the
 * subscriber's permissions. For extension namespaces that was not true.
 *
 * **Both delivery paths, because they are two different pieces of code.**
 * The live path serializes from the in-memory event; the `Last-Event-ID`
 * replay re-sends the stored `payload` string from `event_log` without
 * parsing it. A fix to one is not a fix.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  readSse,
  seedOauthBearer,
  settle,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { initEventLog } from "../pubsub.js";

let ctx: TestContext;

/** A member key that may read notes and read exactly one namespace. */
let scopedKey: string;

beforeAll(async () => {
  ctx = await createTestContext();
  // Without this the replay path has nothing to replay: `publish` only
  // appends when an event-log store is installed, and the test context
  // does not install one.
  initEventLog(ctx.storage.eventLog);
  const suffix = Math.random().toString(36).slice(2, 10);
  scopedKey = `marfa_k1_extperm_${suffix}`;
  await ctx.storage.keys.create(
    {
      label: `extperm-${suffix}`,
      source: `extperm-${suffix}`,
      role: "member",
      type_permissions: { "*": "write" },
      // `mine` is readable; `theirs` is not named at all, so the caller
      // holds nothing on it.
      extension_permissions: { mine: "read" },
      default_tier: "library",
      is_platform: false,
    },
    hashApiKey(scopedKey, TEST_API_KEY_SALT),
  );
});

afterAll(async () => {
  await ctx.cleanup();
});

/** An item carrying two namespaces, one the scoped key may read. */
async function itemWithTwoNamespaces(): Promise<string> {
  const created = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: { type: "core.note", properties: { body: "two-namespaces" } },
  });
  expect(created.status).toBe(201);
  const id = ((await created.json()) as { item: { id: string } }).item.id;
  for (const [namespace, value] of [
    ["mine", { visible: "yes" }],
    ["theirs", { secret: "not for you" }],
  ] as const) {
    const res = await request(
      ctx.app,
      "PUT",
      `/items/${id}/extensions/${namespace}`,
      { key: ctx.adminKey, body: value },
    );
    expect(res.status).toBe(200);
  }
  return id;
}

describe("metadata.changed on the live stream", () => {
  it("carries only the namespaces the subscriber may read", async () => {
    const id = await itemWithTwoNamespaces();

    const stream = await request(ctx.app, "GET", "/events", { key: scopedKey });
    expect(stream.status).toBe(200);

    // Written by an admin while the scoped key is watching. The subscriber's
    // permissions decide what it sees, not the writer's.
    const reading = readSse(stream, {
      until: (text) => text.includes("metadata.changed"),
    });
    await settle();
    const write = await request(
      ctx.app,
      "PUT",
      `/items/${id}/extensions/mine`,
      {
        key: ctx.adminKey,
        body: { visible: "updated" },
      },
    );
    expect(write.status).toBe(200);

    const { text } = await reading;
    expect(text).toContain("metadata.changed");
    // The permitted namespace arrives.
    expect(text).toContain("mine");
    // The one it holds nothing on does not, nor its contents.
    expect(text).not.toContain("theirs");
    expect(text).not.toContain("not for you");
  });

  it("covers item.updated too, not just metadata.changed", async () => {
    // The filter sits on the shared item-frame serializer, so it applies
    // to every frame carrying a metadata row — four event types besides
    // `metadata.changed`. Without a case here a filter keyed on the wire
    // name would pass every other test in this file while leaving those
    // four unnarrowed.
    const id = await itemWithTwoNamespaces();
    const stream = await request(ctx.app, "GET", "/events", { key: scopedKey });
    expect(stream.status).toBe(200);
    const reading = readSse(stream, {
      until: (text) => text.includes("item.updated"),
    });
    await settle();
    const patched = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.adminKey,
      body: { properties: { body: "touched" } },
    });
    expect(patched.status).toBe(200);

    const { text } = await reading;
    expect(text).toContain("item.updated");
    expect(text).toContain("mine");
    expect(text).not.toContain("theirs");
    expect(text).not.toContain("not for you");
  });

  it("is unfiltered for an admin subscriber", async () => {
    // The bypass every other permission map gives an admin. Without this
    // the filter could be a blanket strip and the test above would still
    // pass.
    const id = await itemWithTwoNamespaces();
    const stream = await request(ctx.app, "GET", "/events", {
      key: ctx.adminKey,
    });
    const reading = readSse(stream, {
      until: (text) => text.includes("metadata.changed"),
    });
    await settle();
    await request(ctx.app, "PUT", `/items/${id}/extensions/mine`, {
      key: ctx.adminKey,
      body: { visible: "updated" },
    });
    const { text } = await reading;
    expect(text).toContain("theirs");
    expect(text).toContain("not for you");
  });
});

describe("an OAuth-derived subscriber", () => {
  // Its own context: an OAuth principal with a projected role needs
  // hosted-mode storage with a user store, which the shared context above
  // does not have.
  let hosted: TestContext;

  beforeAll(async () => {
    hosted = await createTestContext({ authMode: "hosted" });
    initEventLog(hosted.storage.eventLog);
  });

  afterAll(async () => {
    await hosted.cleanup();
    // Hand the event log back to the file's main context, which the
    // replay suite below still needs.
    initEventLog(ctx.storage.eventLog);
  });

  it("receives no extension namespace at all", async () => {
    // OAuth tokens are minted with `extension_permissions: {}` and
    // `scope_enforced`, so they hold nothing on any namespace and their
    // projected role does not bypass the maps. The stream therefore shows
    // them no extension data — which is what a REST read already does,
    // and is the point: an app gets what the user granted it, not what
    // the user could see.
    const spaces = hosted.storage.spaces;
    if (!spaces) throw new Error("this test needs a space store");
    const space = await spaces.create("oauth-stream-space");
    // Projected `space_admin`, which passes the role gates and still does
    // not bypass the permission maps.
    // A real type grant, so the token clears the stream's type filter and
    // the only thing left to narrow the frame is the extension map. With
    // no scopes at all it receives no events whatever, which would make
    // the assertions below pass for the wrong reason.
    const { token } = await seedOauthBearer(
      hosted.storage,
      ["core.note:read"],
      { spaceId: space.id, userRole: "space_admin" },
    );

    const item = await hosted.storage.items.create(
      { type: "core.note", properties: { body: "an oauth item" } },
      space.id,
    );
    // Distinctive values, so an assertion that they are absent cannot be
    // satisfied — or defeated — by a substring of the item itself.
    await hosted.storage.metadata.setExtension(item.id, "mine", {
      marker: "ZZmineZZ",
    });
    await hosted.storage.metadata.setExtension(item.id, "theirs", {
      marker: "ZZtheirsZZ",
    });

    const stream = await request(hosted.app, "GET", "/events", { key: token });
    expect(stream.status).toBe(200);
    const reading = readSse(stream, {
      until: (text) => text.includes("metadata.changed"),
    });
    await settle();
    // Written by a credential inside the space, not by the platform admin:
    // the stream filters on the event's space, and a space-less writer
    // publishes a frame this subscriber never sees — which would make the
    // assertions below pass having read nothing.
    const suffix = Math.random().toString(36).slice(2, 8);
    const writerKey = `marfa_k1_oauthwriter_${suffix}`;
    await hosted.storage.keys.create(
      {
        label: `oauthwriter-${suffix}`,
        source: `oauthwriter-${suffix}`,
        role: "space_admin",
        type_permissions: { "*": "write" },
        default_tier: "library",
        is_platform: false,
      },
      hashApiKey(writerKey, TEST_API_KEY_SALT),
      space.id,
    );
    const write = await request(
      hosted.app,
      "PUT",
      `/items/${item.id}/extensions/mine`,
      { key: writerKey, body: { marker: "ZZmineZZ" } },
    );
    expect(write.status).toBe(200);

    const { text } = await reading;
    expect(text).toContain("metadata.changed");
    // Neither namespace, not even the one an api key with `mine: "read"`
    // would see: this credential holds nothing on any of them. Asserted on
    // the payload markers rather than the namespace names, which a frame
    // could carry for unrelated reasons.
    expect(text).not.toContain("ZZmineZZ");
    expect(text).not.toContain("ZZtheirsZZ");
  });
});

describe("metadata.changed on the Last-Event-ID replay", () => {
  it("carries only the namespaces the subscriber may read", async () => {
    // The replay re-sends the stored payload string without parsing it,
    // so it is a second, independent copy of the same disclosure.
    const id = await itemWithTwoNamespaces();
    // The cursor is taken from the log rather than guessed: a fixed "1"
    // trips the retention check on a log that has been trimmed, and the
    // stream then closes with `catchup_too_old` having replayed nothing.
    const before = await ctx.storage.eventLog.getAfter(0n, 1000);
    const cursor = before.length
      ? before.map((e) => e.id).reduce((a, b) => (a > b ? a : b))
      : 0n;
    const write = await request(
      ctx.app,
      "PUT",
      `/items/${id}/extensions/mine`,
      { key: ctx.adminKey, body: { visible: "replayed" } },
    );
    expect(write.status).toBe(200);
    // The write really did append, so the replay below has something to
    // find and the assertions are not vacuous.
    expect(
      (await ctx.storage.eventLog.getAfter(cursor, 100)).length,
    ).toBeGreaterThan(0);

    const stream = await request(ctx.app, "GET", "/events", {
      key: scopedKey,
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(stream.status).toBe(200);
    const { text } = await readSse(stream, {
      until: (t) => t.includes("metadata.changed"),
    });

    expect(text).toContain("metadata.changed");
    expect(text).toContain("mine");
    expect(text).not.toContain("theirs");
    expect(text).not.toContain("not for you");
  });

  it("covers item.updated too, not just metadata.changed", async () => {
    // The replay's twin of the live case. It re-serializes any stored
    // payload carrying a metadata block, whatever the event type, so a
    // filter keyed on the wire name would leave four types unnarrowed
    // here as well.
    const id = await itemWithTwoNamespaces();
    const before = await ctx.storage.eventLog.getAfter(0n, 1000);
    const cursor = before.length
      ? before.map((e) => e.id).reduce((a, b) => (a > b ? a : b))
      : 0n;
    const patched = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.adminKey,
      body: { properties: { body: "touched for replay" } },
    });
    expect(patched.status).toBe(200);
    expect(
      (await ctx.storage.eventLog.getAfter(cursor, 100)).length,
    ).toBeGreaterThan(0);

    const stream = await request(ctx.app, "GET", "/events", {
      key: scopedKey,
      headers: { "Last-Event-ID": String(cursor) },
    });
    const { text } = await readSse(stream, {
      until: (t) => t.includes("item.updated"),
    });
    expect(text).toContain("item.updated");
    // The permitted namespace arrives, as it does on the live twin.
    // Without this a filter that stripped every namespace would pass.
    expect(text).toContain("mine");
    expect(text).not.toContain("theirs");
    expect(text).not.toContain("not for you");
  });
});

describe("the replay's shape guard", () => {
  // `event_log` holds strings, so a payload's declared shape is a claim
  // about a stored row rather than a fact about it. These rows are appended
  // straight to the log rather than published, which is the shape the guard
  // exists for: an older payload, or one written by something other than
  // `publish`. Every regression named below ends the catch-up silently or
  // discloses bytes, and neither leaves a failing assertion of its own.

  /** Append a row verbatim and return the id the log gave it. */
  async function appendRow(
    eventType: string,
    itemId: string,
    payload: string,
  ): Promise<bigint> {
    return ctx.storage.eventLog.append({
      event_type: eventType,
      item_id: itemId,
      payload,
    });
  }

  /**
   * Replay everything after `cursor` and read until `marker` arrives. The
   * cursor is an appended row's own id rather than a scan of the log, so
   * the replay window is exactly the rows the test wrote.
   */
  async function replayAfter(cursor: bigint, marker: string): Promise<string> {
    const stream = await request(ctx.app, "GET", "/events", {
      key: scopedKey,
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(stream.status).toBe(200);
    const { text } = await readSse(stream, {
      until: (t) => t.includes(marker),
    });
    return text;
  }

  it("replays a payload carrying no metadata block byte-identical", async () => {
    // Reddens if the `metadata` shape check goes: the filter would read
    // `.extensions` off nothing, and the throw ends the catch-up so the
    // frame never arrives at all.
    const cursor = await appendRow(
      "updated",
      "shape-anchor-no-metadata",
      JSON.stringify({
        type: "item.updated",
        item: { id: "shape-anchor-no-metadata", type: "core.note" },
      }),
    );
    // Spaced where `JSON.stringify` would not space it, so byte-identical
    // is something the assertion can see rather than something it assumes.
    const payload =
      '{"type":"item.updated", "item":{"id":"shape-no-metadata","type":"core.note"}}';
    await appendRow("updated", "shape-no-metadata", payload);

    const text = await replayAfter(cursor, "shape-no-metadata");
    expect(text).toContain(`data: ${payload}\n`);
  });

  it("replays a metadata block carrying no extensions unchanged", async () => {
    // Reddens if the `extensions` shape check goes: the filter calls
    // `Object.entries` on a map that is not there, which throws, and the
    // catch-up ends there with the frame undelivered.
    const cursor = await appendRow(
      "metadata_changed",
      "shape-anchor-no-extensions",
      JSON.stringify({
        type: "metadata.changed",
        item: { id: "shape-anchor-no-extensions", type: "core.note" },
      }),
    );
    const payload =
      '{"type":"metadata.changed", "item":{"id":"shape-no-extensions","type":"core.note"}, "metadata":{"tags":["kept"]}}';
    await appendRow("metadata_changed", "shape-no-extensions", payload);

    const text = await replayAfter(cursor, "shape-no-extensions");
    expect(text).toContain(`data: ${payload}\n`);
  });

  it("skips a payload that does not parse and replays past it", async () => {
    // Reddens on either way the fail-closed rule can break: pass the bytes
    // through and the marker inside them arrives, or let the parse throw
    // and the row appended after it never does.
    const cursor = await appendRow(
      "updated",
      "shape-anchor-unparseable",
      JSON.stringify({
        type: "item.updated",
        item: { id: "shape-anchor-unparseable", type: "core.note" },
      }),
    );
    await appendRow(
      "updated",
      "shape-unparseable",
      '{"type":"item.updated","item":{"id":"shape-unparseable","type":"core.note"}} ZZunparseableZZ',
    );
    const after =
      '{"type":"item.updated","item":{"id":"shape-after-unparseable","type":"core.note"}}';
    await appendRow("updated", "shape-after-unparseable", after);

    const text = await replayAfter(cursor, "shape-after-unparseable");
    expect(text).toContain("shape-after-unparseable");
    expect(text).not.toContain("ZZunparseableZZ");
  });
});
