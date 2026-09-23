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
    "key-last-used",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("API key last_used_at compliance", () => {
  it("new key has null or absent last_used_at", async () => {
    const keyResp = await client.createKey({
      label: `klu-new-${ctx.runId}`,
      source: `${ctx.source}-${`klu-new-${ctx.runId}`}`,
      type_permissions: { "*": "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    expect(keyResp.data.last_used_at).toBeNull();
  });

  it("last_used_at is set after first use", async () => {
    const keyResp = await client.createKey({
      label: `klu-used-${ctx.runId}`,
      source: `${ctx.source}-${`klu-used-${ctx.runId}`}`,
      type_permissions: { "*": "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);

    const scopedClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });
    const useResp = await scopedClient.listItems({ limit: 1 });
    expect(useResp.ok).toBe(true);

    // Brief wait for debounced write to complete
    await new Promise((r) => setTimeout(r, 500));

    const list = await client.listKeys();
    expect(list.ok).toBe(true);

    const found = list.data.data.find((k) => k.id === keyResp.data.id);
    expect(found).toBeDefined();
    expect(typeof found!.last_used_at).toBe("string");
  });

  it("last_used_at is a valid ISO 8601 timestamp", async () => {
    const keyResp = await client.createKey({
      label: `klu-valid-${ctx.runId}`,
      source: `${ctx.source}-${`klu-valid-${ctx.runId}`}`,
      type_permissions: { "*": "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);

    const scopedClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });
    await scopedClient.listItems({ limit: 1 });

    await new Promise((r) => setTimeout(r, 500));

    const list = await client.listKeys();
    expect(list.ok).toBe(true);

    const found = list.data.data.find((k) => k.id === keyResp.data.id);
    expect(found).toBeDefined();
    expect(found!.last_used_at).toBeDefined();

    const parsed = new Date(found!.last_used_at!);
    expect(parsed.getTime()).not.toBeNaN();
  });

  it("last_used_at appears in list response", async () => {
    const keyResp = await client.createKey({
      label: `klu-list-${ctx.runId}`,
      source: `${ctx.source}-${`klu-list-${ctx.runId}`}`,
      type_permissions: { "*": "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);

    const scopedClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });
    await scopedClient.listItems({ limit: 1 });

    await new Promise((r) => setTimeout(r, 500));

    const list = await client.listKeys();
    expect(list.ok).toBe(true);

    const found = list.data.data.find((k) => k.id === keyResp.data.id);
    expect(found).toBeDefined();
    expect("last_used_at" in found!).toBe(true);
  });
});
