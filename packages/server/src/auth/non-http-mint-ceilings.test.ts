/**
 * Ceiling coverage for the minting paths that are NOT HTTP routes.
 *
 * `routes/credential-mint-doors.test.ts` guards every way of asking the
 * server for a credential over HTTP: its coverage legs reflect the
 * OpenAPI document and pin the plain-Hono route table, so a new
 * secret-bearing route fails the run until it registers a door. Two real
 * minting paths are invisible to all of that by construction, because
 * they are in-process function calls with no route:
 *
 *   - the local substrate's per-dispatch mint
 *     (`integrations/local-runtime/credentials.ts`)
 *
 * The install pipeline used to be the second. It minted a seed credential
 * nobody could present, and is now the third door enforcing the rule that
 * decided whether it could: a space-less Connection on a hosted deployment must
 * not reach an installable state, because a credential minted for it
 * later would reach every space. The check outlived the mint deliberately,
 * so the leg below still asserts it, against the install rather than
 * against a credential.
 *
 * This file therefore pins the full set of in-process mint call sites so
 * a new one fails here until it is either covered or added deliberately.
 * The local substrate's own ceilings are already asserted in
 * `integrations/local-runtime/credentials.test.ts` (least privilege, the
 * space fence, expiry) and are not duplicated.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { performInstall } from "../connections/install-pipeline.js";
import type { IntegrationManifest } from "@withmarfa/shared";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

function manifest(name: string): IntegrationManifest {
  return {
    name,
    version: "1.0.0",
    publisher: "Acme",
    description: "non-http mint ceiling fixture",
    direction: "both",
    triggers: [{ type: "manual" }],
    target_types: ["core.note"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "prompt-user",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "2.0.0",
  };
}

async function integrationItem(name: string): Promise<string> {
  const m = manifest(name);
  const item = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: m.name,
        manifest_version: m.version,
        publisher: m.publisher,
        direction: m.direction,
        manifest: m,
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  return item.id;
}

async function adminKeyId(): Promise<string> {
  const admin = (await ctx.storage.keys.list()).find(
    (k) => k.role === "instance_admin",
  );
  if (!admin) throw new Error("admin key not found in test ctx");
  return admin.id;
}

describe("install-pipeline — the space fence outlives the mint it guarded", () => {
  it("a space-less connection under hosted auth is refused", async () => {
    const name = "acme.mint-ceiling-over";
    const integrationId = await integrationItem(name);
    await expect(
      performInstall(ctx.storage, {
        apiKeyId: await adminKeyId(),
        spaceId: undefined,
        authMode: "hosted",
        integrationItemId: integrationId,
        manifest: manifest(name),
      }),
    ).rejects.toThrow();

    // The refusal must leave nothing behind: the pipeline's compensations
    // revoke the Connection step 1 created, so a refused install strands
    // no active Connection.
    //
    // Scoped to this fixture's own integration rather than sweeping every
    // `system.connection` in the context. A file-global sweep passes
    // vacuously when the list comes back empty, and breaks the moment any
    // other case in this file installs successfully.
    const connections = await ctx.storage.items.list({
      type: "system.connection",
    });
    const mine = connections.data.filter(
      (i) =>
        (i.properties as { integration_ref?: string }).integration_ref ===
        integrationId,
    );
    expect(mine.map((i) => i.state)).not.toContain("active");
  });
});

describe("in-process mint call sites are pinned", () => {
  it("every keys.createRuntimeCredential call site is known and covered", () => {
    // The HTTP legs cannot see an in-process mint, so the fence on this
    // side is the source itself: walk the server and integration sources
    // for the store call and pin the set. A new path fails here until it
    // either gets ceiling coverage like the two above or is added with a
    // reason.
    const KNOWN = new Set(["integrations/local-runtime/credentials.ts"]);

    const srcRoot = fileURLToPath(new URL("..", import.meta.url));
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
          continue;
        }
        if (
          readFileSync(full, "utf8").includes("keys.createRuntimeCredential(")
        ) {
          hits.push(relative(srcRoot, full));
        }
      }
    };
    walk(srcRoot);

    expect(new Set(hits)).toEqual(KNOWN);
  });
});
