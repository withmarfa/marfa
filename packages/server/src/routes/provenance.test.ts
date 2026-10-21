import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestContext, request, type TestContext } from "../test-utils.js";
let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.cleanup();
});
it("keeps the creating sign-in apart from a replacement definition", async () => {
  const created = await request(ctx.app, "POST", "/types", {
    key: ctx.workingKey,
    body: { id: "user.provenance", label: "Provenance", fields: {} },
  });
  expect(created.status).toBe(201);
  const read = async () =>
    (await (
      await request(ctx.app, "GET", "/types/user.provenance", {
        key: ctx.workingKey,
      })
    ).json()) as {
      provenance: { created_by: { kind: string; name: string; id: string } };
    };
  const initial = await read();
  expect(initial.provenance.created_by.kind).toBe("key");
  const changed = await request(ctx.app, "PUT", "/types/user.provenance", {
    key: ctx.workingKey,
    body: { ...initial, label: "Changed", fields: {} },
  });
  expect(changed.status).toBe(200);
  expect((await read()).provenance).toEqual(initial.provenance);
  const forged = await request(ctx.app, "PUT", "/types/user.provenance", {
    key: ctx.workingKey,
    body: {
      ...initial,
      fields: {},
      provenance: {
        origin: "platform",
        created_by: { kind: "key", id: "forged", name: "Forged" },
      },
    },
  });
  expect(forged.status).toBe(200);
  expect((await read()).provenance).toEqual(initial.provenance);
  const registration = await request(ctx.app, "POST", "/types", {
    key: ctx.workingKey,
    body: {
      id: "user.forged_creator",
      fields: {},
      provenance: initial.provenance,
    },
  });
  expect(registration.status).toBe(400);
  const page = await ctx.storage.audit.list({
    action: "type.register",
    resource_id: "user.provenance",
  });
  expect(page.data[0]?.actor).toEqual(initial.provenance.created_by);
});
it("retains actor names, distinguishes server work and does not infer old history", async () => {
  const row = (
    await ctx.storage.audit.list({
      action: "type.register",
      resource_id: "user.provenance",
    })
  ).data[0]!;
  expect(row.actor?.kind).toBe("key");
  await ctx.storage.keys.update(row.actor!.id, { label: "A new name" });
  expect(
    (
      await ctx.storage.audit.list({
        resource_id: "user.provenance",
        action: "type.register",
      })
    ).data[0]?.actor,
  ).toEqual(row.actor);
  await ctx.storage.runInTransaction(() =>
    ctx.storage.keys.revoke(row.actor!.id),
  );
  expect(
    (
      await request(ctx.app, "GET", "/types/user.provenance", {
        key: ctx.workingKey,
      })
    ).status,
  ).toBe(401);
  expect(
    (await ctx.storage.types.provenance("user.provenance")).created_by,
  ).toEqual(row.actor);
  await ctx.storage.audit.log({
    action: "test.server",
    resource_type: "test",
    details: { _actor: { kind: "key", id: "forged", name: "Forged" } },
  });
  expect(
    (await ctx.storage.audit.list({ action: "test.server" })).data[0]?.actor,
  ).toEqual({ kind: "server", id: "server", name: "Marfa" });
  const signIn = (
    await ctx.storage.audit.list({ action: "auth.sign_in.success" })
  ).data[0];
  expect(signIn?.actor?.kind).toBe("browser");
  expect(await ctx.storage.types.provenance("core.note")).toEqual({
    origin: "platform",
    created_by: null,
  });
});
it("preserves the creator through a real archive round trip", async () => {
  const target = await createTestContext();
  try {
    const exported = await ctx.ownerRequest("/export?format=archive");
    expect(exported.status).toBe(200);
    const restored = await target.ownerRequest("/restore", {
      method: "POST",
      headers: { "Content-Type": "application/gzip" },
      body: await exported.arrayBuffer(),
    });
    expect(restored.status).toBe(200);
    expect(await target.storage.types.provenance("user.provenance")).toEqual(
      await ctx.storage.types.provenance("user.provenance"),
    );
  } finally {
    await target.cleanup();
  }
});
it("keeps absent historical actors unknown and searches snapshot names literally", async () => {
  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: `file:${ctx.tmpDir}/test.db` });
  try {
    await db.execute({
      sql: "INSERT INTO audit_log (id, created_at, key_id, action, resource_type, details) VALUES (?, ?, ?, ?, ?, ?)",
      args: [
        "old-actor",
        new Date().toISOString(),
        "vanished",
        "test.historical",
        "test",
        "{}",
      ],
    });
    expect(
      (await ctx.storage.audit.list({ action: "test.historical" })).data[0]
        ?.actor,
    ).toBeNull();
  } finally {
    db.close();
  }
  const { withAuditActor } = await import("../auth/audit-actor.js");
  await withAuditActor(
    () => Promise.resolve({ kind: "key", id: "literal", name: "Literal %_" }),
    () =>
      ctx.storage.audit.log({ action: "test.literal", resource_type: "test" }),
  );
  expect(
    (await ctx.storage.audit.list({ q: "%_", action: "test.literal" })).data,
  ).toHaveLength(1);
  expect(
    (await ctx.storage.audit.list({ q: "%x", action: "test.literal" })).data,
  ).toHaveLength(0);
});

it("rolls the creator back with a failed registration", async () => {
  const { withAuditActor } = await import("../auth/audit-actor.js");
  const { runAuditedTransaction } =
    await import("../storage/audited-transaction.js");
  const creator = {
    kind: "local" as const,
    id: "local",
    name: "Local command",
  };
  await expect(
    withAuditActor(
      () => Promise.resolve(creator),
      () =>
        runAuditedTransaction(
          ctx.storage,
          async () => {
            await ctx.storage.types.create({
              id: "user.rolled_back_creator",
              label: "Rollback",
              version: 1,
              fields: {},
            });
            expect(
              (await ctx.storage.types.provenance("user.rolled_back_creator"))
                .created_by,
            ).toEqual(creator);
            throw new Error("stop registration");
          },
          { action: "test.creator_rollback", resource_type: "type" },
        ),
    ),
  ).rejects.toThrow("stop registration");
  expect(
    await ctx.storage.types.get("user.rolled_back_creator"),
  ).toBeUndefined();
  expect(
    (await ctx.storage.audit.list({ action: "test.creator_rollback" })).data,
  ).toEqual([]);
});
