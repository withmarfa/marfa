import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext(
    "compliance",
    "custom-type-lifecycle",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("a custom type follows the universal lifecycle", () => {
  it("active -> archived -> active -> trashed -> (invalid) archived", async () => {
    const typeId = `user.evaluator-lifecycle-probe-${ctx.runId}`;
    const registered = await client.registerType({
      id: typeId,
      fields: { title: { type: "string", required: true } },
    });
    expect(registered.ok).toBe(true);

    const created = await client.createItem({
      type: typeId,
      properties: { title: "lifecycle probe" },
      source: ctx.source,
    });
    expect(created.ok).toBe(true);
    trackItem(ctx, created.data.item.id);
    expect(created.data.item.state).toBe("active");

    const archived = await client.transitionItem(
      created.data.item.id,
      "archived",
    );
    expect(archived.ok).toBe(true);
    expect(archived.status).toBe(200);
    expect(archived.data.item.state).toBe("archived");

    const reactivated = await client.transitionItem(
      created.data.item.id,
      "active",
    );
    expect(reactivated.ok).toBe(true);
    expect(reactivated.status).toBe(200);
    expect(reactivated.data.item.state).toBe("active");

    const invalid = await client.transitionItem(
      created.data.item.id,
      "nonexistent",
    );
    expect(invalid.status).toBe(400);
    expect(invalid.error?.error.code).toBe("validation_error");

    const trashed = await client.transitionItem(
      created.data.item.id,
      "trashed",
    );
    expect(trashed.ok).toBe(true);
    expect(trashed.status).toBe(200);
    expect(trashed.data.item.state).toBe("trashed");

    // The last leg the title names, and the one nothing asserted. A trashed
    // row is read past the trashed-invisible getter, so the lifecycle graph
    // judges the move and refuses it; `404 item_not_found`, which this door
    // used to answer and which `findings.md` recorded, is the answer the
    // graph never gets to give.
    const refused = await client.transitionItem(
      created.data.item.id,
      "archived",
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_transition");
  });
});
