import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Teardown has to be able to fail the run: a warning inside a green run is a
 * thing nobody reads. These cases pin the two properties that matter and are
 * easy to regress: a failure ends the run, and every phase still gets its
 * turn first.
 */

interface Result {
  ok: boolean;
  status: number;
}

const okResult: Result = { ok: true, status: 200 };
const refusedResult: Result = { ok: false, status: 403 };

const goneResult: Result = { ok: false, status: 404 };

let calls: string[] = [];
let typeDeleteResult: Result = okResult;
let typeDeleteById = new Map<string, Result>();
let itemDeleteResult: Result = okResult;
let itemPurgeResult: Result = okResult;
let webhookDeleteResult: Result = okResult;
/** Answers consumed in order, per id, ahead of the blanket results above. */
let itemDeleteById = new Map<string, Result[]>();
let itemPurgeById = new Map<string, Result[]>();

function nextResult(
  queued: Map<string, Result[]>,
  id: string,
  fallback: Result,
): Result {
  return queued.get(id)?.shift() ?? fallback;
}

const provisioningStub = {
  deleteEdgeType: (id: string) => {
    calls.push(`edge-type:${id}`);
    return Promise.resolve(okResult);
  },
  deleteType: async (id: string) => {
    calls.push(`type:${id}`);
    // Resolves on a later turn, so a phase that issues two deletes together
    // is distinguishable from one that awaits the first. Without the gap
    // both orderings record identically and the assertion below passes on
    // an implementation that only sorts.
    await new Promise((resolve) => setTimeout(resolve, 0));
    calls.push(`type-done:${id}`);
    return typeDeleteById.get(id) ?? typeDeleteResult;
  },
  revokeKey: (id: string) => {
    calls.push(`key:${id}`);
    return Promise.resolve(okResult);
  },
  deleteWebhook: (id: string) => {
    calls.push(`provisioning-webhook:${id}`);
    return Promise.resolve(webhookDeleteResult);
  },
};

const scopedStub = {
  deleteEdge: (id: string) => {
    calls.push(`edge:${id}`);
    return Promise.resolve(okResult);
  },
  deleteType: async (id: string) => {
    calls.push(`scoped-type:${id}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    calls.push(`scoped-type-done:${id}`);
    // Honors the blanket result as well as the per-id one, because this is
    // the phase's default credential: a case setting `typeDeleteResult` to a
    // refusal is describing the type phase, and a stub reading only the
    // per-id map would make that case unreachable while still looking set.
    return typeDeleteById.get(id) ?? typeDeleteResult;
  },
  deleteItem: (id: string) => {
    calls.push(`item-delete:${id}`);
    return Promise.resolve(nextResult(itemDeleteById, id, itemDeleteResult));
  },
  revokeFolder: (id: string) => {
    calls.push(`folder-revoke:${id}`);
    return Promise.resolve(okResult);
  },
  purgeItem: (id: string) => {
    calls.push(`item-purge:${id}`);
    return Promise.resolve(nextResult(itemPurgeById, id, itemPurgeResult));
  },
  deleteWebhook: (id: string) => {
    calls.push(`webhook:${id}`);
    return Promise.resolve(webhookDeleteResult);
  },
  // Schema removal is gated on `schema.write`, which the file's own key holds
  // and the provisioning client is not assumed to.
  deleteEdgeType: (id: string) => {
    calls.push(`scoped-edge-type:${id}`);
    return Promise.resolve(okResult);
  },
};

function contextWithFixtures(): unknown {
  return {
    client: scopedStub,
    trackedEdges: ["e1"],
    trackedItems: ["i1"],
    trackedEdgeTypes: ["et1"],
    trackedFolders: ["f1"],
    trackedWebhooks: [{ id: "w1" }],
    trackedTypes: [{ id: "t1" }],
    trackedKeys: ["k1"],
    provisioningClient: provisioningStub,
  };
}

beforeEach(() => {
  calls = [];
  typeDeleteResult = okResult;
  typeDeleteById = new Map();
  itemDeleteResult = okResult;
  itemPurgeResult = okResult;
  webhookDeleteResult = okResult;
  itemDeleteById = new Map();
  itemPurgeById = new Map();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cleanup", () => {
  it("resolves when every phase deletes cleanly", async () => {
    const { cleanup } = await import("./setup.js");
    await expect(
      cleanup(contextWithFixtures() as Parameters<typeof cleanup>[0]),
    ).resolves.toBeUndefined();
  });

  it("rejects when a phase could not delete, naming the phase and the count", async () => {
    typeDeleteResult = refusedResult;
    const { cleanup } = await import("./setup.js");
    await expect(
      cleanup(contextWithFixtures() as Parameters<typeof cleanup>[0]),
    ).rejects.toThrow(/Cleanup left fixtures on the target.*Type 1\/1/s);
  });

  it("still runs every later phase when an earlier one fails", async () => {
    typeDeleteResult = refusedResult;
    const { cleanup } = await import("./setup.js");
    await cleanup(contextWithFixtures() as Parameters<typeof cleanup>[0]).catch(
      () => undefined,
    );

    // Keys are revoked last on purpose, because the suite is still cleaning
    // up with that credential. Failing fast on the Type phase would skip
    // that revoke and leak more than it reported.
    expect(calls).toContain("key:k1");
    expect(calls.indexOf("scoped-type:t1")).toBeLessThan(
      calls.indexOf("key:k1"),
    );
  });

  it("revokes a tracked folder before purging it", async () => {
    const { cleanup } = await import("./setup.js");
    await cleanup(contextWithFixtures() as Parameters<typeof cleanup>[0]);
    expect(calls.indexOf("folder-revoke:f1")).toBeGreaterThan(-1);
    expect(calls.indexOf("folder-revoke:f1")).toBeLessThan(
      calls.indexOf("item-purge:f1"),
    );
  });

  it("fails the run when an item could not be purged", async () => {
    itemPurgeResult = refusedResult;
    const { cleanup } = await import("./setup.js");

    await expect(
      cleanup(contextWithFixtures() as Parameters<typeof cleanup>[0]),
    ).rejects.toThrow(/Cleanup left fixtures on the target.*Item 1\/1/s);

    // The purge is where a soft-deleted fixture actually leaves the target,
    // and the phase has to have reached it for the refusal above to mean
    // anything.
    expect(calls).toContain("item-purge:i1");
  });

  it("reports a refused soft delete rather than the 404 behind it", async () => {
    // The realistic pairing, and the one that hides a leak: the delete is
    // refused, the row stays live, and the purge that follows answers 404 —
    // the status this phase treats as already-gone. Reporting the last
    // response instead of the first refusal would call this a clean teardown.
    itemDeleteResult = refusedResult;
    itemPurgeResult = goneResult;
    const { cleanup } = await import("./setup.js");

    await expect(
      cleanup(contextWithFixtures() as Parameters<typeof cleanup>[0]),
    ).rejects.toThrow(/Cleanup left fixtures on the target.*Item 1\/1/s);
  });

  it("reports a refused purge behind an already-gone soft delete", async () => {
    // The pairing that separates a correct phase from a plausible wrong one.
    // A 404 on the delete is already-gone, which this phase counts as
    // success, so it must not shadow the purge's answer: returning the 404 and
    // discarding the purge unread is the same swallow one step along, and it
    // leaves a live row while the run stays green.
    itemDeleteResult = goneResult;
    itemPurgeResult = refusedResult;
    const { cleanup } = await import("./setup.js");

    await expect(
      cleanup(contextWithFixtures() as Parameters<typeof cleanup>[0]),
    ).rejects.toThrow(/Cleanup left fixtures on the target.*Item 1\/1/s);
  });

  it("treats an already-gone item as done rather than as a leak", async () => {
    // Tests legitimately remove their own fixtures mid-run. Counting the
    // second delete as a failure turns every such file red on teardown while
    // nothing is left on the target.
    itemDeleteResult = goneResult;
    itemPurgeResult = goneResult;
    const { cleanup } = await import("./setup.js");

    await expect(
      cleanup(contextWithFixtures() as Parameters<typeof cleanup>[0]),
    ).resolves.toBeUndefined();
  });

  it("removes a webhook subscription before revoking the credential that made it", async () => {
    const { cleanup } = await import("./setup.js");
    await cleanup(contextWithFixtures() as Parameters<typeof cleanup>[0]);

    // The delete has to go out while the registering credential is still
    // live; revoking first would leave the subscription registered and still
    // delivering.
    expect(calls).toContain("webhook:w1");
    expect(calls.indexOf("webhook:w1")).toBeLessThan(calls.indexOf("key:k1"));
  });

  it("fails the run when a webhook subscription is left behind", async () => {
    webhookDeleteResult = refusedResult;
    const { cleanup } = await import("./setup.js");

    await expect(
      cleanup(contextWithFixtures() as Parameters<typeof cleanup>[0]),
    ).rejects.toThrow(/Cleanup left fixtures on the target.*Webhook 1\/1/s);
  });

  it("deletes a webhook with the credential that registered it", async () => {
    const { cleanup } = await import("./setup.js");
    const ctx = contextWithFixtures() as { trackedWebhooks: unknown[] };
    // A different credential from the phase's default. `DELETE /webhooks/{id}`
    // answers 404 to a credential that cannot see the row, which this phase
    // treats as already gone, so choosing per phase rather than per row would
    // leave the row and report a clean teardown.
    ctx.trackedWebhooks = [{ id: "w1", createdBy: provisioningStub }];

    await cleanup(ctx as Parameters<typeof cleanup>[0]);

    expect(calls).toContain("provisioning-webhook:w1");
    expect(calls).not.toContain("webhook:w1");
  });

  it("deletes a type with the credential that registered it", async () => {
    const { cleanup } = await import("./setup.js");
    const ctx = contextWithFixtures() as { trackedTypes: unknown[] };
    // **The owner is the discriminator, and the default is not.** The phase's
    // default credential is the scoped one, so a type with no recorded owner
    // cannot show that `deleteAllByOwner` reads the owner at all. This row
    // records the other client, which is the only shape where the two answers
    // differ.
    ctx.trackedTypes = [{ id: "t1", createdBy: provisioningStub }];

    await cleanup(ctx as Parameters<typeof cleanup>[0]);

    // A DELETE from a credential that cannot see the type answers 404, the
    // status this phase treats as already gone, so reaching for the wrong one
    // leaves the row and reports a clean teardown.
    expect(calls).toContain("type:t1");
    expect(calls).not.toContain("scoped-type:t1");
  });
});

/**
 * A parent is refused while a child still declares it, and the parent is
 * tracked first.
 *
 * `DELETE /types/{id}` answers 409 `type_has_subtypes`, which teardown does
 * not tolerate and must not start tolerating: an ignored status is how a leak
 * reports green. So the phase has to reach the child first, and the
 * registration order works against it: the parent is registered before the
 * child that declares it, so it is tracked first and an unordered phase
 * issues its delete first every time.
 */
describe("cleanup, type phase ordering", () => {
  function withPair(): {
    trackedTypes: unknown[];
  } {
    const ctx = contextWithFixtures() as { trackedTypes: unknown[] };
    // Tracking order is registration order, which is the order that fails.
    ctx.trackedTypes = [{ id: "parent" }, { id: "child", parent: "parent" }];
    return ctx as { trackedTypes: unknown[] };
  }

  it("does not issue the parent's delete until the child's has come back", async () => {
    const { cleanup } = await import("./setup.js");
    const ctx = withPair();

    await cleanup(ctx as Parameters<typeof cleanup>[0]);

    // Precondition: the phase reached both rows at all. An ordering
    // assertion over two deletes that never happened compares -1 with -1
    // and can be satisfied by a fixture that exercises nothing.
    expect(calls).toContain("scoped-type:child");
    expect(calls).toContain("scoped-type:parent");

    // The property, and the reason it is stated against the child's
    // *completion* rather than the parent's position: sorting the phase
    // puts the child first in the array and changes nothing, because both
    // still go out in one concurrent batch and reach the server in whatever
    // order the network settles. Only a batch boundary between them holds.
    expect(calls.indexOf("type-done:child")).toBeLessThan(
      calls.indexOf("scoped-type:parent"),
    );
  });

  it("orders a grandchild ahead of the child that holds its parent", async () => {
    const { cleanup } = await import("./setup.js");
    const ctx = contextWithFixtures() as { trackedTypes: unknown[] };
    ctx.trackedTypes = [
      { id: "parent" },
      { id: "child", parent: "parent" },
      { id: "grandchild", parent: "child" },
    ];

    await cleanup(ctx as Parameters<typeof cleanup>[0]);

    // A chain, not a pair: deleting the child before the grandchild is
    // refused for exactly the same reason, so one level of ordering is not
    // enough and the depth has to be walked.
    expect(calls.indexOf("type-done:grandchild")).toBeLessThan(
      calls.indexOf("scoped-type:child"),
    );
    expect(calls.indexOf("type-done:child")).toBeLessThan(
      calls.indexOf("scoped-type:parent"),
    );
  });

  it("still issues unrelated types together rather than one at a time", async () => {
    const { cleanup } = await import("./setup.js");
    const ctx = contextWithFixtures() as { trackedTypes: unknown[] };
    ctx.trackedTypes = [{ id: "a" }, { id: "b" }, { id: "c" }];

    await cleanup(ctx as Parameters<typeof cleanup>[0]);

    // The permissive direction, which removing a guard cannot test for.
    // An implementation putting every type in its own level satisfies every
    // ordering case above while serializing the phase, and a serial teardown
    // is what puts a large suite past its hook timeout. Nothing here declares
    // a parent, so all three belong in one batch.
    expect(calls.indexOf("scoped-type:c")).toBeLessThan(
      calls.indexOf("scoped-type-done:a"),
    );
  });

  it("keeps a type whose parent nobody tracked in the first batch", async () => {
    const { cleanup } = await import("./setup.js");
    const ctx = contextWithFixtures() as { trackedTypes: unknown[] };
    // `core.note` is a platform type: teardown never deletes it, so nothing
    // is waiting on this row and holding it back only costs a round trip.
    ctx.trackedTypes = [{ id: "a" }, { id: "mine", parent: "core.note" }];

    await cleanup(ctx as Parameters<typeof cleanup>[0]);

    expect(calls.indexOf("scoped-type:mine")).toBeLessThan(
      calls.indexOf("scoped-type-done:a"),
    );
  });

  it("reports the phase's own count rather than one level's", async () => {
    typeDeleteById.set("parent", refusedResult);
    const { cleanup } = await import("./setup.js");
    const ctx = contextWithFixtures() as { trackedTypes: unknown[] };
    ctx.trackedTypes = [
      { id: "parent" },
      { id: "child", parent: "parent" },
      { id: "other" },
    ];

    // Three rows tracked, one refused. Reporting per level would say
    // `Type 1/1` and describe a phase that deleted nothing else.
    await expect(cleanup(ctx as Parameters<typeof cleanup>[0])).rejects.toThrow(
      /Type 1\/3/s,
    );
  });
});

/**
 * The teardown order is only as good as the parent it recorded, and the
 * record comes from the wrapper rather than from a read-back at teardown.
 */
describe("type tracking records the declared parent", () => {
  function clientStub(): Record<string, unknown> {
    return {
      registerType: (schema: { id: string }) =>
        Promise.resolve({ ok: true, status: 201, data: { type: schema } }),
      replaceType: (_id: string, _schema: object) =>
        Promise.resolve({ ok: true, status: 200, data: {} }),
    };
  }

  it("records what the registration declared, not what the name suggests", async () => {
    const { trackRegisteredTypes } = await import("./setup.js");
    const ctx = { trackedTypes: [] as { id: string; parent?: string }[] };
    const client = clientStub();
    trackRegisteredTypes(
      ctx as Parameters<typeof trackRegisteredTypes>[0],
      client as unknown as Parameters<typeof trackRegisteredTypes>[1],
    );

    const register = client.registerType as (s: unknown) => Promise<unknown>;
    await register({ id: "user.a" });
    // Dotted under its namesake but declaring nothing. The server's refusal
    // reads the declared parent, so this one does not hold `user.a` back and
    // must not be ordered as though it did.
    await register({ id: "user.a.child" });
    await register({ id: "user.b", parent: "user.a" });

    expect(ctx.trackedTypes).toEqual([
      { id: "user.a", createdBy: client, parent: undefined },
      { id: "user.a.child", createdBy: client, parent: undefined },
      { id: "user.b", createdBy: client, parent: "user.a" },
    ]);
  });

  it("does not record anything for a registration the server refused", async () => {
    const { trackRegisteredTypes } = await import("./setup.js");
    const ctx = { trackedTypes: [] as { id: string }[] };
    const client = clientStub();
    client.registerType = () =>
      Promise.resolve({ ok: false, status: 400, data: undefined });
    trackRegisteredTypes(
      ctx as Parameters<typeof trackRegisteredTypes>[0],
      client as unknown as Parameters<typeof trackRegisteredTypes>[1],
    );

    // A refused registration created nothing. This is why the inheritance
    // suite has one real parent/child pair rather than three: the child that
    // declares a colliding field is rejected and never exists.
    await (client.registerType as (s: unknown) => Promise<unknown>)({
      id: "user.c",
      parent: "user.a",
    });
    expect(ctx.trackedTypes).toEqual([]);
  });

  it("follows a type moved under a different parent", async () => {
    const { trackRegisteredTypes } = await import("./setup.js");
    const ctx = { trackedTypes: [] as { id: string; parent?: string }[] };
    const client = clientStub();
    trackRegisteredTypes(
      ctx as Parameters<typeof trackRegisteredTypes>[0],
      client as unknown as Parameters<typeof trackRegisteredTypes>[1],
    );

    await (client.registerType as (s: unknown) => Promise<unknown>)({
      id: "user.b",
      parent: "user.a",
    });
    await (client.replaceType as (i: string, s: object) => Promise<unknown>)(
      "user.b",
      { parent: "user.z" },
    );

    // The record has to follow, or the phase orders against a parent the
    // server no longer agrees about and is refused for it.
    expect(ctx.trackedTypes[0]?.parent).toBe("user.z");
  });

  it("leaves the recorded parent alone when the update does not mention one", async () => {
    const { trackRegisteredTypes } = await import("./setup.js");
    const ctx = { trackedTypes: [] as { id: string; parent?: string }[] };
    const client = clientStub();
    trackRegisteredTypes(
      ctx as Parameters<typeof trackRegisteredTypes>[0],
      client as unknown as Parameters<typeof trackRegisteredTypes>[1],
    );

    await (client.registerType as (s: unknown) => Promise<unknown>)({
      id: "user.b",
      parent: "user.a",
    });
    // A field-only edit, which is what every update in the suite is.
    // Reading the absent key as "no parent" would order this type alongside
    // its own parent and race the pair the ordering exists to separate.
    await (client.replaceType as (i: string, s: object) => Promise<unknown>)(
      "user.b",
      { fields: { url: { type: "string" } } },
    );

    expect(ctx.trackedTypes[0]?.parent).toBe("user.a");
  });
});

describe("typeDeletionLevels", () => {
  it("puts a declared child in a later group than its parent's", async () => {
    const { typeDeletionLevels } = await import("./setup.js");
    const levels = typeDeletionLevels([
      { id: "parent" },
      { id: "child", parent: "parent" },
    ]);
    expect(levels.map((l) => l.map((t) => t.id))).toEqual([
      ["child"],
      ["parent"],
    ]);
  });

  it("groups by depth rather than one type per group", async () => {
    const { typeDeletionLevels } = await import("./setup.js");
    const levels = typeDeletionLevels([
      { id: "p1" },
      { id: "p2" },
      { id: "c1", parent: "p1" },
      { id: "c2", parent: "p2" },
    ]);
    expect(levels.map((l) => l.map((t) => t.id).sort())).toEqual([
      ["c1", "c2"],
      ["p1", "p2"],
    ]);
  });

  it("ignores a parent this teardown is not deleting", async () => {
    const { typeDeletionLevels } = await import("./setup.js");
    // Depth counts what holds the delete. A platform parent is not being
    // deleted, so nothing is waiting on this row.
    const levels = typeDeletionLevels([
      { id: "a" },
      { id: "b", parent: "core.note" },
    ]);
    expect(levels).toHaveLength(1);
  });

  it("terminates on a cycle instead of hanging the teardown", async () => {
    const { typeDeletionLevels } = await import("./setup.js");
    // The server refuses a cycle at registration, so this cannot arrive
    // through a checked door. It runs in teardown, where a hang costs the
    // run its whole report rather than one assertion.
    const levels = typeDeletionLevels([
      { id: "x", parent: "y" },
      { id: "y", parent: "x" },
    ]);
    expect(
      levels
        .flat()
        .map((t) => t.id)
        .sort(),
    ).toEqual(["x", "y"]);
  });
});
