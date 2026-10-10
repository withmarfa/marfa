import { afterEach, beforeEach, expect, it } from "vitest";
import { consentLockDepth, withConsentLock } from "../auth/consent-lock.js";
import { writeItem } from "../storage/item-write.js";
import { createTestContext, request, type TestContext } from "../test-utils.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.cleanup();
});

type Raw = typeof ctx.storage & {
  __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
};

async function refuse(action: string) {
  await (ctx.storage as Raw).__sqliteRun(
    `CREATE TRIGGER reject_sign_in_audit BEFORE INSERT ON audit_log WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, 'sign-in audit rejected'); END`,
    [],
  );
}

async function dropRefusal() {
  await (ctx.storage as Raw).__sqliteRun(
    "DROP TRIGGER reject_sign_in_audit",
    [],
  );
}

function asOwner(method: string, path: string, body?: unknown) {
  return request(ctx.app, method, path, {
    headers: {
      cookie: ctx.owner.cookie,
      origin: new URL(ctx.config.authBaseUrl).origin,
    },
    ...(body === undefined ? {} : { body }),
  });
}

async function mint() {
  const response = await asOwner("POST", "/keys", {
    label: "subject",
    source: "sign-in-audit-subject",
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; key: string };
}

it("keeps a key live and its label unchanged when the audit of its end or rename fails", async () => {
  const subject = await mint();
  await refuse("key.revoke");
  expect(
    (await asOwner("DELETE", `/owner/sign-ins/${subject.id}`)).status,
  ).toBe(500);
  expect(
    (await request(ctx.app, "GET", "/keys/current", { key: subject.key }))
      .status,
  ).toBe(200);
  await dropRefusal();

  await refuse("key.update");
  expect(
    (
      await asOwner("PATCH", `/owner/sign-ins/${subject.id}`, {
        name: "renamed",
      })
    ).status,
  ).toBe(500);
  expect((await ctx.storage.keys.get(subject.id))?.label).toBe("subject");
  await dropRefusal();

  // The witness: with the audit taken, both commit.
  expect(
    (
      await asOwner("PATCH", `/owner/sign-ins/${subject.id}`, {
        name: "renamed",
      })
    ).status,
  ).toBe(200);
  expect((await ctx.storage.keys.get(subject.id))?.label).toBe("renamed");
  expect(
    (await asOwner("DELETE", `/owner/sign-ins/${subject.id}`)).status,
  ).toBe(200);
  expect(
    (await request(ctx.app, "GET", "/keys/current", { key: subject.key }))
      .status,
  ).toBe(401);
});

it("keeps an app's name unchanged when the audit of its rename fails", async () => {
  const owner = await ctx.storage.owner?.find();
  expect(owner).toBeTruthy();
  const { item } = await writeItem(
    ctx.storage,
    { kind: "platform", by: null },
    {
      op: "create",
      type: "system.connection",
      state: "active",
      properties: {
        kind: "app",
        client_id: "sign-in-audit-client",
        user_id: owner!.id,
        scopes: ["core.note:read"],
        status: "active",
        granted_at: new Date().toISOString(),
      },
      source: "marfa/oauth2/consent",
    },
  );
  await refuse("auth.grant.rename");
  const refused = await asOwner("PATCH", `/owner/sign-ins/${item.id}`, {
    name: "Work laptop",
  });
  expect(refused.status).toBe(500);
  expect((await ctx.storage.items.get(item.id))?.properties.name).toBe(
    undefined,
  );
  await dropRefusal();
  const renamed = await asOwner("PATCH", `/owner/sign-ins/${item.id}`, {
    name: "Work laptop",
  });
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toMatchObject({
    id: item.id,
    kind: "app",
    name: "Work laptop",
  });
  expect((await ctx.storage.items.get(item.id))?.properties.name).toBe(
    "Work laptop",
  );
});

it("renames an app only once the grant's consent lock is free, and not after a revoke it waited for", async () => {
  const owner = await ctx.storage.owner?.find();
  const { item } = await writeItem(
    ctx.storage,
    { kind: "platform" },
    {
      op: "create",
      type: "system.connection",
      state: "active",
      properties: {
        kind: "app",
        client_id: "sign-in-lock-client",
        user_id: owner!.id,
        scopes: ["core.note:read"],
        status: "active",
        granted_at: new Date().toISOString(),
      },
      source: "marfa/oauth2/consent",
    },
  );
  let answered = false;
  let entered!: () => void;
  let leave!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (leave = resolve));
  // Held from a context of its own, so the rename below is a second caller
  // and not one the lock lets straight in.
  const holder = withConsentLock("sign-in-lock-client", owner!.id, async () => {
    entered();
    await gate;
    await writeItem(
      ctx.storage,
      { kind: "platform" },
      {
        op: "update",
        id: item.id,
        properties: { status: "revoked", revoked_at: new Date().toISOString() },
      },
    );
  });
  await inside;
  const rename = asOwner("PATCH", `/owner/sign-ins/${item.id}`, {
    name: "Work laptop",
  }).then((response) => {
    answered = true;
    return response;
  });
  for (let i = 0; i < 200; i++) {
    if (consentLockDepth("sign-in-lock-client", owner!.id) > 1) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(consentLockDepth("sign-in-lock-client", owner!.id)).toBe(2);
  expect(answered).toBe(false);
  leave();
  await holder;
  const response = await rename;
  expect(response.status).toBe(404);
  expect((await ctx.storage.items.get(item.id))?.properties.name).toBe(
    undefined,
  );
});
