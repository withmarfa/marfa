import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackKey, cleanup } from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "keys-update",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function narrowKey(label: string) {
  const r = await client.createKey({
    label,
    source: `${ctx.source}-${label}`,
    type_permissions: { "core.note": "read" },
  });
  expect(r.ok).toBe(true);
  trackKey(ctx, r.data.id);
  return r.data;
}

describe("PATCH /keys/{id}", () => {
  it("updates the label and the maps in place, never the source", async () => {
    const key = await narrowKey("ku-label");

    expect(key.default_tier).toBe("library");

    const relabeled = await client.updateKey(key.id, { label: "ku-renamed" });
    expect(relabeled.ok).toBe(true);
    await expectMatchesSchema("PATCH", "/keys/{id}", 200, relabeled.data);
    expect(relabeled.data.id).toBe(key.id);
    expect(relabeled.data.label).toBe("ku-renamed");
    expect(relabeled.data.source).toBe(key.source);
    expect(relabeled.data.type_permissions).toEqual({ "core.note": "read" });

    const widened = await client.updateKey(key.id, {
      type_permissions: { "core.note": "write", "core.bookmark": "read" },
      default_tier: "feed",
    });
    expect(widened.ok).toBe(true);
    expect(widened.data.type_permissions).toEqual({
      "core.note": "write",
      "core.bookmark": "read",
    });
    expect(widened.data.default_tier).toBe("feed");

    const listed = await client.listKeys();
    expect(listed.ok).toBe(true);
    const row = listed.data.keys.find((k) => k.id === key.id);
    expect(row?.label).toBe("ku-renamed");
    expect(row?.default_tier).toBe("feed");
  });

  it("refuses a change of source", async () => {
    const key = await narrowKey("ku-source");
    const r = await client.updateKey(key.id, { source: "somewhere-else" });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("validation_error");
  });

  it("refuses a key widening itself past what it holds", async () => {
    const key = await narrowKey("ku-widen");
    const self = new MarfaClient({ baseUrl: apiUrl, apiKey: key.key });
    const r = await self.updateKey(key.id, {
      type_permissions: { "*": "write" },
    });
    expect(r.status).toBe(403);
    expect(r.error?.error.code).toBe("forbidden");
    expect(r.error?.error.details?.required_scope).toBe("*:write");

    const unchanged = await client.listKeys();
    const row = unchanged.data.keys.find((k) => k.id === key.id);
    expect(row?.type_permissions).toEqual({ "core.note": "read" });
  });

  it("refuses a caller without space.keys", async () => {
    const target = await narrowKey("ku-target");
    const noKeys = await client.createKey({
      label: "ku-no-keys",
      source: `${ctx.source}-ku-no-keys`,
      space_permissions: [],
      type_permissions: { "*": "write" },
    });
    expect(noKeys.ok).toBe(true);
    trackKey(ctx, noKeys.data.id);
    const other = new MarfaClient({ baseUrl: apiUrl, apiKey: noKeys.data.key });
    const r = await other.updateKey(target.id, { label: "taken over" });
    expect(r.status).toBe(403);
    expect(r.error?.error.code).toBe("forbidden");
    expect(r.error?.error.details?.required_scope).toBe("space.keys");
  });

  it("answers 404 for an unknown key and 400 for a malformed id", async () => {
    const unknown = await client.updateKey(
      "00000000-0000-7000-8000-000000000000",
      { label: "x" },
    );
    expect(unknown.status).toBe(404);
    expect(unknown.error?.error.code).toBe("api_key_not_found");

    const malformed = await client.updateKey("not-an-id", { label: "x" });
    expect(malformed.status).toBe(400);
  });

  it("refuses a request with no credential", async () => {
    const key = await narrowKey("ku-anon");
    const anonymous = new MarfaClient({ baseUrl: apiUrl, apiKey: "" });
    const r = await anonymous.updateKey(key.id, { label: "x" });
    expect(r.status).toBe(401);
  });
});
