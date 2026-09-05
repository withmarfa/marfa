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
 * in the `system.*` lifecycle at all, so a platform credential could create a
 * `system.connection` directly in `trashed` — a state no transition can produce
 * and none can leave — through the bulk door while the single door beside it
 * refused.
 *
 * **Two credential shapes, deliberately.** The bulk door is reachable by a
 * platform credential for any `system.*` type, and by an integration runtime
 * credential for `system.activity` alone, through the carve-out in
 * `checkTypeAccess`. A suite written entirely with one shape pins the check for
 * that shape and is blind to the other, which is how a guard goes missing on a
 * door somebody believed was covered.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { IntegrationManifest } from "@withmarfa/shared";
import { mintLocalRuntimeCredential } from "../integrations/local-runtime/credentials.js";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
let runtimeKey: string;
let runtimeConnectionId: string;

beforeAll(async () => {
  ctx = await createTestContext({ authMode: "hosted" });
  const space = await ctx.storage.spaces!.create("state-doors");
  const manifest: IntegrationManifest = {
    name: "acme-state-doors",
    version: "1.0.0",
    publisher: "acme",
    description: "State-door agreement fixture",
    direction: "read",
    triggers: [{ type: "manual" }],
    target_types: ["core.note"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "state-trashed",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "2.0.0",
    permissions: {},
  };
  const integration = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: manifest.name,
        manifest_version: manifest.version,
        publisher: manifest.publisher,
        manifest,
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  const connection = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
        integration_ref: integration.id,
      },
    },
    space.id,
  );
  const cred = await mintLocalRuntimeCredential(
    ctx.storage,
    TEST_API_KEY_SALT,
    connection.id,
    "hosted",
  );
  runtimeKey = cred.api_key;
  runtimeConnectionId = connection.id;
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
  /** Create a `system.connection` declaring `state`, and answer the status. */
  create: (key: string, state: string) => Promise<number>;
}

const DOORS: StateDoor[] = [
  {
    name: "POST /items — create declaring a state",
    route: "POST /items",
    create: async (key, state) =>
      (
        await request(ctx.app, "POST", "/items", {
          key,
          body: {
            type: "system.connection",
            state,
            properties: {
              kind: "app",
              status: "active",
              granted_at: new Date().toISOString(),
            },
          },
        })
      ).status,
  },
  {
    name: "POST /items/bulk — create declaring a state",
    route: "POST /items/bulk",
    create: async (key, state) =>
      (
        await request(ctx.app, "POST", "/items/bulk", {
          key,
          body: {
            items: [
              {
                type: "system.connection",
                state,
                properties: {
                  kind: "app",
                  status: "active",
                  granted_at: new Date().toISOString(),
                },
              },
            ],
          },
        })
      ).status,
  },
];

describe.each(DOORS)("$name", (door) => {
  it("refuses a state the type's lifecycle does not contain", async () => {
    // `system.*` admits `active | revoked`. `trashed` is a real state and is
    // not in that graph, so nothing can produce it and nothing can leave it.
    expect(await door.create(ctx.adminKey, "trashed")).toBe(400);
  });

  it("refuses `archived` on the same grounds, so the rule is the graph and not one word", async () => {
    expect(await door.create(ctx.adminKey, "archived")).toBe(400);
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
    expect(await door.create(ctx.adminKey, "active")).toBeLessThan(300);
  });
});

describe("the second credential shape reaches the same doors", () => {
  /**
   * An integration runtime credential may write `system.activity` and nothing
   * else in the system family, through the carve-out in `checkTypeAccess`. So
   * it reaches these doors on one type, and a suite that only ever used a
   * platform credential would never exercise that path.
   */
  async function createActivity(
    route: "/items" | "/items/bulk",
    state: string,
  ): Promise<number> {
    const body = {
      type: "system.activity",
      state,
      properties: {
        severity: "info",
        summary: "state-door fixture",
        // `requireActivityAttribution` refuses a runtime credential writing
        // activity for a connection other than its own, and reads the claim
        // off `connection_id`. Omitting it answers 403 before the lifecycle
        // check is ever reached — which is how the two refusals below passed
        // for the wrong reason until the precondition above was added.
        connection_id: runtimeConnectionId,
      },
    };
    const res = await request(ctx.app, "POST", route, {
      key: runtimeKey,
      body: route === "/items" ? body : { items: [body] },
    });
    return res.status;
  }

  it("is built on a write this credential is actually allowed to make", async () => {
    // The precondition, and it is the one that makes the two refusals below
    // mean anything. If the runtime credential cannot write `system.activity`
    // at all, both cases answer 400 for the wrong reason and would keep
    // passing with the lifecycle check deleted.
    expect(await createActivity("/items", "active")).toBeLessThan(300);
    expect(await createActivity("/items/bulk", "active")).toBeLessThan(300);
  });

  it("refuses a lifecycle-invalid state on the single door", async () => {
    expect(await createActivity("/items", "trashed")).toBe(400);
  });

  it("refuses it on the bulk door too, which is the door that was open", async () => {
    expect(await createActivity("/items/bulk", "trashed")).toBe(400);
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
    // this one onto that mechanism is T-1302: the walk is already
    // generic, and the work is the twenty-three writers it makes visible,
    // each needing a row or a stated reason. Sized rather than started, so
    // this control is not mistaken for the fix.

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
