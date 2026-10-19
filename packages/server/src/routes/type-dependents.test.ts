import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestContext,
  mintWorkingKey,
  request,
  type TestContext,
} from "../test-utils.js";

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
  it.each([
    { compatible_with: [target] },
    { parent: target },
    { parent: target, display_hints: { title_field: "title" } },
    { parent: target, link_field: "title" },
    { parent: target, merge_policy: { fields: { title: "last_writer_wins" } } },
  ])(
    "requires target write permission to add or keep %j",
    async (dependency) => {
      await register({ id: target, fields });
      const id = "foreign.reader";
      const key = await mintWorkingKey(ctx, {
        permissions: ["schema.write"],
        metadata_permissions: { types: "write" },
        type_permissions: { "foreign.*": "write", [target]: "read" },
      });
      const schema = { fields: dependency.parent ? {} : fields, ...dependency };
      const refusedParent = await request(ctx.app, "POST", "/types", {
        key,
        body: { id, fields: {}, parent: target },
      });
      expect(refusedParent.status).toBe(403);
      const expected = await refusedParent.json();
      const denied = async (method: string, path: string, body: unknown) => {
        const res = await request(ctx.app, method, path, { key, body });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual(expected);
      };
      await denied("POST", "/types", { id, ...schema });
      expect((await write("GET", `/types/${id}`)).status).toBe(404);
      await register({ id, fields });
      const before = await (await write("GET", `/types/${id}`)).json();
      await denied("PUT", `/types/${id}`, schema);
      expect(await (await write("GET", `/types/${id}`)).json()).toEqual(before);
      expect((await write("PUT", `/types/${id}`, schema)).status).toBe(200);
      await denied("PUT", `/types/${id}`, { ...schema, label: "Kept claim" });
      // Removing the dependency needs no authority over its former target.
      expect(
        (
          await request(ctx.app, "PUT", `/types/${id}`, {
            key,
            body: { fields },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await write("PUT", `/types/${target}`, {
            fields: { title: { type: "integer" } },
          })
        ).status,
      ).toBe(200);
      expect((await write("DELETE", `/types/${target}`)).status).toBe(200);
    },
  );

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
