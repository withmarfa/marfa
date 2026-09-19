import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "promote-reconcile",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

/**
 * Both doors act on an item that is a connector's copy. No connector
 * runs on the server under test, so the success paths are unreachable over
 * the wire; what a caller can reach is every refusal, and those are the
 * contract asserted here.
 */
describe("promote and reconcile", () => {
  it("refuses to promote an item that is already the caller's own", async () => {
    const item = await client.createItem(createNote({ source: ctx.source }));
    expect(item.ok).toBe(true);
    trackItem(ctx, item.data.item.id);

    const r = await client.promoteItem(item.data.item.id);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("validation_error");
    expect(r.error?.error.details?.item_id).toBe(item.data.item.id);

    const unchanged = await client.getItem(item.data.item.id);
    expect(unchanged.ok).toBe(true);
    expect(unchanged.data.item.version).toBe(1);
  });

  it("refuses to reconcile an item that was never promoted", async () => {
    const item = await client.createItem(createNote({ source: ctx.source }));
    expect(item.ok).toBe(true);
    trackItem(ctx, item.data.item.id);

    const r = await client.reconcileItem(item.data.item.id);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("validation_error");
    expect(r.error?.error.details?.item_id).toBe(item.data.item.id);
  });

  it("answers 404 for an unknown item on both doors", async () => {
    const unknown = "00000000-0000-7000-8000-000000000000";
    const promote = await client.promoteItem(unknown);
    expect(promote.status).toBe(404);
    expect(promote.error?.error.code).toBe("item_not_found");
    const reconcile = await client.reconcileItem(unknown);
    expect(reconcile.status).toBe(404);
    expect(reconcile.error?.error.code).toBe("item_not_found");
  });

  it("refuses both doors without a credential", async () => {
    const item = await client.createItem(createNote({ source: ctx.source }));
    expect(item.ok).toBe(true);
    trackItem(ctx, item.data.item.id);
    const anonymous = new MarfaClient({ baseUrl: apiUrl, apiKey: "" });
    for (const refused of [
      await anonymous.promoteItem(item.data.item.id),
      await anonymous.reconcileItem(item.data.item.id),
    ]) {
      expect(refused.status).toBe(401);
      expect(refused.error?.error.code).toBe("unauthorized");
    }
  });
});
