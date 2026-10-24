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

  it("replaces no type outside the app's own namespace, and refuses to declare one of Marfa's", async () => {
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
    value(await device.declareTypes([ENTRY, SHARED]));
    const report = value(await device.hydrate(["core.note"], "library"));
    // The witness: the app's own type was replaced under the same conditions.
    expect(report.replaced_types).toEqual([ENTRY.id]);
    expect(replaced(harness!)).toEqual([`/types/${ENTRY.id}`]);
    expect(
      server.requests.some((request) => request.body.includes(SHARED.id)),
      "a type outside `app.*` was compared or written",
    ).toBe(false);
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
