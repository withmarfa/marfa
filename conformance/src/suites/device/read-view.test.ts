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
});
