import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { cleanup, createTestContext, trackType } from "../../utils/setup.js";
import { marfa, NO_KEYCHAIN, refusal } from "./types-scaffold.shared.js";

/**
 * "A starting definition, registered by a key that may."
 *
 * Run against a real server and the real binary: what `types scaffold` prints
 * is sent unchanged by `types register`.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
beforeAll(async () => {
  ({ client, ctx, apiUrl } = await createTestContext(
    "device",
    "types-scaffold",
  ));
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
});

const named = (key: string) => ({
  ...NO_KEYCHAIN,
  MARFA_API_URL: apiUrl,
  MARFA_API_KEY: key,
});

/** A type id of this run's own. */
const idOf = (name: string) =>
  `user.${name}_${ctx.runId.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;

describe("a starting definition, registered", () => {
  it("is registered unchanged by a key that may register its id, and by no other", async () => {
    const id = idOf("scaffolded");
    const parent = idOf("scaffolded_base");
    const printedParent = await marfa(
      ["types", "scaffold", parent, "--field", "title:string"],
      NO_KEYCHAIN,
    );
    expect(printedParent.code, printedParent.stderr).toBe(0);
    const printed = await marfa(
      [
        "types",
        "scaffold",
        id,
        "--parent",
        parent,
        "--description",
        "A scaffolded type",
        "--field",
        "name:string",
        "--field",
        "servings:integer",
        "--field",
        "effort:enum:easy,hard",
        "--field",
        "sources:array:url",
        "--field",
        "born:datetime",
        "--field",
        "details:object",
        "--field",
        "cover:thumbnail",
        "--required",
        "name",
      ],
      NO_KEYCHAIN,
    );
    expect(printed.code, printed.stderr).toBe(0);
    const definition = JSON.parse(printed.stdout) as {
      fields: Record<string, unknown>;
    };

    // Witness: a key without the permission to register is refused the same
    // definition, so the success below is the permission and not an open door.
    const narrow = await client.createKey({
      label: `${ctx.source}-no-register`,
      source: `${ctx.source}-no-register`,
      default_tier: "library",
      type_permissions: { [id]: "write", [parent]: "write" },
    });
    expect(narrow.ok, JSON.stringify(narrow.error)).toBe(true);
    ctx.trackedKeys.push(narrow.data.id);
    const forbidden = await marfa(
      ["--json", "types", "register", "--body", printedParent.stdout],
      named(narrow.data.key),
    );
    expect(forbidden.code, forbidden.stdout).toBe(1);
    expect(refusal(forbidden).error.code).toBe("forbidden");

    const mayRegister = await client.createKey({
      label: `${ctx.source}-register`,
      source: `${ctx.source}-register`,
      default_tier: "library",
      type_permissions: { [id]: "write", [parent]: "write" },
      metadata_permissions: { types: "write" },
    });
    expect(mayRegister.ok, JSON.stringify(mayRegister.error)).toBe(true);
    ctx.trackedKeys.push(mayRegister.data.id);
    for (const text of [printedParent.stdout, printed.stdout]) {
      const registered = await marfa(
        ["--json", "types", "register", "--body", text],
        named(mayRegister.data.key),
      );
      expect(registered.code, registered.stderr).toBe(0);
    }
    trackType(ctx, parent, client);
    trackType(ctx, id, client, parent);

    const read = await client.getType(id);
    expect(read.ok, JSON.stringify(read.error)).toBe(true);
    expect(read.data.parent).toBe(parent);
    expect(read.data.description).toBe("A scaffolded type");
    for (const [name, field] of Object.entries(definition.fields)) {
      expect(read.data.fields[name], name).toMatchObject(
        field as Record<string, unknown>,
      );
    }
  });
});
