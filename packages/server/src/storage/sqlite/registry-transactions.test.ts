import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import {
  createClient,
  type TransactionMode,
  type Transaction,
} from "@libsql/client";
import {
  getTypeSchema,
  getEdgeTypeSchema,
  edgeNameHolder,
  validateProperties,
  typeHasRole,
  satisfiesEdgeConstraint,
  unregisterTypeSchema,
  unregisterEdgeTypeSchema,
  type TypeSchema,
} from "@withmarfa/shared";
import {
  createTestContext,
  request,
  type TestContext,
} from "../../test-utils.js";

const publication = vi.hoisted(() => ({
  next: undefined as
    | { begun: () => void; committed: () => void; release: Promise<void> }
    | undefined,
}));
vi.mock("./connection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./connection.js")>();
  return {
    ...actual,
    createConnection: async (
      ...args: Parameters<typeof actual.createConnection>
    ) => {
      const connection = await actual.createConnection(...args);
      const raw: {
        transaction: (mode?: TransactionMode) => Promise<Transaction>;
      } = connection.raw;
      const begin = raw.transaction.bind(raw);
      raw.transaction = async (mode?: TransactionMode) => {
        const tx = await begin(mode ?? "write");
        const barrier = publication.next;
        if (barrier && (mode ?? "write") === "write") {
          publication.next = undefined;
          const commit = tx.commit.bind(tx);
          tx.commit = async () => {
            await commit();
            barrier.committed();
            await barrier.release;
          };
          barrier.begun();
        }
        return tx;
      };
      return connection;
    },
  };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const PARENT = "fixture.registry_parent";
const CHILD = "separate.registry_child";
const OTHER = "fixture.registry_other";
const EDGE = "fixture.registry-edge";
const REVERSE = "fixture.registry-reverse";
const parent: TypeSchema = {
  id: PARENT,
  version: 1,
  roles: ["container"],
  fields: { inherited: { type: "string", required: true } },
};
const child: TypeSchema = {
  id: CHILD,
  version: 1,
  parent: PARENT,
  fields: { own: { type: "string" } },
};
const changed: TypeSchema = {
  ...parent,
  version: 2,
  fields: {
    ...parent.fields,
    mandatory: { type: "string", required: true },
  },
};
const properties = { inherited: "value", own: "child" };
let ctx: TestContext;
let observer: ReturnType<typeof createClient>;
beforeEach(async () => {
  ctx = await createTestContext();
  observer = createClient({ url: `file:${join(ctx.tmpDir, "test.db")}` });
});
afterEach(async () => {
  publication.next = undefined;
  observer.close();
  await ctx.cleanup();
  for (const id of [PARENT, CHILD, OTHER]) unregisterTypeSchema(id);
  unregisterEdgeTypeSchema(EDGE);
});
async function durableType(id: string) {
  const rows = await observer.execute({
    sql: "SELECT schema FROM types WHERE id = ?",
    args: [id],
  });
  return rows.rows[0]
    ? (JSON.parse(rows.rows[0].schema as string) as TypeSchema)
    : undefined;
}
async function edgeRow() {
  return (
    await observer.execute({
      sql: "SELECT id FROM edge_types WHERE id = ?",
      args: [EDGE],
    })
  ).rows[0]?.id;
}
async function pair() {
  await ctx.storage.types.create(parent);
  await ctx.storage.types.create(child);
  expect(validateProperties(CHILD, properties).success).toBe(true);
  expect(validateProperties(CHILD, properties, { strict: true }).success).toBe(
    true,
  );
}
async function createEdge() {
  const response = await request(ctx.app, "POST", "/edge-types", {
    key: ctx.workingKey,
    body: {
      id: EDGE,
      cardinality: "many-to-many",
      reverse_name: REVERSE,
      source_type_constraints: ["role:container"],
      target_type_constraints: [PARENT],
    },
  });
  expect(response.status).toBe(201);
}

describe("registry views follow SQLite transactions", () => {
  it("positive: committed parent, descendant and edge agree with durable data", async () => {
    await ctx.storage.runInTransaction(async () => {
      await pair();
      await createEdge();
      expect(typeHasRole(CHILD, "container")).toBe(true);
      expect(satisfiesEdgeConstraint(CHILD, [PARENT])).toBe(true);
    });
    expect(await durableType(PARENT)).toEqual(parent);
    expect(await durableType(CHILD)).toEqual(child);
    expect(await edgeRow()).toBe(EDGE);
    expect(getTypeSchema(PARENT)).toEqual(parent);
    expect(getTypeSchema(CHILD)).toEqual(child);
    expect(getEdgeTypeSchema(EDGE)).toBeDefined();
    expect(edgeNameHolder(REVERSE)).toBe(EDGE);
  });

  it("root rollback removes the store registration as well as its SQL row", async () => {
    await expect(
      ctx.storage.runInTransaction(async () => {
        await ctx.storage.types.create(parent);
        expect(getTypeSchema(PARENT)).toEqual(parent);
        throw new Error("ordinary outer refusal");
      }),
    ).rejects.toThrow("ordinary outer refusal");
    const durable = await durableType(PARENT);
    console.log("ROOT_ROLLBACK", {
      durable: durable?.id,
      runtime: getTypeSchema(PARENT)?.id,
    });
    expect(durable).toBeUndefined();
    expect(getTypeSchema(PARENT)).toBeUndefined();
  });

  it("successful nested registration remains isolated from later outer rollback", async () => {
    await expect(
      ctx.storage.runInTransaction(async () => {
        await ctx.storage.runInTransaction(() =>
          ctx.storage.types.create(parent),
        );
        expect(getTypeSchema(PARENT)).toEqual(parent);
        throw new Error("ordinary outer refusal");
      }),
    ).rejects.toThrow("ordinary outer refusal");
    expect(await durableType(PARENT)).toBeUndefined();
    expect(getTypeSchema(PARENT)).toBeUndefined();
  });

  it("a caught nested rollback discards only its registration and compiled schemas", async () => {
    await ctx.storage.runInTransaction(async () => {
      await ctx.storage.types.create(parent);
      await expect(
        ctx.storage.runInTransaction(async () => {
          await ctx.storage.types.create(child);
          expect(
            validateProperties(CHILD, properties, { strict: true }).success,
          ).toBe(true);
          throw new Error("ordinary child refusal");
        }),
      ).rejects.toThrow("ordinary child refusal");
      await ctx.storage.types.create({ id: OTHER, version: 1, fields: {} });
    });
    expect(await durableType(PARENT)).toEqual(parent);
    expect(await durableType(OTHER)).toBeDefined();
    expect(await durableType(CHILD)).toBeUndefined();
    console.log("NESTED_ROLLBACK", {
      runtimeChild: getTypeSchema(CHILD)?.id,
      compiledChild: validateProperties(CHILD, properties, { strict: true })
        .success,
    });
    expect.soft(getTypeSchema(CHILD)).toBeUndefined();
    expect(
      validateProperties(CHILD, properties, { strict: true }).success,
    ).toBe(false);
  });

  it("a root rollback restores a deleted type", async () => {
    await pair();
    await expect(
      ctx.storage.runInTransaction(async () => {
        await ctx.storage.types.delete(PARENT);
        expect(getTypeSchema(PARENT)).toBeUndefined();
        throw new Error("ordinary outer refusal");
      }),
    ).rejects.toThrow("ordinary outer refusal");
    expect(await durableType(PARENT)).toEqual(parent);
    expect(getTypeSchema(PARENT)).toEqual(parent);
  });

  it("outside reads and warmed validation caches see the committed schema while a change is pending", async () => {
    await pair();
    const ready = deferred(),
      release = deferred();
    const writer = ctx.storage.runInTransaction(async () => {
      await ctx.storage.types.update(PARENT, changed);
      expect(validateProperties(CHILD, properties).success).toBe(false);
      expect(
        validateProperties(
          CHILD,
          { ...properties, mandatory: "present" },
          { strict: true },
        ).success,
      ).toBe(true);
      ready.resolve();
      await release.promise;
      throw new Error("ordinary pending refusal");
    });
    const rejection = expect(writer).rejects.toThrow(
      "ordinary pending refusal",
    );
    await ready.promise;
    const outside = {
      durableVersion: (await durableType(PARENT))?.version,
      runtimeVersion: getTypeSchema(PARENT)?.version,
      permissive: validateProperties(CHILD, properties).success,
      strict: validateProperties(CHILD, properties, { strict: true }).success,
    };
    console.log("OUTSIDE_PENDING", outside);
    release.resolve();
    await rejection;
    expect(getTypeSchema(PARENT)).toEqual(parent);
    expect(validateProperties(CHILD, properties).success).toBe(true);
    expect(
      validateProperties(CHILD, properties, { strict: true }).success,
    ).toBe(true);
    expect(outside).toEqual({
      durableVersion: 1,
      runtimeVersion: 1,
      permissive: true,
      strict: true,
    });
  });

  it("a root rollback discards a changed inherited schema and both compiled modes", async () => {
    await pair();
    await expect(
      ctx.storage.runInTransaction(async () => {
        await ctx.storage.types.update(PARENT, changed);
        expect(validateProperties(CHILD, properties).success).toBe(false);
        expect(
          validateProperties(CHILD, properties, { strict: true }).success,
        ).toBe(false);
        throw new Error("ordinary outer refusal");
      }),
    ).rejects.toThrow("ordinary outer refusal");
    expect(await durableType(PARENT)).toEqual(parent);
    console.log("ROLLED_BACK_CACHE", {
      runtimeVersion: getTypeSchema(PARENT)?.version,
      permissive: validateProperties(CHILD, properties).success,
      strict: validateProperties(CHILD, properties, { strict: true }).success,
    });
    expect.soft(getTypeSchema(PARENT)).toEqual(parent);
    expect.soft(validateProperties(CHILD, properties).success).toBe(true);
    expect(
      validateProperties(CHILD, properties, { strict: true }).success,
    ).toBe(true);
  });

  it("the ordinary edge route registration and reverse name roll back with an outer transaction", async () => {
    await pair();
    await expect(
      ctx.storage.runInTransaction(async () => {
        await createEdge();
        expect(getEdgeTypeSchema(EDGE)).toBeDefined();
        expect(edgeNameHolder(REVERSE)).toBe(EDGE);
        throw new Error("ordinary outer refusal");
      }),
    ).rejects.toThrow("ordinary outer refusal");
    expect(await edgeRow()).toBeUndefined();
    console.log("EDGE_ROLLBACK", {
      runtime: getEdgeTypeSchema(EDGE)?.id,
      reverse: edgeNameHolder(REVERSE),
    });
    expect.soft(getEdgeTypeSchema(EDGE)).toBeUndefined();
    expect(edgeNameHolder(REVERSE)).toBeUndefined();
  });

  it("positive: direct root refusal preserves registration and descendant caches", async () => {
    await pair();
    await expect(
      ctx.storage.runInTransaction(async () => {
        await ctx.storage.types.update(PARENT, changed);
        expect(
          validateProperties(CHILD, properties, { strict: true }).success,
        ).toBe(false);
        throw new Error("ordinary helper refusal");
      }),
    ).rejects.toThrow("ordinary helper refusal");
    expect(await durableType(PARENT)).toEqual(parent);
    expect(getTypeSchema(PARENT)).toEqual(parent);
    expect(validateProperties(CHILD, properties).success).toBe(true);
    expect(
      validateProperties(CHILD, properties, { strict: true }).success,
    ).toBe(true);
  });

  it("positive: ordinary native duplicate ABORT leaves parent and later registrations usable", async () => {
    await pair();
    await ctx.storage.runInTransaction(async () => {
      await expect(ctx.storage.types.create(changed)).rejects.toMatchObject({
        cause: {
          code: "SQLITE_CONSTRAINT",
          extendedCode: "SQLITE_CONSTRAINT_PRIMARYKEY",
        },
      });
      expect(getTypeSchema(PARENT)).toEqual(parent);
      expect(
        validateProperties(CHILD, properties, { strict: true }).success,
      ).toBe(true);
      await ctx.storage.types.create({ id: OTHER, version: 1, fields: {} });
    });
    expect(await durableType(PARENT)).toEqual(parent);
    expect(await durableType(OTHER)).toBeDefined();
  });

  it("positive: an ordinary acknowledged update makes later public item validation current", async () => {
    await pair();
    const before = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: CHILD, properties },
    });
    expect(before.status).toBe(201);
    await ctx.storage.types.update(PARENT, changed);
    const after = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: CHILD, properties },
    });
    expect(after.status).toBe(400);
    expect(await durableType(PARENT)).toEqual(changed);
    expect(
      validateProperties(
        CHILD,
        { ...properties, mandatory: "present" },
        { strict: true },
      ).success,
    ).toBe(true);
  });

  it("positive: committed deletion removes the row and runtime registration", async () => {
    await ctx.storage.types.create(parent);
    expect(await durableType(PARENT)).toEqual(parent);
    expect(getTypeSchema(PARENT)).toEqual(parent);
    await ctx.storage.types.delete(PARENT);
    expect(await durableType(PARENT)).toBeUndefined();
    expect(getTypeSchema(PARENT)).toBeUndefined();
  });

  it.each(["create", "update", "delete"] as const)(
    "a queued writer sees the acknowledged %s before validating",
    async (operation) => {
      if (operation === "update") await pair();
      else if (operation === "delete") await ctx.storage.types.create(parent);
      const begun = deferred(),
        committed = deferred(),
        release = deferred();
      publication.next = {
        begun: begun.resolve,
        committed: committed.resolve,
        release: release.promise,
      };
      const first =
        operation === "create"
          ? ctx.storage.types.create(parent)
          : operation === "update"
            ? ctx.storage.types.update(PARENT, changed)
            : ctx.storage.types.delete(PARENT);
      let writtenId: string | undefined;
      await begun.promise;
      const second = ctx.storage.runInTransaction(async () => {
        const observed = {
          durable: (await ctx.storage.types.listRegistered()).find(
            (schema) => schema.id === PARENT,
          )?.version,
          runtime: getTypeSchema(PARENT)?.version,
          validWithoutMandatory:
            operation === "update"
              ? validateProperties(CHILD, properties, { strict: true }).success
              : undefined,
          itemStatus: undefined as number | undefined,
        };
        if (operation !== "create") {
          const response = await request(ctx.app, "POST", "/items", {
            key: ctx.workingKey,
            body: { type: operation === "delete" ? PARENT : CHILD, properties },
          });
          observed.itemStatus = response.status;
          if (response.status === 201)
            writtenId = ((await response.json()) as { item: { id: string } })
              .item.id;
        }
        return observed;
      });
      await committed.promise;
      const observed = await second;
      console.log("PUBLICATION_WINDOW", { operation, ...observed });
      release.resolve();
      await first;
      const expected =
        operation === "create"
          ? parent
          : operation === "update"
            ? changed
            : undefined;
      expect(await durableType(PARENT)).toEqual(expected);
      expect(getTypeSchema(PARENT)).toEqual(expected);
      if (writtenId) {
        const row = (
          await observer.execute({
            sql: "SELECT json(properties) AS properties FROM items WHERE id = ?",
            args: [writtenId],
          })
        ).rows[0];
        expect(JSON.parse(row?.properties as string) as unknown).toEqual(
          properties,
        );
        console.log("ACKNOWLEDGED_UPDATE_WRITE", {
          durableSchemaVersion: (await durableType(PARENT))?.version,
          committedProperties: JSON.parse(row?.properties as string) as unknown,
        });
      }
      expect(observed).toEqual({
        durable: expected?.version,
        runtime: expected?.version,
        validWithoutMandatory: operation === "update" ? false : undefined,
        itemStatus: operation === "create" ? undefined : 400,
      });
    },
  );
});

it("a queued writer validates the baseline after a definite structural rollback", async () => {
  await pair();
  const entered = deferred(),
    release = deferred();
  const first = ctx.storage.runInTransaction(async () => {
    await ctx.storage.types.update(PARENT, changed);
    expect(
      validateProperties(CHILD, properties, { strict: true }).success,
    ).toBe(false);
    entered.resolve();
    await release.promise;
    throw new Error("ordinary rollback witness");
  });
  const refused = expect(first).rejects.toThrow("ordinary rollback witness");
  await entered.promise;
  const queued = ctx.storage.runInTransaction(async () => {
    expect(getTypeSchema(PARENT)).toEqual(parent);
    expect(
      validateProperties(CHILD, properties, { strict: true }).success,
    ).toBe(true);
    return await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: CHILD, properties },
    });
  });
  release.resolve();
  await refused;
  expect((await queued).status).toBe(201);
  expect(await durableType(PARENT)).toEqual(parent);
});
