/**
 * Approving a widening upgrade.
 *
 * The pipeline has always been able to approve one: `performUpgrade` takes
 * `consentedToWidening` and applies the move when it is set. Nothing in the
 * running system set it. Both production callers omitted it, no client
 * called the route at all, and the automatic pass counted the connections
 * it could not move under a disposition with no route that could clear it.
 * So the state machine had three positions and could reach two.
 *
 * These tests are about the third. The list says which connections are
 * waiting and what each move would newly allow; the approval applies to the
 * version the caller was shown and to no other; and the flag stays
 * unreachable from an ordinary request body, which is the property that
 * makes the gate mean anything.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { IntegrationManifest } from "@withmarfa/shared";
import { registerIntegrationManifest } from "../integrations/register-manifest.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ authMode: "hosted" });
});

afterAll(async () => {
  await ctx.cleanup();
});

let seq = 0;
function nextName(): string {
  seq += 1;
  return `acme/approve-${String(seq)}-${Math.random().toString(36).slice(2, 8)}`;
}

function manifest(
  name: string,
  over: Partial<IntegrationManifest> = {},
): IntegrationManifest {
  return {
    name,
    version: "1.0.0",
    manifest_schema_version: "2.0.0",
    publisher: "acme",
    description: "approve test",
    direction: "read",
    runs_on: "server" as const,
    triggers: [{ type: "schedule", config: { cron: "0 * * * *" } }],
    target_types: ["core.note"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "ignore",
      partial_write_mode: "accept-partial",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    ...over,
  };
}

/** A space-admin key with no platform flag: the shape a space owner holds. */
async function ownerKey(spaceId: string): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const res = await request(ctx.app, "POST", `/admin/spaces/${spaceId}/keys`, {
    key: ctx.adminKey,
    body: {
      label: `owner-${suffix}`,
      source: `owner-${suffix}`,
      role: "space_admin",
      default_tier: "library",
      type_permissions: { "*": "write" },
    },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { key: string; is_platform?: boolean };
  expect(body.is_platform ?? false).toBe(false);
  return body.key;
}

async function memberKey(spaceId: string): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const res = await request(ctx.app, "POST", `/admin/spaces/${spaceId}/keys`, {
    key: ctx.adminKey,
    body: {
      label: `member-${suffix}`,
      source: `member-${suffix}`,
      role: "member",
      default_tier: "library",
      type_permissions: { "*": "write" },
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { key: string }).key;
}

/**
 * Register v1, install a connection against it in `spaceId`, then register
 * v2 with whatever the caller wants to change.
 */
async function scenario(
  spaceId: string,
  v2: Partial<IntegrationManifest>,
): Promise<{ connectionId: string; name: string }> {
  const name = nextName();
  const first = await registerIntegrationManifest(
    ctx.storage,
    manifest(name),
    undefined,
  );
  const connection = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        runtime_status: "healthy",
        granted_at: new Date().toISOString(),
        integration_ref: first.item.id,
        configuration: {},
        direction: "read",
        triggers: [{ type: "schedule", config: { cron: "0 * * * *" } }],
      },
    },
    spaceId,
  );
  await registerIntegrationManifest(
    ctx.storage,
    manifest(name, { version: "2.0.0", ...v2 }),
    undefined,
  );
  return { connectionId: connection.id, name };
}

const widens = { target_types: ["core.note", "core.bookmark"] };

describe("a widening upgrade can be seen and approved", () => {
  let spaceId: string;
  let key: string;

  beforeAll(async () => {
    const space = await ctx.storage.spaces!.create("approve-owner");
    spaceId = space.id;
    key = await ownerKey(spaceId);
  });

  it("lists the connection held back, with what the move would newly allow", async () => {
    const s = await scenario(spaceId, widens);

    const res = await request(ctx.app, "GET", "/connections/upgrades/pending", {
      key,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pending: {
        connection_id: string;
        manifest_name: string;
        from_version: string;
        to_version: string;
        consent_lines: string[];
      }[];
    };
    const entry = body.pending.find((p) => p.connection_id === s.connectionId);
    expect(entry).toBeDefined();
    expect(entry?.from_version).toBe("1.0.0");
    expect(entry?.to_version).toBe("2.0.0");
    // The name a person reads. It comes from the manifest because a
    // connection has none of its own — the entry used to offer a `label`
    // read off the connection's properties, which nothing ever wrote.
    expect(entry?.manifest_name).toBe(s.name);
    // The sentences are the point: a count told nobody what to decide.
    expect(entry?.consent_lines.join(" ")).toContain("core.bookmark");
  });

  it("does not list a connection whose newer version takes no more", async () => {
    const s = await scenario(spaceId, {});
    const res = await request(ctx.app, "GET", "/connections/upgrades/pending", {
      key,
    });
    const body = (await res.json()) as { pending: { connection_id: string }[] };
    expect(body.pending.some((p) => p.connection_id === s.connectionId)).toBe(
      false,
    );
  });

  it("approves the version it was shown and moves the connection", async () => {
    const s = await scenario(spaceId, widens);

    const refused = await request(
      ctx.app,
      "POST",
      `/connections/${s.connectionId}/upgrade`,
      { key },
    );
    expect(refused.status).toBe(403);

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${s.connectionId}/upgrade/approve`,
      { key, body: { to_version: "2.0.0" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { to: { manifest_version: string } };
    expect(body.to.manifest_version).toBe("2.0.0");

    const after = await ctx.storage.items.get(s.connectionId, spaceId);
    const ref = (after?.properties as { integration_ref?: string })
      .integration_ref;
    const row = await ctx.storage.items.get(String(ref), undefined, {
      includePlatformScoped: true,
    });
    expect(
      (row?.properties as { manifest_version?: string }).manifest_version,
    ).toBe("2.0.0");
  });

  it("refuses an approval naming a version that is no longer the candidate", async () => {
    const s = await scenario(spaceId, widens);
    // A third version registers between reading the list and approving.
    await registerIntegrationManifest(
      ctx.storage,
      manifest(s.name, { version: "3.0.0", ...widens }),
      undefined,
    );

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${s.connectionId}/upgrade/approve`,
      { key, body: { to_version: "2.0.0" } },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { details?: { candidate_version?: string } };
    };
    expect(body.error.details?.candidate_version).toBe("3.0.0");

    // And it did not half-apply.
    const after = await ctx.storage.items.get(s.connectionId, spaceId);
    const ref = (after?.properties as { integration_ref?: string })
      .integration_ref;
    const row = await ctx.storage.items.get(String(ref), undefined, {
      includePlatformScoped: true,
    });
    expect(
      (row?.properties as { manifest_version?: string }).manifest_version,
    ).toBe("1.0.0");
  });

  it("refuses to approve a move that needs no approval", async () => {
    const s = await scenario(spaceId, {});
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${s.connectionId}/upgrade/approve`,
      { key, body: { to_version: "2.0.0" } },
    );
    expect(res.status).toBe(409);
    // Three branches answer 409 on this route, so the status alone would
    // pass for the wrong reason.
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("needs no approval");
  });
});

describe("the gate is not reachable from an ordinary request", () => {
  let spaceId: string;
  let key: string;

  beforeAll(async () => {
    const space = await ctx.storage.spaces!.create("approve-gate");
    spaceId = space.id;
    key = await ownerKey(spaceId);
  });

  it("REGRESSION: a caller cannot approve its own widening through the upgrade body", async () => {
    const s = await scenario(spaceId, widens);
    for (const body of [
      { consented_to_widening: true },
      { consentedToWidening: true },
      { consent: true, approve: true },
    ]) {
      const res = await request(
        ctx.app,
        "POST",
        `/connections/${s.connectionId}/upgrade`,
        { key, body },
      );
      expect(res.status).toBe(403);
    }
    const after = await ctx.storage.items.get(s.connectionId, spaceId);
    const ref = (after?.properties as { integration_ref?: string })
      .integration_ref;
    const row = await ctx.storage.items.get(String(ref), undefined, {
      includePlatformScoped: true,
    });
    expect(
      (row?.properties as { manifest_version?: string }).manifest_version,
    ).toBe("1.0.0");
  });

  it("refuses a member on both the list and the approval", async () => {
    const s = await scenario(spaceId, widens);
    const member = await memberKey(spaceId);

    const listed = await request(
      ctx.app,
      "GET",
      "/connections/upgrades/pending",
      { key: member },
    );
    expect(listed.status).toBe(403);

    const approved = await request(
      ctx.app,
      "POST",
      `/connections/${s.connectionId}/upgrade/approve`,
      { key: member, body: { to_version: "2.0.0" } },
    );
    expect(approved.status).toBe(403);
  });
});

describe("a move that would strand a mapping is not a decision to offer", () => {
  it("is listed as blocked rather than awaiting consent, and refused", async () => {
    // A version that both widens and drops mapping support is not
    // something a person can agree to: agreeing would not bring the
    // mapping back. It used to be classified awaiting-consent, because the
    // widens check ran first, and the pipeline had no mapping check at
    // all, so this route would have applied it from a list that says
    // reading the lines is all that stands in the way.
    const space = await ctx.storage.spaces!.create("approve-strand");
    const key = await ownerKey(space.id);
    const s = await scenario(space.id, {
      ...widens,
      supports_user_mappings: false,
    });
    await ctx.storage.items.update(
      s.connectionId,
      {
        properties: {
          mapping: {
            version: 1,
            rules: [
              {
                when: { path: "kind", op: "exists" },
                target_type: "core.note",
                assign: { title: { path: "name" } },
              },
            ],
          },
        },
      },
      space.id,
    );

    const listed = await request(
      ctx.app,
      "GET",
      "/connections/upgrades/pending",
      { key },
    );
    const body = (await listed.json()) as {
      pending: { connection_id: string }[];
    };
    expect(body.pending.some((p) => p.connection_id === s.connectionId)).toBe(
      false,
    );

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${s.connectionId}/upgrade/approve`,
      { key, body: { to_version: "2.0.0" } },
    );
    expect(res.status).toBe(409);
    // Four branches answer 409 on this route, and this fixture also
    // widens, so a broken widens check would 409 from a different one and
    // the status alone would pass for the wrong reason.
    const refusal = (await res.json()) as {
      error: { details?: { upgrade_error_code?: string } };
    };
    expect(refusal.error.details?.upgrade_error_code).toBe(
      "mapping_would_be_stranded",
    );
  });

  it("refuses on the plain route too, which is the half that was missing", async () => {
    // A version that drops mapping support and widens nothing. That is the
    // case the background pass declined and both routes applied, and it
    // has to be non-widening or a consent refusal answers first and the
    // assertion says nothing about the mapping.
    const space = await ctx.storage.spaces!.create("approve-strand-plain");
    const key = await ownerKey(space.id);
    const s = await scenario(space.id, { supports_user_mappings: false });
    await ctx.storage.items.update(
      s.connectionId,
      {
        properties: {
          mapping: {
            version: 1,
            rules: [
              {
                when: { path: "kind", op: "exists" },
                target_type: "core.note",
                assign: { title: { path: "name" } },
              },
            ],
          },
        },
      },
      space.id,
    );

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${s.connectionId}/upgrade`,
      { key },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { details?: { upgrade_error_code?: string } };
    };
    expect(body.error.details?.upgrade_error_code).toBe(
      "mapping_would_be_stranded",
    );
  });
});

describe("the list is scoped to the caller's space", () => {
  it("refuses to approve another space's connection", async () => {
    // The approve route's only fence. Nothing else stops a space admin
    // naming an id they read somewhere, and the list test below covers
    // the read side rather than this one.
    const mine = await ctx.storage.spaces!.create("approve-fence-mine");
    const theirs = await ctx.storage.spaces!.create("approve-fence-theirs");
    const myKey = await ownerKey(mine.id);
    const theirConnection = await scenario(theirs.id, widens);

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${theirConnection.connectionId}/upgrade/approve`,
      { key: myKey, body: { to_version: "2.0.0" } },
    );
    expect(res.status).toBe(404);

    // And it did not move.
    const after = await ctx.storage.items.get(
      theirConnection.connectionId,
      theirs.id,
    );
    const ref = (after?.properties as { integration_ref?: string })
      .integration_ref;
    const row = await ctx.storage.items.get(String(ref), undefined, {
      includePlatformScoped: true,
    });
    expect(
      (row?.properties as { manifest_version?: string }).manifest_version,
    ).toBe("1.0.0");
  });

  it("does not show another space's connection", async () => {
    const mine = await ctx.storage.spaces!.create("approve-mine");
    const theirs = await ctx.storage.spaces!.create("approve-theirs");
    const myKey = await ownerKey(mine.id);
    const theirConnection = await scenario(theirs.id, widens);
    const myConnection = await scenario(mine.id, widens);

    const res = await request(ctx.app, "GET", "/connections/upgrades/pending", {
      key: myKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pending: { connection_id: string }[] };
    const ids = body.pending.map((p) => p.connection_id);
    expect(ids).toContain(myConnection.connectionId);
    expect(ids).not.toContain(theirConnection.connectionId);
  });
});
