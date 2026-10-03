import { afterEach, expect, it, vi } from "vitest";
import { Server } from "node:http";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createClient } from "@libsql/client";
import {
  edgeNameHolder,
  validateProperties,
  type TypeSchema,
} from "@withmarfa/shared";
import { createTestContext } from "../../test-utils.js";

afterEach(() => vi.restoreAllMocks());

it("ordinary TCP registration reads and inherited validation follow commit and removal", async () => {
  const ctx = await createTestContext();
  const observer = createClient({ url: `file:${join(ctx.tmpDir, "test.db")}` });
  const server = serve({
    fetch: ctx.app.fetch,
    port: 0,
    hostname: "127.0.0.1",
  });
  if (!server.listening)
    await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("server has no TCP address");
  const url = `http://127.0.0.1:${String(address.port)}`;
  const headers = {
    Authorization: `Bearer ${ctx.workingKey}`,
    "content-type": "application/json",
  };
  const call = (method: string, path: string, body?: unknown) =>
    fetch(url + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const parent: TypeSchema = {
    id: "example.tcp_parent",
    label: "Parent",
    version: 1,
    roles: ["container"],
    fields: { inherited: { type: "string", required: true } },
  };
  const child: TypeSchema = {
    id: "other.tcp_child",
    parent: parent.id,
    version: 1,
    fields: {},
  };
  const changed = {
    ...parent,
    version: 2,
    fields: {
      ...parent.fields,
      mandatory: { type: "string" as const, required: true },
    },
  };
  const edge = "example.tcp-edge",
    reverse = "example.tcp-reverse";
  const successes: number[] = [];
  let release: () => void = () => undefined;
  let update: Promise<Response> | undefined;
  try {
    for (const schema of [parent, child]) {
      const created = await call("POST", "/types", schema);
      expect(created.status, await created.clone().text()).toBe(201);
      successes.push(created.status);
      await created.body?.cancel();
    }
    const item = await call("POST", "/items", {
      type: child.id,
      properties: { inherited: "value" },
    });
    expect(item.status).toBe(201);
    const itemBody = (await item.json()) as {
      item: { id: string; version: number };
    };
    expect(validateProperties(child.id, { inherited: "value" }).success).toBe(
      true,
    );
    expect(
      validateProperties(child.id, { inherited: "value" }, { strict: true })
        .success,
    ).toBe(true);
    const createdEdge = await call("POST", "/edge-types", {
      id: edge,
      cardinality: "many-to-many",
      reverse_name: reverse,
      source_type_constraints: ["role:container"],
      target_type_constraints: [parent.id],
    });
    expect(createdEdge.status).toBe(201);
    await createdEdge.body?.cancel();
    expect(edgeNameHolder(reverse)).toBe(edge);
    let arrived: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = ctx.storage.types.update.bind(ctx.storage.types);
    vi.spyOn(ctx.storage.types, "update").mockImplementationOnce(
      async (id, schema) => {
        const result = await original(id, schema);
        expect(
          validateProperties(child.id, { inherited: "value" }).success,
        ).toBe(false);
        arrived();
        await blocked;
        return result;
      },
    );
    update = call("PUT", `/types/${parent.id}`, {
      version: 2,
      roles: parent.roles,
      label: parent.label,
      fields: changed.fields,
    });
    await reached;
    const outside = await call("GET", `/types/${parent.id}`);
    expect(outside.status).toBe(200);
    expect(((await outside.json()) as TypeSchema).version).toBe(1);
    const durableBefore = await observer.execute({
      sql: "SELECT schema FROM types WHERE id = ?",
      args: [parent.id],
    });
    expect(JSON.parse(durableBefore.rows[0]!.schema as string)).toEqual(parent);
    expect(validateProperties(child.id, { inherited: "value" }).success).toBe(
      true,
    );
    expect(
      validateProperties(child.id, { inherited: "value" }, { strict: true })
        .success,
    ).toBe(true);
    release();
    const updated = await update;
    expect(updated.status, await updated.clone().text()).toBe(200);
    await updated.body?.cancel();
    const durableAfter = await observer.execute({
      sql: "SELECT schema FROM types WHERE id = ?",
      args: [parent.id],
    });
    expect(JSON.parse(durableAfter.rows[0]!.schema as string)).toEqual(changed);
    const missing = await call("POST", "/items", {
      type: child.id,
      properties: { inherited: "value" },
    });
    expect(missing.status).toBe(400);
    expect(
      ((await missing.json()) as { error: { code: string } }).error.code,
    ).toBe("invalid_properties");
    const valid = await call("POST", "/items", {
      type: child.id,
      properties: { inherited: "value", mandatory: "present" },
    });
    expect(valid.status).toBe(201);
    const validBody = (await valid.json()) as {
      item: { id: string; version: number };
    };
    const readBack = await call("GET", `/items/${validBody.item.id}`);
    expect(readBack.status).toBe(200);
    expect(
      (
        (await readBack.json()) as {
          item: { properties: Record<string, string> };
        }
      ).item.properties,
    ).toEqual({ inherited: "value", mandatory: "present" });
    const old = await call("GET", `/items/${itemBody.item.id}`);
    expect(old.status).toBe(200);
    expect(
      ((await old.json()) as { item: { version: number } }).item.version,
    ).toBe(1);
    const deletedEdge = await call("DELETE", `/edge-types/${edge}`);
    expect(deletedEdge.status).toBe(200);
    await deletedEdge.body?.cancel();
    expect(edgeNameHolder(reverse)).toBeUndefined();
    const edgeRows = await observer.execute({
      sql: "SELECT id FROM edge_types WHERE id = ?",
      args: [edge],
    });
    expect(edgeRows.rows).toEqual([]);
    const deleted = await call("DELETE", `/types/${child.id}?force=true`);
    expect(deleted.status).toBe(200);
    await deleted.body?.cancel();
    const absent = await call("GET", `/types/${child.id}`);
    expect(absent.status).toBe(404);
    await absent.body?.cancel();
    const typeRows = await observer.execute({
      sql: "SELECT id FROM types WHERE id = ?",
      args: [child.id],
    });
    expect(typeRows.rows).toEqual([]);
    console.log(
      "REGISTRY_TCP",
      JSON.stringify({
        registration: successes,
        outsideVersion: 1,
        committedVersion: 2,
        invalidWrite: 400,
        validWrite: 201,
        oldItemVersion: 1,
        removedType: child.id,
        removedEdge: edge,
      }),
    );
  } finally {
    release();
    await update?.catch(() => undefined);
    if (server instanceof Server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
    observer.close();
    await ctx.cleanup();
  }
});
