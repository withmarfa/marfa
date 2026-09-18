/**
 * The doors that write an item's `state` agree on which states a type's
 * lifecycle contains.
 *
 * **This is the axis `item-write-doors.test.ts` excludes by name.** That file
 * pins agreement on the properties axis and says in its own header that the
 * lifecycle axis is a different question needing a different fix. This is that
 * fix, and it exists because the two create doors disagreed: `POST /items`
 * validated a declared state against the type's own graph and `POST /items/bulk`
 * checked membership of the universal list and passed the value straight to the
 * store.
 *
 * The consequence was narrow and sharp. `trashed` is a valid state and is not
 * in the `system.*` lifecycle at all, so the operator key could create a
 * `system.connection` directly in `trashed` — a state no transition can produce
 * and none can leave — through the bulk door while the single door beside it
 * refused.
 *
 * **Two credential shapes, deliberately.** The doors are reachable by an
 * ordinary space credential for the types its maps admit, and by an
 * integration runtime credential for `system.activity`, through the carve-out
 * in `checkTypeAccess`. A suite written entirely with one shape pins the check
 * for that shape and is blind to the other, which is how a guard goes missing
 * on a door somebody believed was covered.
 *
 * **The refusals name a `system.*` type and the admission does not.** The
 * lifecycle gate sits ahead of the reserved-namespace fence, so a declared
 * state is judged before the door asks whether the caller may write that type
 * at all — which is what keeps `system.connection` usable here for the narrow
 * lifecycle. Showing the gate admits rather than refuses everything needs a
 * type a credential can actually write, because nothing writes a reserved one.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({});
});

afterAll(async () => {
  await ctx.cleanup();
});

/**
 * `${METHOD} ${path}` exactly as Hono registers it, so the coverage check at
 * the bottom keys on the same string the router does.
 */
interface StateDoor {
  name: string;
  route: string;
  /** Create `item` through this door, and answer the status. */
  create: (key: string, item: Record<string, unknown>) => Promise<number>;
}

const DOORS: StateDoor[] = [
  {
    name: "POST /items — create declaring a state",
    route: "POST /items",
    create: async (key, item) =>
      (await request(ctx.app, "POST", "/items", { key, body: item })).status,
  },
  {
    name: "POST /items/bulk — create declaring a state",
    route: "POST /items/bulk",
    create: async (key, item) =>
      (
        await request(ctx.app, "POST", "/items/bulk", {
          key,
          body: { items: [item] },
        })
      ).status,
  },
];

/** A `system.connection` declaring `state` — the narrow lifecycle. */
function connection(state: string): Record<string, unknown> {
  return {
    type: "system.connection",
    state,
    properties: {
      kind: "app",
      status: "active",
      granted_at: new Date().toISOString(),
    },
  };
}

describe.each(DOORS)("$name", (door) => {
  it("refuses a state the type's lifecycle does not contain", async () => {
    // `system.*` admits `active | revoked`. `trashed` is a real state and is
    // not in that graph, so nothing can produce it and nothing can leave it.
    expect(await door.create(ctx.spaceKey, connection("trashed"))).toBe(400);
  });

  it("refuses `archived` on the same grounds, so the rule is the graph and not one word", async () => {
    expect(await door.create(ctx.spaceKey, connection("archived"))).toBe(400);
  });

  it("still admits a state the lifecycle does contain", async () => {
    // The check has to refuse the right things rather than everything: a
    // guard that refused every declared state would pass both cases above
    // while breaking the door.
    //
    // Asserted as "succeeded" rather than as one status, because the two
    // doors legitimately differ — the single create answers 201 and the bulk
    // endpoint answers 200 for a batch it accepted. Pinning either number
    // here would be asserting the other door's contract by accident.
    //
    // An ordinary type, and a state that is not the default. `active` is the
    // start state and the gate skips it, so a case built on it measures
    // nothing; `archived` is in this type's graph and not in `system.*`'s,
    // which is the pair the refusals above turn on.
    expect(
      await door.create(ctx.spaceKey, {
        type: "core.note",
        state: "archived",
        properties: { body: "state-door fixture" },
      }),
    ).toBeLessThan(300);
  });
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * Routes that reach an item's state without being a create door, each with the
 * reason. Stated rather than omitted: the check below fails on anything in
 * neither table, which is how a new door earns a row instead of being found by
 * the next reviewer.
 */
const NOT_A_STATE_CREATE_DOOR: Record<string, string> = {
  "POST /items/:id/transition":
    "moves an existing row; `storage.items.transition` validates the graph in both dialect stores",
  "POST /items/:id/restore":
    "a transition by another name; gated in the store beside `transition`",
  "POST /items/bulk-actions":
    "its transition action runs through `storage.items.transition`, so the graph is enforced per row in the store",
  "POST /items/bulk-get": "read-only batch fetch",
  "POST /items/:id/tags": "metadata layer, reaches no state",
  "PUT /items/:id/metadata": "metadata layer, reaches no state",
  "PATCH /items/:id/metadata": "metadata layer, reaches no state",
  "PUT /items/:id/extensions/:namespace": "extension layer, reaches no state",
  "PATCH /items/:id": "writes properties; `state` is not on its input schema",
  "POST /items/:id/promote":
    "creates a fresh item from a mirror; the create it performs runs the create-door gates above",
};

describe("every route that can set an item's state on create is accounted for", () => {
  it("has a door row or a stated reason it is not one", () => {
    const registered = new Set(
      ctx.app.routes.map((r) => `${r.method} ${r.path}`),
    );
    const covered = new Set(DOORS.map((d) => d.route));

    const unclassified: string[] = [];
    const considered = new Set<string>();
    for (const route of registered) {
      const [method, path] = route.split(" ");
      if (!path?.startsWith("/items")) continue;
      if (!["POST", "PUT", "PATCH"].includes(method ?? "")) continue;
      considered.add(route);
      if (covered.has(route)) continue;
      if (route in NOT_A_STATE_CREATE_DOOR) continue;
      unclassified.push(route);
    }

    // The control, and the boundary this filter draws.
    //
    // A prefix walk that matched nothing would pass both assertions above
    // having measured nothing — the shape a renamed mount or a moved route
    // produces. So assert it found the doors it is looking for.
    expect(registered.size).toBeGreaterThan(50);
    expect(considered.size).toBeGreaterThan(3);
    expect(considered.has("POST /items")).toBe(true);

    // **And what it cannot see, stated rather than implied.** The scope is a
    // URL prefix, so it covers routes mounted under `/items` and nothing
    // else. Twenty-eight files call an item write; two of them are route
    // files under `/items`. The rest reach the store from `/credentials`,
    // `/auth`, `/admin` and `/connections`, and from the connections
    // pipeline, which serves no route at all.
    //
    // `idempotent-write-doors.test.ts` derives its scope from the tree
    // instead, and its header argues against exactly this walk. Bringing
    // this one onto that mechanism is unstarted follow-up work: the walk
    // is already generic, and the work is the twenty-three writers it makes
    // visible, each needing a row or a stated reason. Sized rather than
    // started, so this control is not mistaken for the fix.

    // A new route that can write items lands here. Give it a row in `DOORS`
    // if it accepts a state on create, or an entry above saying why it does
    // not — deciding which is the whole point.
    expect(unclassified).toEqual([]);

    // The other direction: an entry left behind after its route was renamed
    // stops excluding anything, silently, and the next route to take that
    // name inherits the excuse.
    for (const route of Object.keys(NOT_A_STATE_CREATE_DOOR)) {
      expect(registered.has(route), `stale exclusion: ${route}`).toBe(true);
    }
    for (const route of covered) {
      expect(registered.has(route), `stale door: ${route}`).toBe(true);
    }
  });
});
