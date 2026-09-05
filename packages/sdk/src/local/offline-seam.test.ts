/**
 * The seam itself.
 *
 * Every scenario in this directory rests on a mode doing what its name
 * says, and most of them cannot tell. A scenario built on `lost_response`
 * passes identically if the mode quietly degraded to `offline`, because
 * from the client both look like a request that failed — and the whole
 * difference is what the server did. So the modes are asserted here, from
 * the outside, against what actually reached the server.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarfaClient } from "../client.js";
import {
  createKeysModeFixture,
  type KeysModeFixture,
} from "../test-harness.js";
import { createOfflineSeam, type OfflineSeam } from "./offline-seam.js";

let fixture: KeysModeFixture;
let seam: OfflineSeam;
/** Through the seam. */
let client: MarfaClient;
/** Around it, so a scenario can ask the server what really happened. */
let direct: MarfaClient;

beforeEach(async () => {
  fixture = await createKeysModeFixture();
  seam = createOfflineSeam(fixture.fetch);
  client = new MarfaClient({
    url: "http://localhost",
    apiKey: fixture.adminKey,
    fetch: seam.fetch,
  });
  direct = new MarfaClient({
    url: "http://localhost",
    apiKey: fixture.adminKey,
    fetch: fixture.fetch,
  });
});

afterEach(() => {
  fixture.cleanup();
});

describe("offline", () => {
  it("does not reach the server at all", async () => {
    seam.mode = "offline";
    await expect(
      client.items.create({ type: "core.note", properties: { body: "never" } }),
    ).rejects.toThrow(/Network request/);

    // The half that matters and that no scenario using this mode checks:
    // nothing was written. A mode that reached the server and then hid the
    // answer would look identical from the client, and every "offline is
    // not an attempt" scenario would be measuring the wrong thing.
    expect((await direct.items.list({ state: "any" })).data).toEqual([]);
    expect(seam.calls).toEqual(["POST /items"]);
  });
});

describe("lost_response", () => {
  it("lets the write land and hides the answer", async () => {
    seam.mode = "lost_response";
    await expect(
      client.items.create({
        type: "core.note",
        properties: { body: "landed anyway" },
      }),
    ).rejects.toThrow(/Network request/);

    // Indistinguishable from `offline` at the client, and the opposite of
    // it at the server. This is the whole reason a write carries a key,
    // and the property the delete scenario silently depends on.
    const stored = (await direct.items.list({ state: "any" })).data;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ properties: { body: "landed anyway" } });
  });
});

describe("unauthorized and server_error", () => {
  it("refuse rather than failing to arrive", async () => {
    seam.mode = "unauthorized";
    await expect(client.items.list({})).rejects.toMatchObject({ status: 401 });

    seam.mode = "server_error";
    await expect(client.items.list({})).rejects.toMatchObject({ status: 503 });

    // Refusals, so the server was reached and answered — the distinction
    // the failure classification turns on, since a status of zero is not
    // an attempt and a status is.
    expect((await direct.items.list({ state: "any" })).data).toEqual([]);
  });
});

describe("stream_close", () => {
  it("carries the opening frame and then ends the connection", async () => {
    seam.mode = "stream_close";

    const opens: number[] = [];
    const cursors: string[] = [];
    const errors: unknown[] = [];
    const subscription = client.events.subscribe({
      initialRetryMs: 5,
      onOpen: () => opens.push(Date.now()),
      onCursor: (cursor) => cursors.push(cursor),
      onEvent: () => undefined,
      onError: (error) => errors.push(error),
    });

    // Reconnects rather than reporting, which is what an idle timeout at
    // an intermediary looks like — and what makes a silently-skipped gap
    // indistinguishable from a healthy quiet stream unless something
    // catches up.
    await new Promise((resolve) => setTimeout(resolve, 200));
    subscription.close();

    expect(opens.length).toBeGreaterThan(1);
    // Every connection said where the log stood before it ended. Cutting
    // before the first payload frame would reproduce a connection that
    // never worked, which is a different failure: a client never told
    // where the log stands has nothing to catch up from.
    expect(cursors).toHaveLength(opens.length);
    expect(errors).toEqual([]);
  });

  it("leaves every other request alone", async () => {
    seam.mode = "stream_close";
    const made = await client.items.create({
      type: "core.note",
      properties: { body: "ordinary" },
    });
    expect(await client.items.get(made.id)).toMatchObject({ id: made.id });
  });
});

describe("what the seam records", () => {
  it("keeps the query and the headers a scenario has to assert on", async () => {
    await client.items.list({ state: "any", limit: 5 });
    await client.items.create(
      { type: "core.note", properties: { body: "keyed" } },
      { idempotencyKey: "a-key-a-scenario-can-name" },
    );

    const read = seam.requests.find((request) => request.path === "/items");
    expect(read?.query).toMatchObject({ state: "any", limit: "5" });

    // Lower-cased, because that is how a header name compares. A scenario
    // asserting on the wrong spelling would read as a missing header
    // rather than as its own mistake.
    const write = seam.requests.find((request) => request.method === "POST");
    expect(write?.headers["idempotency-key"]).toBe("a-key-a-scenario-can-name");
  });
});
