/**
 * A shipped type does not overwrite a registration this instance already owns.
 *
 * **The two live in the same primary-key bucket, which is the whole defect.**
 * `POST /types` stores at `space_id: spaceId ?? ""`, and under `AUTH_MODE=keys`
 * — every self-host — a credential carries no space, so a self-hoster's own
 * type lands exactly where the seed writes. A build that started shipping an
 * identifier somebody had already registered rewrote their schema on the next
 * boot, flipped `origin` from `user` to `platform`, and stamped a family.
 *
 * Every mechanism that would have surfaced it was disabled by the same write:
 * `listCustom` filters `origin != 'platform'`, so the type left their own
 * registrations and their archive export; `isLockedPlatformType` then refused
 * both `PUT` and `DELETE`; and `computePlatformDrift` could never report it,
 * because afterwards the row genuinely matched a shipped id.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { TypeSchema } from "@withmarfa/shared";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.cleanup();
});

/** A shipped id, spelled as a self-hoster's own registration would be. */
const CONTESTED = "user.collides";

async function registerLocally() {
  await ctx.storage.types.create(
    {
      id: CONTESTED,
      label: "Mine",
      version: 1,
      fields: { note: { type: "string" } },
    },
    undefined,
  );
}

describe("seedPlatformTypes leaves a registration it did not write", () => {
  it("keeps the local schema and reports the collision", async () => {
    await registerLocally();

    const collided = await ctx.storage.types.seedPlatformTypes([
      {
        schema: {
          id: CONTESTED,
          label: "Shipped",
          version: 1,
          fields: { shipped: { type: "string" } },
        },
        family: "core",
      },
    ]);

    expect(collided).toEqual([CONTESTED]);

    // The operator's row is untouched on every axis the overwrite moved.
    const rows = await ctx.storage.types.loadCustomTypes();
    const row = rows.find((r) => r.schema.id === CONTESTED);
    expect(row?.origin).toBe("user");
    expect(Object.keys(row?.schema.fields ?? {})).toEqual(["note"]);

    // And it is still theirs: `listCustom` filters `origin != 'platform'`, so
    // an overwritten row would vanish from their own registrations and from
    // the archive export built on them.
    expect((await ctx.storage.types.listCustom()).map((t) => t.id)).toContain(
      CONTESTED,
    );
  });

  it("still updates a row the seed itself wrote, which is what the upsert is for", async () => {
    // The guard has to refuse the right rows rather than all of them: a
    // redeploy carrying a changed shipped schema must still move its own row,
    // or the instance keeps resolving whatever it was first seeded with.
    const seeded = (fields: TypeSchema["fields"]) => [
      {
        schema: { id: "core.seeded-probe", label: "Probe", version: 1, fields },
        family: "core" as const,
      },
    ];

    expect(
      await ctx.storage.types.seedPlatformTypes(
        seeded({ a: { type: "string" } }),
      ),
    ).toEqual([]);
    expect(
      await ctx.storage.types.seedPlatformTypes(
        seeded({ b: { type: "string" } }),
      ),
    ).toEqual([]);

    const rows = await ctx.storage.types.loadCustomTypes();
    const row = rows.find((r) => r.schema.id === "core.seeded-probe");
    expect(row?.origin).toBe("platform");
    expect(Object.keys(row?.schema.fields ?? {})).toEqual(["b"]);
  });

  it("reports nothing when no shipped id is contested", async () => {
    expect(
      await ctx.storage.types.seedPlatformTypes([
        {
          schema: {
            id: "core.uncontested",
            label: "Fine",
            version: 1,
            fields: { a: { type: "string" } },
          },
          family: "core",
        },
      ]),
    ).toEqual([]);
  });
});
