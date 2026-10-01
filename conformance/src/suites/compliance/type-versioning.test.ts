/**
 * Conformance for a type's version at PUT /types.
 *
 * A replacement keeps whatever version it is given, 0 where it names none,
 * and no change to the schema demands that the version move.
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
    fields: {
      body: { type: "string", required: true },
      title: { type: "string" },
    },
  };
  const r = await client.registerType(initial);
  expect(r.ok).toBe(true);
  expect(r.data?.type.version).toBe(0);
  return initial;
}

describe("PUT /types and a type's version", () => {
  it("refuses a malformed identifier and a schema the validator refuses with 400", async () => {
    const typeId = `user.versioning-shape-${ctx.runId}`;
    const initial = await registerInitial(typeId);

    const malformed = await client.updateType("not a type id", initial);
    expect(malformed.status).toBe(400);
    expect(malformed.error?.error.code).toBe("validation_error");

    const wrongShape = await client.updateType(typeId, {
      ...initial,
      fields: { body: { type: "not-a-field-type" } },
    } as unknown as TypeSchema);
    expect(wrongShape.status).toBe(400);
    expect(wrongShape.error?.error.code).toBe("invalid_schema");
  });

  it("registers a type that names no version at 0", async () => {
    await registerInitial(`user.versioning-unnamed-${ctx.runId}`);
  });

  it("replaces a type at the version it already holds, whatever the change", async () => {
    const typeId = `user.versioning-unbumped-${ctx.runId}`;
    const initial = await registerInitial(typeId);

    const steps: { label: string; schema: TypeSchema }[] = [
      { label: "resubmitted unchanged", schema: initial },
      {
        label: "a field added",
        schema: {
          ...initial,
          fields: { ...initial.fields, note: { type: "string" } },
        },
      },
      {
        label: "a field removed",
        schema: {
          ...initial,
          fields: { body: { type: "string", required: true } },
        },
      },
      {
        label: "relabeled",
        schema: {
          ...initial,
          label: "Relabeled",
          fields: { body: { type: "string", required: true } },
        },
      },
    ];
    for (const { label, schema } of steps) {
      const r = await client.updateType(typeId, { ...schema, version: 0 });
      expect(r.status, label).toBe(200);
      expect(r.data?.type.version, label).toBe(0);
      expect(Object.keys(r.data?.type.fields ?? {}), label).toEqual(
        Object.keys(schema.fields),
      );
    }
  });

  it("keeps the version a replacement names, and 0 where it names none", async () => {
    const typeId = `user.versioning-given-${ctx.runId}`;
    const initial = await registerInitial(typeId);

    const named = await client.updateType(typeId, { ...initial, version: 3 });
    expect(named.status).toBe(200);
    expect(named.data?.type.version).toBe(3);

    const unnamed = await client.updateType(typeId, initial);
    expect(unnamed.status).toBe(200);
    expect(unnamed.data?.type.version).toBe(0);
  });
});
