import { afterAll, describe, expect, it } from "vitest";
import { oauthPrincipal } from "../middleware/auth.js";
import {
  closeTestContexts,
  createTestContext,
  type TestContext,
} from "../test-utils.js";
import { writeItem } from "./item-write.js";

const contexts: TestContext[] = [];
async function context() {
  const ctx = await createTestContext();
  contexts.push(ctx);
  return ctx;
}
afterAll(() => closeTestContexts(contexts));

function appPrincipal(clientId: string) {
  const principal = oauthPrincipal({
    id: `token-${clientId}`,
    clientId,
    userId: "Q2xYvR8mKp4TnW6aBc0dEf1gHi3jKl5M",
    scopes: ["core.note:write"],
    expiresAtMs: null,
    createdAtMs: null,
  });
  if (!principal) throw new Error("no principal");
  return principal;
}

async function noteBy(ctx: TestContext, clientId: string): Promise<string> {
  const key = appPrincipal(clientId);
  const created = await writeItem(
    ctx.storage,
    { kind: "credential", key },
    { op: "put", door: "item", type: "core.note", properties: { body: "a" } },
  );
  if (created.outcome !== "created") throw new Error(created.outcome);
  const id = created.item.id;
  await writeItem(
    ctx.storage,
    { kind: "credential", key },
    { op: "update", id, version: 1, properties: { body: "b" } },
  );
  return id;
}

describe("an app whose sign-in record is gone", () => {
  it("still writes, named by its client id and its registered name", async () => {
    const ctx = await context();
    await ctx.storage.oauthProvider!.createClient({
      clientId: "client-with-no-record",
      name: "Registered name",
      isPublic: true,
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none",
      scopes: null,
      redirectUris: ["http://127.0.0.1:9/callback"],
    });
    const id = await noteBy(ctx, "client-with-no-record");
    const [snapshot] = await ctx.storage.versions.all(id);
    expect(snapshot!.writer).toEqual({
      kind: "app",
      id: "client-with-no-record",
      name: "Registered name",
    });
  });

  it("is named by its client id where no client is registered either", async () => {
    const ctx = await context();
    const id = await noteBy(ctx, "unregistered-client");
    const [snapshot] = await ctx.storage.versions.all(id);
    expect(snapshot!.writer).toEqual({
      kind: "app",
      id: "unregistered-client",
      name: "unregistered-client",
    });
  });
});

describe("a request carrying both a key and the owner's cookie", () => {
  it("is written by the key, whose token is the credential checked", async () => {
    const ctx = await context();
    // The witness: the cookie alone is the owner's live browser session.
    const listed = await ctx.ownerRequest("/owner/sign-ins");
    expect(listed.status).toBe(200);
    const keys = await ctx.storage.keys.list();
    const both = (path: string, method: string, body: unknown) =>
      ctx.ownerRequest(path, {
        method,
        headers: {
          authorization: `Bearer ${ctx.workingKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const created = await both("/items", "POST", {
      type: "core.note",
      properties: { body: "a" },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const id = ((await created.json()) as { item: { id: string } }).item.id;
    const changed = await both(`/items/${id}`, "PATCH", {
      version: 1,
      properties: { body: "b" },
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    const [snapshot] = await ctx.storage.versions.all(id);
    expect(snapshot!.writer?.kind).toBe("key");
    expect(keys.map((key) => key.id)).toContain(snapshot!.writer?.id);
  });
});
