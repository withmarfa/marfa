import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, request, type TestContext } from "../test-utils.js";

let ctx: TestContext;
const target = "user.target";
const reader = "user.reader";
const parent = "user.parent";
const fields = { title: { type: "string" } };

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.cleanup();
});

function write(method: string, path: string, body?: unknown) {
  return request(ctx.app, method, path, { key: ctx.workingKey, body });
}
async function register(body: unknown) {
  expect((await write("POST", "/types", body)).status).toBe(201);
}

describe("registration dependents", () => {
  it.each(["target", "target ancestor", "reader ancestor"])(
    "refuses a replacement that breaks compatibility through the %s",
    async (changed) => {
      await register({ id: parent, fields });
      await register({
        id: target,
        fields: changed === "target ancestor" ? {} : fields,
        ...(changed === "target ancestor" ? { parent } : {}),
      });
      await register({
        id: reader,
        fields: changed === "reader ancestor" ? {} : fields,
        ...(changed === "reader ancestor" ? { parent } : {}),
        compatible_with: [target],
      });
      const id = changed === "target" ? target : parent;
      const before = await (await write("GET", `/types/${id}`)).json();
      const response = await write("PUT", `/types/${id}`, {
        fields: { title: { type: "integer" } },
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: {
          code: "compatible_with_violation",
          details: { dependent_type_ids: [reader] },
        },
      });
      expect(await (await write("GET", `/types/${id}`)).json()).toEqual(before);
      expect((await write("PUT", `/types/${reader}`, { fields })).status).toBe(
        200,
      );
      expect(
        (
          await write("PUT", `/types/${id}`, {
            fields: { title: { type: "integer" } },
          })
        ).status,
      ).toBe(200);
    },
  );

  it.each(["", "?force=true"])(
    "refuses deleting a compatibility target%s",
    async (query) => {
      await register({ id: target, fields });
      await register({ id: reader, fields, compatible_with: [target] });
      const response = await write("DELETE", `/types/${target}${query}`);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: {
          code: "compatible_with_violation",
          details: { dependent_type_ids: [reader] },
        },
      });
      expect((await write("GET", `/types/${target}`)).status).toBe(200);
      expect((await write("PUT", `/types/${reader}`, { fields })).status).toBe(
        200,
      );
      expect((await write("DELETE", `/types/${target}${query}`)).status).toBe(
        200,
      );
    },
  );
});
