import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
let mappedConnectionId: string;
let familiesOnlyConnectionId: string;

/**
 * Register a minimal integration + connection pair directly through
 * storage, mirroring what the install pipeline persists: the manifest on a
 * `system.integration` item and an `integration_ref` on the connection.
 */
async function seedConnection(
  name: string,
  supportsMappings: boolean,
): Promise<string> {
  const manifest = {
    name,
    version: "0.1.0",
    manifest_schema_version: "2.0.0",
    publisher: "demo",
    description: "Mapping-surface fixture integration.",
    direction: "read",
    target_types: ["core.bookmark"],
    triggers: [{ type: "manual" }],
    bidirectional_handling: {
      echo_ttl_seconds: 1,
      lag_window_seconds: 1,
      tombstone_mapping: "ignore",
      partial_write_mode: "accept-partial",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    ...(supportsMappings ? { supports_user_mappings: true } : {}),
  };
  const integration = await ctx.storage.items.create({
    type: "system.integration",
    properties: {
      manifest,
      manifest_name: name,
      manifest_version: "0.1.0",
      publisher: "demo",
      summary: manifest.description,
      direction: "read",
      registered_at: new Date().toISOString(),
    },
  });
  const connection = await ctx.storage.items.create({
    type: "system.connection",
    properties: {
      kind: "integration",
      status: "active",
      granted_at: new Date().toISOString(),
      integration_ref: integration.id,
      configuration: {},
      direction: "read",
      triggers: [{ type: "manual" }],
    },
  });
  return connection.id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  const baseType = {
    version: 1,
    fields: { title: { type: "string", required: true } },
  };
  const registered = await request(ctx.app, "POST", "/types", {
    key: ctx.adminKey,
    body: { id: "user.reading_log", ...baseType },
  });
  expect(registered.status).toBe(201);
  mappedConnectionId = await seedConnection("demo/mapped", true);
  familiesOnlyConnectionId = await seedConnection("demo/unmapped", false);
});

afterAll(async () => {
  await ctx.cleanup();
});

const VALID_MAPPING = {
  version: 1,
  rules: [
    {
      when: { path: "kind", op: "equals", value: "article" },
      target_type: "user.reading_log",
      assign: { title: { path: "title" } },
    },
  ],
  otherwise: "family",
};

describe("connection mapping surface", () => {
  it("requires auth", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/connections/${mappedConnectionId}/mapping`,
      {},
    );
    expect(res.status).toBe(401);
  });

  it("stores, reads back, and clears a valid mapping", async () => {
    const put = await request(
      ctx.app,
      "PUT",
      `/connections/${mappedConnectionId}/mapping`,
      { key: ctx.adminKey, body: VALID_MAPPING },
    );
    expect(put.status).toBe(200);

    const got = await request(
      ctx.app,
      "GET",
      `/connections/${mappedConnectionId}/mapping`,
      { key: ctx.adminKey },
    );
    const gotBody = (await got.json()) as { mapping: { rules: unknown[] } };
    expect(gotBody.mapping.rules).toHaveLength(1);

    const cleared = await request(
      ctx.app,
      "DELETE",
      `/connections/${mappedConnectionId}/mapping`,
      { key: ctx.adminKey },
    );
    expect(cleared.status).toBe(200);
    const after = await request(
      ctx.app,
      "GET",
      `/connections/${mappedConnectionId}/mapping`,
      { key: ctx.adminKey },
    );
    expect(((await after.json()) as { mapping: unknown }).mapping).toBeNull();
  });

  it("refuses an invalid mapping naming the field", async () => {
    const res = await request(
      ctx.app,
      "PUT",
      `/connections/${mappedConnectionId}/mapping`,
      {
        key: ctx.adminKey,
        body: {
          version: 1,
          rules: [
            {
              when: { path: "kind", op: "equals", value: "article" },
              target_type: "user.reading_log",
              assign: { nonexistent: { const: "x" } },
            },
          ],
        },
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { details?: { issues?: { field: string }[] } };
    };
    const fields = (body.error.details?.issues ?? []).map((i) => i.field);
    expect(fields).toContain("rules.0.assign.nonexistent");
    // The required field never assigned is named too.
    expect(fields).toContain("rules.0.assign.title");
  });

  it("refuses a mapping on an integration that does not consult them", async () => {
    const res = await request(
      ctx.app,
      "PUT",
      `/connections/${familiesOnlyConnectionId}/mapping`,
      { key: ctx.adminKey, body: VALID_MAPPING },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("does not consult user mappings");
  });
});

describe("bringing the items already there", () => {
  const readConnection = async (
    id: string,
  ): Promise<Record<string, unknown>> => {
    const item = await ctx.storage.items.get(id);
    return item?.properties ?? {};
  };

  it("records an answer that expires rather than one that stands", async () => {
    const res = await request(
      ctx.app,
      "PUT",
      `/connections/${mappedConnectionId}/mapping?reapply=true`,
      { key: ctx.adminKey, body: VALID_MAPPING },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reapply_until: string | null };
    expect(body.reapply_until).not.toBeNull();

    // A deadline, not a flag: a sweep that parks and never resumes cannot
    // leave this standing, and a person asking why it is still on gets a
    // time rather than a hunt through run history.
    const until = Date.parse(body.reapply_until!);
    const hours = (until - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(20);
    expect(hours).toBeLessThanOrEqual(24);
    expect(await readConnection(mappedConnectionId)).toMatchObject({
      mapping_reapply_until: body.reapply_until,
    });
  });

  it("does not record one when the answer is no", async () => {
    const res = await request(
      ctx.app,
      "PUT",
      `/connections/${mappedConnectionId}/mapping`,
      { key: ctx.adminKey, body: VALID_MAPPING },
    );
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { reapply_until: string | null }).reapply_until,
    ).toBeNull();
  });

  it("lets a later no clear an earlier yes", async () => {
    // The question is asked afresh on every save, so the previous answer
    // must not survive one. A shallow property merge would have left it.
    await request(
      ctx.app,
      "PUT",
      `/connections/${mappedConnectionId}/mapping?reapply=true`,
      { key: ctx.adminKey, body: VALID_MAPPING },
    );
    expect(
      (await readConnection(mappedConnectionId)).mapping_reapply_until,
    ).toEqual(expect.any(String));

    await request(
      ctx.app,
      "PUT",
      `/connections/${mappedConnectionId}/mapping?reapply=false`,
      { key: ctx.adminKey, body: VALID_MAPPING },
    );
    expect(
      (await readConnection(mappedConnectionId)).mapping_reapply_until ?? null,
    ).toBeNull();
  });

  it("takes the answer away with the mapping it was about", async () => {
    await request(
      ctx.app,
      "PUT",
      `/connections/${mappedConnectionId}/mapping?reapply=true`,
      { key: ctx.adminKey, body: VALID_MAPPING },
    );
    await request(
      ctx.app,
      "DELETE",
      `/connections/${mappedConnectionId}/mapping`,
      { key: ctx.adminKey },
    );
    const props = await readConnection(mappedConnectionId);
    expect(props.mapping ?? null).toBeNull();
    // A standing "bring the corpus along" against a mapping that no
    // longer exists could only move rows towards the write family, which
    // is not what anybody agreed to.
    expect(props.mapping_reapply_until ?? null).toBeNull();
  });
});
