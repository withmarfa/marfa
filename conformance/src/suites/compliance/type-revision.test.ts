import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext, TypeSchema } from "../../client/types.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { cleanup, createTestContext, trackType } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "type-revision"));
});

afterAll(async () => {
  await cleanup(ctx);
});

let minted = 0;
async function register(): Promise<string> {
  minted += 1;
  const id = `user.revision-${ctx.runId}-${String(minted)}`;
  const made = await client.registerType({
    id,
    fields: { heading: { type: "string" } },
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackType(ctx, id, client);
  return id;
}

async function revisionOf(id: string): Promise<string> {
  const read = await client.getType(id);
  expect(read.ok, JSON.stringify(read.error)).toBe(true);
  expect(read.data.revision).toMatch(/^[0-9a-f]{64}$/);
  return read.data.revision!;
}

/** A replacement of `id` that changes only its description. */
function withDescription(id: string, description: string, revision?: string) {
  return client.replaceType(id, {
    id,
    description,
    fields: { heading: { type: "string" } },
    ...(revision === undefined ? {} : { revision }),
  });
}

async function replaceLogged(id: string): Promise<number> {
  const page = await client.listAudit({
    resource_id: id,
    action: "type.replace",
    limit: 200,
  });
  expect(page.ok, JSON.stringify(page.error)).toBe(true);
  return page.data.data.length;
}

describe("a type's revision", () => {
  it("is answered by every read of a type, and equals across them", async () => {
    const minted = await client.registerType({
      id: `user.revision-${ctx.runId}-read`,
      fields: { heading: { type: "string" } },
    });
    expect(minted.status, JSON.stringify(minted.error)).toBe(201);
    const id = minted.data.id;
    trackType(ctx, id, client);
    expect(minted.data.revision).toMatch(/^[0-9a-f]{64}$/);

    const read = await client.getType(id);
    await expectMatchesSchema("GET", "/types/{id}", 200, read.data);
    expect(read.data.revision).toBe(minted.data.revision);

    const listed = await client.listTypes();
    await expectMatchesSchema("GET", "/types", 200, listed.data);
    expect(listed.data.data.find((held) => held.id === id)?.revision).toBe(
      read.data.revision,
    );

    const replaced = await withDescription(id, "Changed.", read.data.revision);
    expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);
    const after = await client.getType(id);
    expect(replaced.data.revision).toBe(after.data.revision);
    expect(replaced.data.revision).not.toBe(read.data.revision);
  });

  it("answers 409 version_conflict to the second of two writers that read the same revision, and leaves the first writer's type", async () => {
    const id = await register();
    const read = await revisionOf(id);

    const first = await withDescription(id, "First writer.", read);
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    const logged = await replaceLogged(id);
    expect(logged).toBe(1);

    const second = await withDescription(id, "Second writer.", read);
    expect(second.status).toBe(409);
    expect(second.error?.error.code).toBe("version_conflict");
    const details = second.error?.error.details as { revision?: string };
    expect(details.revision).toBe(first.data.revision);

    const held = await client.getType(id);
    expect(held.data.description).toBe("First writer.");
    expect(held.data.revision).toBe(first.data.revision);
    expect(await replaceLogged(id)).toBe(logged);

    const retried = await withDescription(
      id,
      "Second writer.",
      details.revision,
    );
    expect(retried.status, JSON.stringify(retried.error)).toBe(200);
  });

  it("refuses a stale revision with force=true too, and writes nothing", async () => {
    const id = await register();
    const read = await revisionOf(id);
    expect((await withDescription(id, "Moved on.")).status).toBe(200);

    const forced = await client.rawRequest<TypeSchema>(
      `/types/${id}?force=true`,
      {
        method: "PUT",
        body: {
          id,
          description: "Forced.",
          fields: { heading: { type: "string" } },
          revision: read,
        },
      },
    );
    expect(forced.status).toBe(409);
    expect(forced.error?.error.code).toBe("version_conflict");
    expect((await client.getType(id)).data.description).toBe("Moved on.");
  });

  it("goes stale when the owner's icon alone changes", async () => {
    const id = await register();
    const before = await revisionOf(id);

    const iconed = await client.rawRequest<TypeSchema>(`/types/${id}/icon`, {
      method: "PUT",
      body: { icon: "lucide:star" },
    });
    expect(iconed.status, JSON.stringify(iconed.error)).toBe(200);
    expect(iconed.data.revision).toBe(await revisionOf(id));
    expect(iconed.data.revision).not.toBe(before);

    const stale = await withDescription(id, "From before the icon.", before);
    expect(stale.status).toBe(409);
    expect(stale.error?.error.code).toBe("version_conflict");

    const cleared = await client.rawRequest<TypeSchema>(`/types/${id}/icon`, {
      method: "DELETE",
    });
    expect(cleared.status, JSON.stringify(cleared.error)).toBe(200);
    expect(cleared.data.revision).toBe(before);
  });

  it("goes stale when a type it inherits from changes", async () => {
    const parent = await register();
    const child = `user.revision-${ctx.runId}-child`;
    const made = await client.registerType({ id: child, parent, fields: {} });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackType(ctx, child, client, parent);
    const before = await revisionOf(child);

    const grown = await client.replaceType(parent, {
      id: parent,
      fields: { heading: { type: "string" }, note: { type: "string" } },
    });
    expect(grown.status, JSON.stringify(grown.error)).toBe(200);
    expect(await revisionOf(child)).not.toBe(before);
  });

  it("is never stored: a revision in the body is dropped whether or not it matches", async () => {
    const id = await register();
    const read = await revisionOf(id);

    const matching = await withDescription(id, "Matching.", read);
    expect(matching.status, JSON.stringify(matching.error)).toBe(200);
    const stored = await client.getType(id);
    expect(stored.data.revision).toBe(matching.data.revision);
    expect(stored.data.revision).not.toBe(read);

    const blank = await withDescription(id, "Matching.", "");
    expect(blank.status).toBe(409);
    const numeric = await client.rawRequest<TypeSchema>(`/types/${id}`, {
      method: "PUT",
      body: { id, fields: {}, revision: 7 },
    });
    expect(numeric.status).toBe(400);
    expect(numeric.error?.error.code).toBe("validation_error");
  });

  it("is not checked when a write names none", async () => {
    const id = await register();
    const read = await revisionOf(id);
    expect((await withDescription(id, "One.", read)).status).toBe(200);
    const unconditional = await withDescription(id, "Two.");
    expect(unconditional.status, JSON.stringify(unconditional.error)).toBe(200);
    expect((await client.getType(id)).data.description).toBe("Two.");
  });

  it("makes DELETE /types/{id} refuse a stale revision and keep the type, and delete on the current one", async () => {
    const id = await register();
    const read = await revisionOf(id);
    const changed = await withDescription(id, "Changed.");
    expect(changed.status).toBe(200);

    const refused = await client.deleteType(id, false, read);
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("version_conflict");
    expect(
      (refused.error?.error.details as { revision?: string }).revision,
    ).toBe(changed.data.revision);
    expect((await client.getType(id)).status).toBe(200);

    const deleted = await client.deleteType(id, false, changed.data.revision);
    expect(deleted.status, JSON.stringify(deleted.error)).toBe(200);
    expect((await client.getType(id)).status).toBe(404);
  });

  it("goes stale when a write removes only what the resolved type folds away, so a stale write cannot revert it", async () => {
    const parent = await register();
    const parentRead = await client.replaceType(parent, {
      id: parent,
      roles: ["container"],
      fields: { s: { type: "string" } },
    });
    expect(parentRead.status, JSON.stringify(parentRead.error)).toBe(200);
    const child = `user.revision-${ctx.runId}-folded`;
    const made = await client.registerType({
      id: child,
      parent,
      roles: ["container"],
      fields: { s: { type: "string" } },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackType(ctx, child, client, parent);
    const r0 = await revisionOf(child);

    const dropped = await client.replaceType(child, {
      id: child,
      parent,
      fields: {},
      revision: r0,
    });
    expect(dropped.status, JSON.stringify(dropped.error)).toBe(200);
    const listed = await client.listTypes();
    expect(
      listed.data.data.find((held) => held.id === child)?.own_roles,
    ).toEqual([]);
    expect(dropped.data.revision).not.toBe(r0);
    expect(await revisionOf(child)).toBe(dropped.data.revision);

    const stale = await client.replaceType(child, {
      id: child,
      parent,
      roles: ["container"],
      fields: { s: { type: "string" } },
      revision: r0,
    });
    expect(stale.status).toBe(409);
    expect(stale.error?.error.code).toBe("version_conflict");
    const listedAfter = await client.listTypes();
    expect(
      listedAfter.data.data.find((held) => held.id === child)?.own_roles,
    ).toEqual([]);
  });

  it("is the same after a type is deleted and registered again with the same content by the same credential", async () => {
    const id = await register();
    const before = await revisionOf(id);
    const deleted = await client.deleteType(id, false, before);
    expect(deleted.status, JSON.stringify(deleted.error)).toBe(200);
    const again = await client.registerType({
      id,
      fields: { heading: { type: "string" } },
    });
    expect(again.status, JSON.stringify(again.error)).toBe(201);
    expect(again.data.revision).toBe(before);
    expect(await revisionOf(id)).toBe(before);
  });
});
