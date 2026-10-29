import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InstanceDescriptionSchema } from "./instance-description.js";
import {
  renderConsentScreen,
  renderDeviceConsentScreen,
} from "./test-render.js";
import { createApp } from "../app.js";
import {
  createTestContext,
  mintWorkingKey,
  request,
  type TestContext,
  cleanupTestContext,
} from "../test-utils.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await cleanupTestContext(ctx);
});
const root = async () =>
  (await (await ctx.app.request("/")).json()) as {
    name: string;
    instance_id: string;
  };
const put = (body: Record<string, unknown>, key = ctx.workingKey) =>
  request(ctx.app, "PUT", "/config", { key, body });

describe("the instance display name", () => {
  it("defaults to Marfa, persists a trimmed Unicode name alongside other configuration, and resets on replacement", async () => {
    const before = await root();
    expect(before.name).toBe("Marfa");
    const saved = await put({
      name: "  Maison 東京 🌱  ",
      audit_retention_days: 31,
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      name: "Maison 東京 🌱",
      audit_retention_days: 31,
      instance_id: before.instance_id,
    });
    expect(await root()).toMatchObject({
      name: "Maison 東京 🌱",
      instance_id: before.instance_id,
    });
    const rebuilt = createApp(
      ctx.storage,
      ctx.blobs,
      ctx.housekeeping,
      ctx.config,
      before.instance_id,
    );
    expect(await (await rebuilt.request("/")).json()).toMatchObject({
      name: "Maison 東京 🌱",
      instance_id: before.instance_id,
    });
    const reset = await put({ audit_retention_days: 31 });
    expect(reset.status).toBe(200);
    expect(await root()).toEqual({ ...before, name: "Marfa" });
  });
  it("accepts arbitrary names in the description schema and escapes approval labels", async () => {
    const name = '<img src=x onerror="throw 1"> & Library';
    const response = await ctx.app.request("/");
    const description = (await response.json()) as Record<string, unknown>;
    expect(
      InstanceDescriptionSchema.safeParse({ ...description, name }).success,
    ).toBe(true);
    for (const html of [
      renderConsentScreen({
        instanceName: name,
        clientName: "Reader",
        clientId: "reader",
        oauthQuery: "",
        scopes: [],
      }),
      renderDeviceConsentScreen({
        instanceName: name,
        clientName: "Reader",
        userCode: "ABCD-1234",
        scopes: [],
      }),
    ]) {
      expect(html).toContain(
        "&lt;img src=x onerror=&quot;throw 1&quot;&gt; &amp; Library",
      );
      expect(html).not.toContain(name);
    }
  });
  it("uses config.manage and direct owner authority, refusing a key without permission", async () => {
    expect(
      (await put({ name: "No permission" }, ctx.managementKey)).status,
    ).toBe(403);
    const owner = await ctx.ownerRequest("/config", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        origin: new URL(ctx.config.authBaseUrl).origin,
      },
      body: JSON.stringify({ name: "Owner's library" }),
    });
    expect(owner.status).toBe(200);
    expect((await root()).name).toBe("Owner's library");
    const delegated = await mintWorkingKey(ctx, {
      type_permissions: {},
      extension_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
      profile_permissions: {},
      permissions: ["config.manage"],
    });
    expect((await put({ name: "Delegated library" }, delegated)).status).toBe(
      200,
    );
  });
  it("allows local process authority to replace the name", async () => {
    const identity = (await root()).instance_id;
    const local = createApp(
      ctx.storage,
      ctx.blobs,
      ctx.housekeeping,
      ctx.config,
      identity,
      { localAuthority: true },
    );
    const saved = await local.request("/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Local library" }),
    });
    expect(saved.status).toBe(200);
    expect((await root()).name).toBe("Local library");
  });
  it("refuses invalid names without replacing the stored configuration", async () => {
    await put({ name: "Kept", audit_retention_days: 31 });
    for (const name of [
      "",
      "   ",
      "x".repeat(201),
      "a\nline",
      "\tname",
      "name\u0000",
      "a\u0085b",
      "a\u202eb",
      "a\u2066b",
      "a\u200eb",
      "a\u061cb",
    ]) {
      const rejected = await put({ name });
      expect(rejected.status, JSON.stringify(name)).toBe(400);
      expect((await root()).name).toBe("Kept");
    }
    expect((await put({ name: "x".repeat(200) })).status).toBe(200);
    expect((await put({ name: "🌱".repeat(200) })).status).toBe(200);
    expect((await put({ name: "🌱".repeat(201) })).status).toBe(400);
  });
  it("escapes the live name on root, sign-in, setup and console pages", async () => {
    const name = '<img src=x onerror="throw 1"> & Library';
    expect((await put({ name })).status).toBe(200);
    for (const path of ["/", "/auth/sign-in", "/setup"]) {
      const response = await ctx.app.request(path, {
        headers: { accept: "text/html" },
      });
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(html, path).toContain(
        "&lt;img src=x onerror=&quot;throw 1&quot;&gt; &amp; Library",
      );
      expect(html, path).not.toContain(name);
    }
    const managed = await ctx.ownerRequest("/auth/owner/export");
    expect(managed.status).toBe(200);
    expect(await managed.text()).toContain(
      "&lt;img src=x onerror=&quot;throw 1&quot;&gt; &amp; Library",
    );
  });
});
