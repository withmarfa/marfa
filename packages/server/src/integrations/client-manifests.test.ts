/**
 * The client manifests reach the catalog, and nothing about where they are
 * filed can quietly stop that.
 *
 * This is the acceptance criterion the move out of `integrations/` puts at
 * risk, and it is the one a careless move breaks silently. Discovery is by
 * directory read, and a manifest that is no longer in the directory is not
 * an error to it. The reconcile logs what it registered, the server boots,
 * and the only visible symptom is a client that cannot be installed on a
 * fresh deployment, weeks later.
 *
 * So the test exercises the boot-time entry point rather than the pieces:
 * `reconcileShippedCatalog` with a directory holding nothing, and with no
 * directory at all. Neither can pass on discovered manifests, so a row for
 * `marfa/sync` can only have come from the build.
 *
 * What it cannot prove is that boot goes through that entry point at all.
 * Nothing here objects to `index.ts` being rewired to reconcile discovery
 * on its own, and no assertion over the boot module's source is worth
 * having: it would pass on a comment and fail the day boot legitimately
 * wants a banned substring. `scripts/smoke-boot.ts` holds that instead, by
 * booting the real binary against a real database and reading the
 * reconcile's own log line.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntegrationManifestSchema } from "@withmarfa/shared";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { CLIENT_MANIFESTS } from "./client-manifests.js";
import { reconcileShippedCatalog } from "./catalog-reconcile.js";
import { findCatalogRow } from "./register-manifest.js";

let ctx: TestContext;
let emptyRoot: string;

beforeAll(async () => {
  ctx = await createTestContext();
  emptyRoot = mkdtempSync(join(tmpdir(), "marfa-no-integrations-"));
});

afterAll(async () => {
  rmSync(emptyRoot, { recursive: true, force: true });
  await ctx.cleanup();
});

describe("the client manifests this build ships", () => {
  it("carries the sync client", () => {
    expect(CLIENT_MANIFESTS.map((c) => c.name)).toContain("marfa/sync");
  });

  it("credits Marfa for the clients Marfa ships", () => {
    // `publisher` is the handle of whoever wrote it and is accountable, and
    // Marfa's is `marfa`. `withmarfa` is the GitHub organization and the npm
    // scope, taken because `marfa` was unavailable on both, and it names no
    // handle anybody holds here.
    //
    // Worth stating precisely, because the obvious summary is backwards:
    // `marfa` is the value `isValidHandle` **refuses**, being a reserved
    // root and a reserved word, and `withmarfa` is the one it accepts. The
    // platform reserves its own name rather than leaving it claimable, and
    // its own integrations live under it by the same exception
    // `isValidIntegrationIdentifier` already makes. So the value here is
    // right and the reason is the opposite of "one is a handle and the
    // other is not".
    //
    // This manifest said `withmarfa` while the fourteen arriving from
    // withmarfa/integrations were corrected, which would have left one row
    // of the catalog's fifteen crediting the organization. The check
    // holding those fourteen lives in that repository and cannot see this
    // one, so each side asserts the rule rather than assuming it carries.
    //
    // Unconditional, unlike that one, and the difference is deliberate: a
    // client manifest ships with this build, so every entry here is by
    // definition ours. The integrations rule is keyed on the registry's
    // `shippedByMarfa` because a contributor's integration is not. If a
    // client manifest somebody else wrote ever ships here, this needs the
    // same discriminator.
    expect(CLIENT_MANIFESTS.length).toBeGreaterThan(0);
    for (const client of CLIENT_MANIFESTS) {
      expect(
        client.manifest.publisher,
        `${client.name} credits "${client.manifest.publisher}"`,
      ).toBe("marfa");
    }
  });

  it("validates every one against the manifest schema", () => {
    // A discovered manifest is validated as it is loaded. One that ships
    // with the build never passes through that loader, so nothing else would catch a
    // manifest the catalog will refuse at boot.
    for (const client of CLIENT_MANIFESTS) {
      const result = IntegrationManifestSchema.safeParse(client.manifest);
      expect(result.success, `${client.name} failed validation`).toBe(true);
      expect(client.name).toBe(client.manifest.name);
    }
  });
});

describe("the boot-time catalog reconcile", () => {
  it("registers the sync manifest from an integrations directory that holds nothing", async () => {
    const outcome = await reconcileShippedCatalog(ctx.storage, {
      integrationsRoot: emptyRoot,
    });

    expect(outcome.rootUnresolved).toBe(false);
    expect(outcome.result.failed).toEqual([]);
    expect(
      [...outcome.result.registered, ...outcome.result.alreadyPresent].map(
        (r) => r.name,
      ),
    ).toContain("marfa/sync");

    const row = await findCatalogRow(
      ctx.storage,
      "marfa/sync",
      syncVersion(),
      undefined,
    );
    expect(row).toBeDefined();
  });

  it("still registers it when the integrations root cannot be resolved at all", async () => {
    // A deployment that cannot find its integrations still knows about its
    // own clients: their manifests need no directory. The unresolvable root
    // is reported rather than swallowed, because half a catalog silently is
    // the failure this whole area exists against.
    const outcome = await reconcileShippedCatalog(ctx.storage, {
      integrationsRoot: null,
    });

    expect(outcome.rootUnresolved).toBe(true);
    expect(
      [...outcome.result.registered, ...outcome.result.alreadyPresent].map(
        (r) => r.name,
      ),
    ).toContain("marfa/sync");
  });
});

describe("a name that reaches the catalog from both sources", () => {
  it("is refused rather than resolved by array order", async () => {
    // Unreachable today: nothing in the integrations directory declares a
    // client's name. It is guarded because the union is permanent
    // structure. Registration keys on (name, version), so a collision
    // produces no duplicate row and no error either — whichever entry the
    // array ordered first wins and the other lands in `alreadyPresent`,
    // leaving the deployment running against a declared surface nobody
    // chose and nothing saying so.
    const root = mkdtempSync(join(tmpdir(), "marfa-collision-"));
    try {
      // A bare .js under a temp dir is CommonJS to Node, and the loader
      // would record a syntax error rather than the collision under test.
      writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
      // `<namespace>/<name>`, mirroring the manifest identifier the collision
      // is about, which is also the only shape discovery reports.
      const dist = join(root, "marfa", "sync", "dist");
      mkdirSync(dist, { recursive: true });
      // The real manifest, so the entry is one the loader accepts and the
      // collision is the only thing wrong with it.
      writeFileSync(
        join(dist, "manifest.js"),
        `export const SYNC_MANIFEST = ${JSON.stringify(
          CLIENT_MANIFESTS[0]?.manifest,
        )};\n`,
      );

      const outcome = await reconcileShippedCatalog(ctx.storage, {
        integrationsRoot: root,
      });

      expect(outcome.result.failed.map((f) => f.name)).toContain("marfa/sync");
      expect(outcome.result.failed[0]?.reason).toContain(
        "from the manifests this build ships",
      );
      // Neither side wins, which is the point: a deployment told what is
      // missing can fix it, one silently running the other cannot.
      expect(outcome.result.registered.map((r) => r.name)).not.toContain(
        "marfa/sync",
      );
      expect(outcome.result.alreadyPresent.map((r) => r.name)).not.toContain(
        "marfa/sync",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function syncVersion(): string {
  const sync = CLIENT_MANIFESTS.find((c) => c.name === "marfa/sync");
  if (!sync) throw new Error("no sync client manifest to assert against");
  return sync.manifest.version;
}
