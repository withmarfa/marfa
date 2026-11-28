import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Outcome } from "../../device/protocol.js";
import { refusal, typeCatalog, wireType } from "../../device/marfa-answers.js";
import type { Responder } from "../../device/scripted-server.js";
import { scriptHydration, startHarness, type Harness } from "./harness.js";

/**
 * "Declaring an app's types brings the instance's copy of them up to date."
 *
 * Run against a scripted server, which holds the app's types in the
 * definitions a fixture names and answers `POST /types/normalize` with the
 * declaration as it was sent beside the type it holds. The server's own
 * normalization, and its refusals, are asserted by
 * `declare-replaces-live.test.ts` against a real one.
 */

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

const ENTRY = {
  id: "app.note.entry",
  fields: { title: { type: "string" }, mood: { type: "string" } },
};
const SAME = { id: "app.note.same", fields: { title: { type: "string" } } };
const SHARED = {
  id: "user.note_shared",
  fields: { title: { type: "string" } },
};

/** A held type that is not what the app declares: the declaration adds a field. */
const OLDER = (id: string) =>
  wireType(id, { fields: { title: { type: "string" } } });

/**
 * `POST /types/normalize` as a server whose registry holds `held` answers it:
 * the declaration as sent, and the held type, which is equal to the
 * declaration for a type named in `equal`.
 */
function normalizing(
  held: readonly string[],
  equal: readonly string[],
): Responder {
  return (request) => {
    const sent = JSON.parse(request.body) as { id: string };
    return {
      kind: "json",
      status: 200,
      body: {
        type: sent,
        registered_type: !held.includes(sent.id)
          ? null
          : equal.includes(sent.id)
            ? sent
            : { id: sent.id, fields: {}, version: 0 },
        resolved_type: null,
      },
    };
  };
}

function replaced(harness: Harness): string[] {
  return harness.server.requests
    .filter(
      (request) =>
        request.method === "PUT" && /^\/types\//.test(request.pathname),
    )
    .map((request) => request.pathname);
}

describe("a hydration of a copy that declared types", () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.stop();
    harness = undefined;
  });

  async function started(
    label: string,
    held: readonly Record<string, unknown>[],
  ): Promise<Harness> {
    harness = await startHarness(label);
    scriptHydration(harness.server, {
      head: "10",
      catalog: () => typeCatalog(held),
    });
    value(await harness.device.status());
    return harness;
  }

  it("replaces a declared app type the instance holds in another definition, and writes none it holds as declared", async () => {
    const { server, device } = await started("declare-replaces", [
      OLDER(ENTRY.id),
      OLDER(SAME.id),
    ]);
    server.answer(
      "POST",
      "/types/normalize",
      normalizing([ENTRY.id, SAME.id], [SAME.id]),
    );
    server.answer("PUT", `/types/${ENTRY.id}`, (request) => ({
      kind: "json",
      status: 200,
      body: { type: JSON.parse(request.body) },
    }));
    value(await device.declareTypes([ENTRY, SAME]));
    const report = value(await device.hydrate(["core.note"], "library"));
    expect(report.replaced_types).toEqual([ENTRY.id]);
    expect(report.unreplaced_types).toEqual([]);
    expect(report.registered_types).toEqual([]);
    // The type that matched was asked about and not written; the one that
    // differed was written, so the absence is of a write that was possible.
    expect(
      server.requests
        .filter((request) => request.pathname === "/types/normalize")
        .map((request) => (JSON.parse(request.body) as { id: string }).id)
        .sort(),
    ).toEqual([ENTRY.id, SAME.id]);
    expect(replaced(harness!)).toEqual([`/types/${ENTRY.id}`]);
    const sent = JSON.parse(
      server.requests.find((request) => request.method === "PUT")!.body,
    ) as { fields: Record<string, unknown> };
    expect(Object.keys(sent.fields).sort()).toEqual(["mood", "title"]);
  });

  it("keeps the server's definition of a type it refuses to replace, says why, and finishes the hydration", async () => {
    const { server, device } = await started("declare-replace-refused", [
      OLDER("app.note.denied"),
      OLDER("app.note.invalid"),
      OLDER("app.note.fine"),
    ]);
    const ids = ["app.note.denied", "app.note.invalid", "app.note.fine"];
    server.answer("POST", "/types/normalize", normalizing(ids, []));
    server.answer(
      "PUT",
      "/types/app.note.denied",
      refusal(403, "type_not_permitted", "your type map lacks write on it"),
    );
    server.answer(
      "PUT",
      "/types/app.note.invalid",
      refusal(400, "invalid_schema", "the schema is invalid"),
    );
    server.answer("PUT", "/types/app.note.fine", (request) => ({
      kind: "json",
      status: 200,
      body: { type: JSON.parse(request.body) },
    }));
    value(
      await device.declareTypes(
        ids.map((id) => ({
          id,
          fields: { title: { type: "string" }, extra: { type: "number" } },
        })),
      ),
    );
    const report = value(await device.hydrate(["core.note"], "library"));
    expect(report.unreplaced_types).toEqual([
      {
        id: "app.note.denied",
        code: "type_not_permitted",
        message: "your type map lacks write on it",
      },
      {
        id: "app.note.invalid",
        code: "invalid_schema",
        message: "the schema is invalid",
      },
    ]);
    expect(report.replaced_types).toEqual(["app.note.fine"]);
    expect(value(await device.status()).hydration).toBe("complete");
    expect(report.cursor).not.toBe("");
  });

  it("refuses to declare a type outside the app's own namespace or one of Marfa's, and replaces the app's own", async () => {
    const { server, device } = await started("declare-replace-own", [
      OLDER(ENTRY.id),
      OLDER(SHARED.id),
    ]);
    server.answer(
      "POST",
      "/types/normalize",
      normalizing([ENTRY.id, SHARED.id], []),
    );
    server.answer("PUT", /^\/types\//, (request) => ({
      kind: "json",
      status: 200,
      body: { type: JSON.parse(request.body) },
    }));
    const mistaken = await device.declareTypes([
      { id: "core.note", fields: { extra: { type: "string" } } },
    ]);
    expect(mistaken.ok ? "declared" : mistaken.refusal.code).toBe("invalid");
    const shared = await device.declareTypes([ENTRY, SHARED]);
    expect(shared.ok ? "declared" : shared.refusal.code).toBe("invalid");
    value(await device.declareTypes([ENTRY]));
    const report = value(await device.hydrate(["core.note"], "library"));
    // The witness: the app's own type was replaced under the same conditions.
    expect(report.replaced_types).toEqual([ENTRY.id]);
    expect(replaced(harness!)).toEqual([`/types/${ENTRY.id}`]);
    expect(
      server.requests.some((request) => request.body.includes(SHARED.id)),
      "a type outside `app.*` was compared or written",
    ).toBe(false);
  });

  it("registers and replaces no type outside app.* that an earlier build stored as declared, says it refused it, and keeps what the copy queued", async () => {
    const { server, device } = await started("declare-stored-outside-app", [
      OLDER(ENTRY.id),
      OLDER(SHARED.id),
    ]);
    const owners = {
      id: "user.note_owned",
      fields: { title: { type: "string" } },
    };
    server.answer(
      "POST",
      "/types/normalize",
      normalizing([ENTRY.id, SHARED.id], []),
    );
    server.answer("PUT", /^\/types\//, (request) => ({
      kind: "json",
      status: 200,
      body: { type: JSON.parse(request.body) },
    }));
    server.answer("POST", "/types", (request) => ({
      kind: "json",
      status: 201,
      body: { type: JSON.parse(request.body) },
    }));
    server.answer(
      "GET",
      /^\/items\//,
      refusal(404, "not_found", "no such item"),
    );
    value(await device.hydrate(["core.note"], "library"));
    const queued = value(
      await device.create({
        type: "core.note",
        properties: { title: "Queued before the upgrade", body: "kept" },
      }),
    );
    value(await device.declareTypes([ENTRY]));
    // What a build that let an app declare `user.*` left in the store.
    const store = new DatabaseSync(device.store);
    try {
      const insert = store.prepare(
        "INSERT INTO declared_types (id, json) VALUES (?, ?)",
      );
      for (const stored of [SHARED, owners]) {
        insert.run(stored.id, JSON.stringify(stored));
      }
    } finally {
      store.close();
    }
    const report = value(await device.hydrate(["core.note"], "library"));
    expect(report.replaced_types).toEqual([ENTRY.id]);
    expect(report.registered_types).toEqual([]);
    expect(
      report.unregistered_types.map((refused) => [refused.id, refused.code]),
    ).toEqual([
      [owners.id, "invalid"],
      [SHARED.id, "invalid"],
    ]);
    expect(
      server.requests.filter(
        (request) =>
          request.method !== "GET" &&
          (request.body.includes(SHARED.id) ||
            request.body.includes(owners.id)),
      ),
      "a type outside `app.*` was compared, registered or written",
    ).toEqual([]);
    expect(replaced(harness!)).toEqual([`/types/${ENTRY.id}`]);
    expect(value(await device.queue()).map((row) => row.id)).toEqual([
      queued.id,
    ]);
  });

  it("registers and replaces no declaration naming provenance that an earlier build stored, says it refused it each time, and still registers one without the key", async () => {
    const { server, device } = await started("declare-stored-provenance", []);
    const control = { id: "app.note.control", fields: {} };
    const named = {
      id: "app.note.named",
      fields: {},
      provenance: { origin: "plugin", plugin: { name: "tickets", version: "1" } },
    };
    server.answer("POST", "/types", (request) => {
      const sent = JSON.parse(request.body) as Record<string, unknown>;
      return "provenance" in sent
        ? refusal(400, "invalid_request", "an unread key \"provenance\"")
        : { kind: "json", status: 201, body: { type: sent } };
    });
    value(await device.declareTypes([control]));
    // What a build that took the declaration as it was written left in the store.
    const store = new DatabaseSync(device.store);
    try {
      store
        .prepare("INSERT INTO declared_types (id, json) VALUES (?, ?)")
        .run(named.id, JSON.stringify(named));
    } finally {
      store.close();
    }
    const first = value(await device.hydrate(["core.note"], "library"));
    expect(first.registered_types).toEqual([control.id]);
    expect(
      first.unregistered_types.map((refused) => [refused.id, refused.code]),
    ).toEqual([[named.id, "invalid"]]);
    expect(first.unregistered_types[0]?.message).toContain("provenance");
    // The witness: the same declaration without the key is sent and refused
    // by nothing, so the absence below is of a request that was possible.
    expect(
      server.requests.filter(
        (request) => request.method === "POST" && request.pathname === "/types",
      ),
    ).toHaveLength(1);
    const second = value(await device.hydrate(["core.note"], "library"));
    expect(
      second.unregistered_types.map((refused) => [refused.id, refused.code]),
    ).toEqual([[named.id, "invalid"]]);
    expect(
      server.requests.filter((request) =>
        request.body.includes(named.id),
      ),
      "a declaration naming provenance was sent to the server",
    ).toEqual([]);
  });

  it("fails the hydration when the server fails mid-way, and replaces on the next one", async () => {
    const { server, device } = await started("declare-replace-unreachable", [
      OLDER(ENTRY.id),
    ]);
    server.answer(
      "POST",
      "/types/normalize",
      refusal(503, "unavailable", "try later"),
      normalizing([ENTRY.id], []),
    );
    server.answer(
      "PUT",
      `/types/${ENTRY.id}`,
      refusal(503, "unavailable", "try later"),
      (request) => ({
        kind: "json",
        status: 200,
        body: { type: JSON.parse(request.body) },
      }),
    );
    value(await device.declareTypes([ENTRY]));
    const comparing = await device.hydrate(["core.note"], "library");
    expect(
      comparing.ok,
      "a server failing a comparison was reported as a type it would not replace",
    ).toBe(false);
    if (!comparing.ok) expect(comparing.refusal.code).toBe("server");
    const writing = await device.hydrate(["core.note"], "library");
    expect(
      writing.ok,
      "a server failing a replacement was reported as a type it would not replace",
    ).toBe(false);
    if (!writing.ok) expect(writing.refusal.code).toBe("server");
    expect(value(await device.status()).hydration).toBe("never");
    const report = value(await device.hydrate(["core.note"], "library"));
    expect(report.replaced_types).toEqual([ENTRY.id]);
    expect(report.unreplaced_types).toEqual([]);
  });
});
