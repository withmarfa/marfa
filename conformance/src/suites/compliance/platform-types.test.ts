import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  getOperatorClient,
  cleanup,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let operator: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "platform-types",
  ));
  operator = getOperatorClient();
});

afterAll(async () => {
  await cleanup(ctx);
});

/**
 * A drifted row is a platform type the database holds and the build no
 * longer ships. Nothing over the wire can register a platform type, so a
 * drifted row is arranged on a server of its own in
 * `platform-type-drift.test.ts`; the shared server's listing and the
 * refusals that need none are asserted here.
 */
describe("platform type maintenance", () => {
  it("lists no drift on an instance whose platform types match the build", async () => {
    const r = await operator.listPlatformTypeDrift();
    expect(r.ok).toBe(true);
    await expectMatchesSchema("GET", "/platform-types/drift", 200, r.data);
    expect(r.data.data).toEqual([]);
  });

  it("serves no type named by a word the glossary bans", async () => {
    // The seed upserts and never prunes, so a platform type a build stops
    // shipping keeps resolving and listing on an instance an earlier build
    // seeded. This instance is seeded by this build, so the listing is the
    // shipped set and the banned identifier must be absent from it, which
    // reddens if one is ever put back into the shipped catalog: the only
    // half of the problem a black-box run can reach.
    const listed = await client.listTypes();
    expect(listed.ok).toBe(true);
    const ids = listed.data.data.map((t) => t.id);
    expect(ids).toContain("system.connection");
    expect(ids).not.toContain("system.integration");
    const missing = await client.getType("system.integration");
    expect(missing.status).toBe(404);
    expect(missing.error?.error.code).toBe("type_not_found");
  });

  it("refuses the listing to a working key and to no credential", async () => {
    const working = await client.listPlatformTypeDrift();
    expect(working.status).toBe(403);
    expect(working.error?.error.code).toBe("forbidden");
    const anonymous = new MarfaClient({ baseUrl: apiUrl, apiKey: "" });
    expect((await anonymous.listPlatformTypeDrift()).status).toBe(401);
  });

  it("refuses to remove a type the build still ships", async () => {
    const r = await operator.deletePlatformType("core.note");
    expect(r.status).toBe(409);
    expect(r.error?.error.code).toBe("conflict");
    expect(r.error?.error.details?.type).toBe("core.note");
    const still = await client.getType("core.note");
    expect(still.ok).toBe(true);
  });

  it("answers 404 for an identifier no platform row carries", async () => {
    // Two different refusals, told apart. An identifier no row carries is
    // absent, and a refusal names its reason: `404`. The `409` beside it
    // is for an identifier a row does carry and the build still ships,
    // which is a refusal about the state of the row rather than about
    // whether there is one.
    const r = await operator.deletePlatformType("core.never-existed");
    expect(r.status).toBe(404);
    expect(r.error?.error.code).toBe("type_not_found");
  });

  it("answers 409 for a type registered at run time, which no platform row carries", async () => {
    const id = `user.platform-door-${ctx.runId}`;
    const registered = await client.registerType({
      id,
      fields: { name: { type: "string" } },
    });
    expect(registered.status).toBe(201);

    const r = await operator.deletePlatformType(id);
    expect(r.status).toBe(409);
    expect(r.error?.error.code).toBe("conflict");
    expect(r.error?.error.details?.type).toBe(id);
    // The witness: an identifier no row carries is the `404` beside it, and
    // the registration is still there after the refusal.
    const absent = await operator.deletePlatformType(
      `user.platform-door-absent-${ctx.runId}`,
    );
    expect(absent.status).toBe(404);
    expect((await client.getType(id)).status).toBe(200);
  });

  it("refuses removal to a working key", async () => {
    const r = await client.deletePlatformType("core.note");
    expect(r.status).toBe(403);
    expect(r.error?.error.code).toBe("forbidden");
  });
});
