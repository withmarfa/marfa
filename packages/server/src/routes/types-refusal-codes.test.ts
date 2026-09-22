/**
 * What the two type-authoring doors answer a body they cannot take.
 *
 * Their bodies are declared, so the shape check runs before the handler and
 * would answer `validation_error` — a code these doors have never used — to
 * requests the shared validator refused as `invalid_schema`, and would
 * answer at all to requests the credential and the path already refuse.
 * `refuseAsTheValidatorWould` and the routes' middleware are what keep each
 * of those answers where it was, and this is what holds them there.
 *
 * Each case names the code the door answers and nothing about how it got
 * there, because that is the whole of what a caller sees.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
/** A credential that reaches the doors and holds neither write. */
let narrowKey: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const minted = await request(ctx.app, "POST", "/keys", {
    key: ctx.workingKey,
    body: {
      label: "no schema writes",
      source: "types-refusal-codes",
      permissions: [],
      type_permissions: { "*": "read" },
    },
  });
  narrowKey = ((await minted.json()) as { key: string }).key;
});

afterAll(async () => {
  await ctx.cleanup();
});

async function refusal(
  method: "POST" | "PUT",
  path: string,
  body: unknown,
  key = ctx.workingKey,
): Promise<{ status: number; code: string; field?: unknown }> {
  const res = await request(ctx.app, method, path, { key, body });
  const parsed = (await res.json()) as {
    error?: { code?: string; details?: { field?: unknown } };
  };
  return {
    status: res.status,
    code: parsed.error?.code ?? "(none)",
    field: parsed.error?.details?.field,
  };
}

describe("the type doors answer a body they cannot take", () => {
  it("names `fields` when the body does not carry it", async () => {
    expect(await refusal("POST", "/types", {})).toMatchObject({
      status: 400,
      code: "missing_required_field",
      field: "fields",
    });
    expect(
      await refusal("POST", "/types", { id: "user.no-fields" }),
    ).toMatchObject({ code: "missing_required_field", field: "fields" });
    // `null` is a body that does not carry the block, not a block of the
    // wrong shape.
    expect(
      await refusal("POST", "/types", { id: "user.null-fields", fields: null }),
    ).toMatchObject({ code: "missing_required_field", field: "fields" });
  });

  it("answers `invalid_schema` for every other shape it cannot read", async () => {
    const cases: [string, unknown][] = [
      ["no id", { fields: {} }],
      ["a null optional", { id: "user.p1", fields: {}, parent: null }],
      ["a null label", { id: "user.p2", fields: {}, label: null }],
      ["a field that is not an object", { id: "user.p3", fields: { x: null } }],
      [
        "a field type outside the vocabulary",
        { id: "user.p4", fields: { x: { type: "nope" } } },
      ],
      [
        "a version that is not a number",
        { id: "user.p5", fields: {}, version: "1" },
      ],
    ];
    for (const [what, body] of cases) {
      const answered = await refusal("POST", "/types", body);
      expect(answered, what).toMatchObject({
        status: 400,
        code: "invalid_schema",
      });
    }
  });

  it("refuses the credential and the path before it reads the body", async () => {
    // Each of these carries a body the shape check would refuse, and each
    // is answered by the check that runs ahead of it.
    expect(
      await refusal("PUT", "/types/core.note", { version: 99 }),
    ).toMatchObject({
      status: 403,
      code: "core_type_immutable",
    });
    expect(
      await refusal("PUT", "/types/user.does-not-exist", { version: 2 }),
    ).toMatchObject({ status: 404, code: "type_not_found" });
    expect(await refusal("POST", "/types", {}, narrowKey)).toMatchObject({
      status: 403,
      code: "forbidden",
    });
    expect(
      await refusal("PUT", "/types/user.anything", { version: 2 }, narrowKey),
    ).toMatchObject({ status: 403, code: "forbidden" });
  });

  it("takes a body the validator takes, and the shapes it declares loosely", async () => {
    // The mirror of the refusals above: what the door still accepts. A
    // check that only asserted refusals would pass against a door that
    // refused everything.
    const created = await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: {
        id: "user.accepted-shape",
        fields: { title: { type: "string", required: true } },
        // The two forms `compatible_with` takes, the top-level `required`
        // array, and a key inside a policy block that the validator stores
        // whole: each is a body the server accepts, so the declaration must
        // not refuse it.
        required: ["title"],
        version_policy: { recent_days: 3, zzz_unknown: 9 },
        merge_policy: { default: "last_writer_wins", zzz_unknown: 9 },
      },
    });
    expect(created.status).toBe(201);

    const withSibling = await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: {
        id: "user.accepted-sibling",
        fields: { title: { type: "string", required: true } },
        compatible_with: "user.accepted-shape",
      },
    });
    expect(withSibling.status).toBe(201);
  });
});
