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
 * longer ships. Nothing over the wire can register a platform type, so the
 * removal's success path is unreachable here; the listing and every refusal
 * are asserted.
 */
describe("platform type maintenance", () => {
  it("lists no drift on an instance whose platform types match the build", async () => {
    const r = await operator.listPlatformTypeDrift();
    expect(r.ok).toBe(true);
    await expectMatchesSchema(
      "GET",
      "/admin/platform-types/drift",
      200,
      r.data,
    );
    expect(r.data.types).toEqual([]);
  });

  it("serves no type this repository's vocabulary retired", async () => {
    // A retired platform type is not removed by the build that stops
    // shipping it: the seed upserts and never prunes, so the row keeps
    // resolving and keeps listing on every instance upgraded across the
    // rename. This instance is seeded by this build, so the listing is the
    // shipped set and the retired identifier must be absent from it — which
    // reddens if one is ever put back into the shipped catalog, the only
    // half of the problem a black-box run can reach.
    const listed = await client.listTypes();
    expect(listed.ok).toBe(true);
    const ids = listed.data.map((t) => t.id);
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
    const r = await operator.removePlatformType("core.note");
    expect(r.status).toBe(409);
    expect(r.error?.error.code).toBe("conflict");
    expect(r.error?.error.details?.type).toBe("core.note");
    const still = await client.getType("core.note");
    expect(still.ok).toBe(true);
  });

  it("answers 409 for an identifier no platform row carries", async () => {
    // The document declares 404 for this case; the server answers 409 with
    // the same refusal it gives a shipped type. Recorded in spec/findings.md.
    const r = await operator.removePlatformType("core.never-existed");
    expect(r.status).toBe(409);
    expect(r.error?.error.code).toBe("conflict");
  });

  it("refuses removal to a working key", async () => {
    const r = await client.removePlatformType("core.note");
    expect(r.status).toBe(403);
    expect(r.error?.error.code).toBe("forbidden");
  });
});
