/**
 * Conformance for the five-tier namespace grammar.
 *
 * The grammar:
 *   core.<segment>            — exactly two segments
 *   system.<segment>          — exactly two segments
 *   app.<app-name>.<type>     — exactly three segments
 *   user.<segment>            — exactly two segments
 *   <publisher>.<type>        — exactly two segments where first is a
 *                                non-reserved-root handle
 *
 * Reserved roots (`core`, `system`, `app`, `user`, `marfa`) cannot be
 * claimed as publisher handles. `core.*` / `system.*` / `marfa.*` types ship
 * with the server's type package and cannot be registered over HTTP at all:
 * the refusal is unconditional, which keeps registration and archive restore
 * in agreement about what the dataset may contain.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackKey, cleanup } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "namespace",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function narrowClient(label: string): Promise<MarfaClient> {
  // `metadata.types:write` as well as content reach: the metadata gate runs
  // first on the registration door, and a key without it never reaches the
  // reserved-namespace check this file is about.
  const resp = await client.createKey({
    label,
    source: `${ctx.source}-${label}`,
    type_permissions: { "*": "write" },
    metadata_permissions: { "*": "write" },
  });
  expect(resp.ok).toBe(true);
  trackKey(ctx, resp.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: resp.data.key });
}

describe("namespace grammar", () => {
  it("accepts user.<type>", async () => {
    const r = await client.createItem({
      type: "user.namespace-accept-user",
      properties: {},
    });
    // Named gate. The two create-time gates run in order — grammar, then
    // registration — and this file does not pre-register `user.*` schemas, so
    // stopping at the registration gate is what proves the grammar accepted
    // the namespace.
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("unknown_type");
  });

  it("rejects app.<X> with only one segment after app.", async () => {
    const r = await client.createItem({
      type: "app.foo",
      properties: {},
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("validation_error");
    // The field is the witness. `validation_error` is the code every other
    // shape failure on this door answers with, so the code alone would still
    // pass if the grammar gate went and the body were refused elsewhere.
    const errors = r.error?.error.details?.errors as
      { path: string }[] | undefined;
    expect(errors?.[0]?.path).toBe("type");
  });

  /**
   * The roots the grammar refuses outright, which the tiered roots above do
   * not cover and nothing else in this suite reached.
   *
   * They name permission families rather than namespaces. A type under one
   * could be written and never granted: `keys.thing:read` is not a type
   * scope, it is the key family's own literal, so the grammar refuses the
   * identifier rather than leaving a row nobody can be given access to.
   * `space` is here for a different reason and behaves the same.
   */
  const REFUSED_ROOTS = [
    "schema",
    "keys",
    "items",
    "webhooks",
    "config",
    "audit",
    "grants",
    "content",
    "metadata",
    "edge",
    "profile",
    "space",
  ];

  it("refuses a two-segment type under every root the grammar reserves", async () => {
    for (const root of REFUSED_ROOTS) {
      const r = await client.createItem({
        type: `${root}.namespace-refused`,
        properties: {},
      });
      expect(r.status, root).toBe(400);
      // `validation_error`, not `unknown_type`. The difference is the whole
      // point: an unregistered publisher type answers `unknown_type` and
      // could be registered, and these never can.
      expect(r.error?.error.code, root).toBe("validation_error");
      const errors = r.error?.error.details?.errors as
        { path: string }[] | undefined;
      expect(errors?.[0]?.path, root).toBe("type");
    }
  });

  it("still answers unknown_type for a publisher root that merely looks reserved", async () => {
    // The control for the case above. The refusal is on the root segment
    // and not on a prefix, so a root that begins with a refused one is an
    // ordinary publisher namespace and reaches the registration gate.
    const r = await client.createItem({
      type: "keys-pub.namespace-accept",
      properties: {},
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("unknown_type");
  });

  it("rejects forward-slash type identifiers", async () => {
    const r = await client.createItem({
      type: "acme/deal",
      properties: {},
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("validation_error");
    const errors = r.error?.error.details?.errors as
      { path: string }[] | undefined;
    expect(errors?.[0]?.path).toBe("type");
  });

  // A reserved namespace is a property of the build, not of the request:
  // `core.*`, `system.*` and `marfa.*` ship with the type package, and no
  // credential registers one over HTTP. Asserting it with the broadest
  // credential the suite holds is the assertion with teeth. A narrower caller
  // is refused by the ordinary permission check as well, so a rejection there
  // would not distinguish "reserved namespaces are closed" from "this key
  // lacks rights", and the rule could regress to credential-gated unnoticed.
  it.each(["core", "system", "marfa"] as const)(
    "refuses %s.* registration from the broadest credential the suite holds",
    async (tier) => {
      const r = await client.registerType({
        id: `${tier}.reserved-registration-probe-${ctx.runId}`,
        label: "Reserved namespace attempt",
        version: 1,
        fields: { body: { type: "string", required: true } },
      });

      expect(r.ok).toBe(false);
      expect(r.status).toBe(403);
      expect(r.error?.error.code).toBe("forbidden");
      expect(r.error?.error.details?.namespace).toBe(tier);
    },
  );

  it("refuses a reserved-namespace registration from a narrower credential too", async () => {
    const np = await narrowClient("np-core");
    const r = await np.registerType({
      id: `core.reserved-registration-probe-np-${ctx.runId}`,
      label: "Narrow attempt",
      version: 1,
      fields: { body: { type: "string", required: true } },
    });
    expect(r.status).toBe(403);
    expect(r.error?.error.code).toBe("forbidden");
    expect(r.error?.error.details?.namespace).toBe("core");
  });
});
