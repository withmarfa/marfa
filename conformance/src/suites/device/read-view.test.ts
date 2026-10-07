import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  certifiedRead,
  copyIncompleteReplay,
  copyLiveReplay,
  edgesPage,
  SCRIPTED_READ_VIEW,
  wireItem,
  withMetadata,
} from "../../device/marfa-answers.js";
import {
  hydratedHarness,
  scriptHydration,
  startHarness,
  type Harness,
} from "./harness.js";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

async function prepared() {
  harness = await hydratedHarness("read-view", {
    rows: { "core.note": [{ item: { id: "held" } }] },
  });
  const h = harness;
  expect((await h.device.list()).ok).toBe(true);
  expect(
    (
      await h.device.create({
        type: "core.note",
        properties: { title: "unsent", body: "preserved" },
      })
    ).ok,
  ).toBe(true);
  h.server.copyAnswer("GET", "/items/control", {
    kind: "json",
    status: 200,
    body: withMetadata(wireItem({ id: "control" })),
  });
  h.server.copyAnswer("GET", /^\/items\/[^/]+\/edges$/, edgesPage([]));
  expect((await h.device.pin("control")).ok).toBe(true);
  return h;
}

describe("certified read views", () => {
  it.each([
    "missing proof",
    "malformed proof",
    "different proof",
    "missing listing",
    "nonboolean listing",
  ])("expires on %s without losing unsent work", async (fault) => {
    const h = await prepared();
    const before = await h.device.queue();
    const row = withMetadata(wireItem({ id: "untrusted" }));
    let response = certifiedRead({ kind: "json", status: 200, body: row });
    if (response.kind !== "json") throw new Error("expected a JSON response");
    if (fault === "missing proof") response = { ...response, headers: {} };
    if (fault === "malformed proof")
      response = {
        ...response,
        headers: { "X-Marfa-Read-View": "A".repeat(64) },
      };
    if (fault === "different proof")
      response = {
        ...response,
        headers: { "X-Marfa-Read-View": "b".repeat(64) },
      };
    if (fault === "missing listing") response = { ...response, body: row };
    if (fault === "nonboolean listing")
      response = { ...response, body: { ...row, listed: "true" } };
    h.server.answer("GET", "/items/untrusted", response);
    const pinned = await h.device.pin("untrusted");
    expect(pinned.ok).toBe(false);
    if (!pinned.ok) expect(pinned.refusal.code).toBe("copy_expired");
    const status = await h.device.status();
    expect(status.ok && status.value.hydration).toBe("expired");
    expect((await h.device.list()).ok).toBe(false);
    expect(await h.device.queue()).toEqual(before);
  });

  it.each([429, 503])(
    "keeps a certified offline copy after an uncertified %i",
    async (status) => {
      const h = await prepared();
      const before = await h.device.queue();
      h.server.answer("GET", "/items/unavailable", {
        kind: "json",
        status,
        body: {
          error: {
            code: status === 429 ? "rate_limited" : "unavailable",
            message: "try later",
          },
        },
      });
      expect((await h.device.pin("unavailable")).ok).toBe(false);
      const state = await h.device.status();
      expect(state.ok && state.value.hydration).toBe("complete");
      expect((await h.device.list()).ok).toBe(true);
      expect(await h.device.queue()).toEqual(before);
    },
  );

  it.each([
    ["a dropped connection", { kind: "drop" } as const],
    [
      "a gateway's refusal naming no contract",
      {
        kind: "json",
        status: 502,
        body: { error: { code: "bad_gateway", message: "upstream" } },
        contract: null,
      } as const,
    ],
  ])("keeps a certified offline copy after %s", async (_what, answer) => {
    const h = await prepared();
    const before = await h.device.queue();
    h.server.answer("GET", "/items/unavailable", answer);
    expect((await h.device.pin("unavailable")).ok).toBe(false);
    const state = await h.device.status();
    expect(state.ok && state.value.hydration).toBe("complete");
    expect((await h.device.list()).ok).toBe(true);
    expect(await h.device.queue()).toEqual(before);
  });

  it("refuses a certified page without explicit termination while retaining unsent work", async () => {
    const h = await prepared();
    const before = await h.device.queue();
    h.server.copyAnswer("GET", "/items", {
      kind: "json",
      status: 200,
      body: { data: [] },
    });
    expect((await h.device.hydrate(["core.note"], "library")).ok).toBe(true);
    const rebuilt = await h.device.hydrate(["core.note"], "library");
    expect(rebuilt.ok).toBe(false);
    if (!rebuilt.ok) expect(rebuilt.refusal.code).toBe("copy_expired");
    expect((await h.device.list()).ok).toBe(false);
    expect(await h.device.queue()).toEqual(before);
  });

  it("requires the actual live marker even when the announced head is already held", async () => {
    harness = await startHarness("read-view-live");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.answer(
      "GET",
      "/events",
      copyIncompleteReplay("10", []),
      copyLiveReplay("10", []),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const incomplete = await device.catchUp();
    expect(incomplete.ok).toBe(false);
    if (!incomplete.ok)
      expect(incomplete.refusal.code).toBe("stream_incomplete");
    const state = await device.status();
    expect(state.ok && state.value.hydration).toBe("complete");
    expect((await device.catchUp()).ok).toBe(true);
    const resumes = server.requests.filter(
      (request) =>
        request.pathname === "/events" &&
        request.headers["last-event-id"] !== undefined,
    );
    expect(resumes.length).toBeGreaterThanOrEqual(3);
    expect(
      resumes.every(
        (request) =>
          request.headers["x-marfa-read-view"] === SCRIPTED_READ_VIEW,
      ),
    ).toBe(true);
  });

  it("reports a hydration that ended on an invalid page as expired, not in progress", async () => {
    const h = await prepared();
    h.server.copyAnswer("GET", "/items", {
      kind: "json",
      status: 200,
      body: { data: [] },
    });
    expect((await h.device.hydrate(["core.note"], "library")).ok).toBe(true);
    const rebuilt = await h.device.hydrate(["core.note"], "library");
    expect(rebuilt.ok).toBe(false);
    const state = await h.device.status();
    expect(
      state.ok && state.value.hydration,
      "a hydration the server's page expired reported itself as still under way",
    ).toBe("expired");
  });

  it("refuses reads of a stored copy that lost its instance, through a reader as through the writer", async () => {
    const h = await prepared();
    // The witness: the copy reads before its instance is taken away.
    expect((await h.device.list()).ok).toBe(true);
    const store = new DatabaseSync(h.device.store);
    try {
      store.exec("DELETE FROM meta WHERE key = 'instance_id'");
    } finally {
      store.close();
    }
    const bytes = readFileSync(h.device.store);
    const reader = h.device.reopen({ reader: true });
    const read = await reader.list();
    expect(
      read.ok,
      "a reader answered a copy that names no instance it can be held to",
    ).toBe(false);
    if (!read.ok) expect(read.refusal.code).toBe("hydration_incomplete");
    const reported = await reader.status();
    expect(reported.ok && reported.value.hydration).toBe("expired");
    expect(
      readFileSync(h.device.store).equals(bytes),
      "a reader wrote to the store",
    ).toBe(true);

    const written = await h.device.list();
    expect(written.ok).toBe(false);
    if (!written.ok) expect(written.refusal.code).toBe("hydration_incomplete");
    const state = await h.device.status();
    expect(state.ok && [state.value.hydration, state.value.event_cursor ?? null]).toEqual([
      "expired",
      null,
    ]);
  });
});
