/**
 * Conformance for server-side semver-diff at PUT /types.
 *
 * The server applies a structural diff classifier to every type update.
 * Submitting an identical schema is a no-op (rejected). Descriptive-only
 * changes accept the existing version. Additive and breaking diffs require
 * an explicit version bump.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext, TypeSchema } from "../../client/types.js";
import { createTestContext, cleanup } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "type-versioning"));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function registerInitial(typeId: string): Promise<TypeSchema> {
  const initial: TypeSchema = {
    id: typeId,
    label: "Initial",
    version: 1,
    fields: {
      body: { type: "string", required: true },
      title: { type: "string" },
    },
  };
  const r = await client.registerType(initial);
  expect(r.ok).toBe(true);
  return initial;
}

describe("PUT /types semver-diff", () => {
  it("rejects no-op resubmission with version_bump_mismatch", async () => {
    const typeId = `user.versioning-noop-${ctx.runId}`;
    const initial = await registerInitial(typeId);

    const r = await client.updateType(typeId, initial);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(422);
    expect(r.error?.error.code).toBe("version_bump_mismatch");
  });

  it("rejects field removal at the same version", async () => {
    const typeId = `user.versioning-removal-${ctx.runId}`;
    await registerInitial(typeId);

    const next: TypeSchema = {
      id: typeId,
      label: "Initial",
      version: 1,
      fields: {
        body: { type: "string", required: true },
        // title removed — breaking diff requires a major bump.
      },
    };
    const r = await client.updateType(typeId, next);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(422);
    expect(r.error?.error.code).toBe("version_bump_mismatch");
  });

  it("accepts field removal when the version bumps", async () => {
    const typeId = `user.versioning-removal-bump-${ctx.runId}`;
    await registerInitial(typeId);

    const next: TypeSchema = {
      id: typeId,
      label: "Initial",
      version: 2,
      fields: {
        body: { type: "string", required: true },
      },
    };
    const r = await client.updateType(typeId, next);
    expect(r.ok).toBe(true);
  });

  it("accepts descriptive-only changes at the same version", async () => {
    const typeId = `user.versioning-descriptive-${ctx.runId}`;
    await registerInitial(typeId);

    const next: TypeSchema = {
      id: typeId,
      label: "Updated label only",
      version: 1,
      fields: {
        body: { type: "string", required: true },
        title: { type: "string" },
      },
    };
    const r = await client.updateType(typeId, next);
    expect(r.ok).toBe(true);
  });
});
