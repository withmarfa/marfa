/**
 * Conformance for what a credential may do with the internal `system.*` type
 * set, which under one permission model is: nothing.
 *
 * Every real `system.*` row is written by the server through the storage
 * layer, so the half that is assertable black-box is the refusal, asserted
 * from a credential holding write on every type.
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
    "system-types",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function narrowClient(label: string): Promise<MarfaClient> {
  const resp = await client.createKey({
    label,
    source: `${ctx.source}-${label}`,
    type_permissions: { "*": "write" },
  });
  expect(resp.ok).toBe(true);
  trackKey(ctx, resp.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: resp.data.key });
}

describe("system.* set", () => {
  it("rejects system.* writes from every key the API can mint", async () => {
    const np = await narrowClient("np-system-write");
    const r = await np.createItem({
      type: "system.device",
      properties: { name: "np-write", kind: "laptop" },
    });
    expect(r.status).toBe(403);
    expect(r.error?.error.code).toBe("type_not_permitted");
  });
});
