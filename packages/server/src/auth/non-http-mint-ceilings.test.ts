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
 *   - the install pipeline's step-2 mint (`connections/install-pipeline.ts`)
 *   - the local substrate's per-dispatch mint
 *     (`integrations/local-runtime/credentials.ts`)
 *
 * This file gives the install-pipeline mint the same two-directional
 * shape every door row has (an over-ceiling ask refused, an at-ceiling
 * mint bounded to the governing declaration), and pins the full set of
 * in-process mint call sites so a new one fails here until it is either
 * covered or added deliberately. The local substrate's own ceilings are
 * already asserted in `integrations/local-runtime/credentials.test.ts`
 * (least privilege, the space fence, expiry) and are not duplicated.
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
    runtime_compatibility: ["hosted"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "prompt-user",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "1.0.0",
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
        runtime_compatibility: m.runtime_compatibility,
        manifest: m,
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  return item.id;
}

async function adminKeyId(): Promise<string> {
  const admin = (await ctx.storage.keys.list()).find((k) => k.role === "admin");
  if (!admin) throw new Error("admin key not found in test ctx");
  return admin.id;
}

describe("install-pipeline mint — the ceiling, both directions", () => {
  it("at the ceiling: the credential's breadth is exactly the manifest projection", async () => {
    const name = "acme.mint-ceiling-at";
    const result = await performInstall(ctx.storage, "test-salt", {
      apiKeyId: await adminKeyId(),
      spaceId: undefined,
      authMode: "keys",
      integrationItemId: await integrationItem(name),
      manifest: manifest(name),
      label: "ceiling fixture",
    });

    const cred = (await ctx.storage.keys.list()).find(
      (k) => k.id === result.credential_id,
    );
    if (!cred) throw new Error("minted credential did not resolve");

    // Exactly the declared target types plus the substrate's status
    // channel — never a wildcard, never a type the manifest does not name.
    const granted = Object.keys(cred.type_permissions).sort();
    expect(granted).toEqual(["core.note", "system.activity"]);
    expect(granted).not.toContain("*");
    // Rank and platform tier never ride through this door.
    expect(cred.role).toBe("member");
    expect(cred.is_platform).toBe(false);
    // Machine-minted means expiring: an unstamped runtime credential
    // would outlive every dispatch that could refresh it.
    expect(cred.expires_at).toBeTruthy();
  });

  it("over the ceiling: a space-less connection under hosted auth is refused", async () => {
    const name = "acme.mint-ceiling-over";
    await expect(
      performInstall(ctx.storage, "test-salt", {
        apiKeyId: await adminKeyId(),
        spaceId: undefined,
        authMode: "hosted",
        integrationItemId: await integrationItem(name),
        manifest: manifest(name),
        label: "spaceless fixture",
      }),
    ).rejects.toThrow();

    // The refusal must leave no live credential behind: the pipeline's
    // compensations tear down whatever step 1 created, and keys.list()
    // reports only live rows.
    const leaked = (await ctx.storage.keys.list()).find(
      (k) => k.label === "spaceless fixture",
    );
    expect(leaked).toBeUndefined();
  });
});

describe("in-process mint call sites are pinned", () => {
  it("every keys.createRuntimeCredential call site is known and covered", () => {
    // The HTTP legs cannot see an in-process mint, so the fence on this
    // side is the source itself: walk the server and integration sources
    // for the store call and pin the set. A new path fails here until it
    // either gets ceiling coverage like the two above or is added with a
    // reason.
    const KNOWN = new Set([
      "connections/install-pipeline.ts",
      "integrations/local-runtime/credentials.ts",
      "routes/runtime-credentials.ts",
    ]);

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
