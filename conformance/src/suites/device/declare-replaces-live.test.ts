import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext, TypeSchema } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackKey,
  trackType,
} from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

/**
 * "Declaring an app's types brings the instance's copy of them up to date."
 *
 * Run against a real server and the real binary: the server's own
 * normalization decides whether a declaration differs from the type it
 * holds, and its own rules decide whether a replacement is taken.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
beforeAll(async () => {
  ({ client, ctx, apiUrl } = await createTestContext(
    "device",
    "declare-replaces",
  ));
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
});

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

/** An app name no other run shares: `app.<name>.<type>`. */
function appName(): string {
  return `a${ctx.runId.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
}

async function keyWith(
  label: string,
  grants: { types: Record<string, "read" | "write">; permissions?: string[] },
): Promise<string> {
  const made = await client.createKey({
    label: `${ctx.source}-${label}`,
    source: `${ctx.source}-${label}`,
    default_tier: "library",
    permissions: grants.permissions ?? [],
    metadata_permissions: { types: "write" },
    type_permissions: grants.types,
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackKey(ctx, made.data.id);
  return made.data.key;
}

async function register(id: string, fields: TypeSchema["fields"]) {
  const made = await client.registerType({ id, fields });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackType(ctx, id, client);
}

async function joined(declared: Array<Record<string, unknown>>, key: string) {
  const offline = new CliDevice({
    binary: requireBinary(),
    store: newStore("declare-replaces-live"),
  });
  value(await offline.status());
  value(await offline.declareTypes(declared));
  return offline.reopen({ url: apiUrl, key });
}

it("replaces a type the app changed, and writes none the server already holds as declared, however the app wrote it", async () => {
  const app = appName();
  const changed = `app.${app}.changed`;
  const untidy = `app.${app}.untidy`;
  const audit = new MarfaClient({
    baseUrl: apiUrl,
    apiKey: await keyWith("audit", {
      types: { "core.note": "read" },
      permissions: ["audit.read"],
    }),
  });
  await register(changed, { title: { type: "string" } });
  await register(untidy, {
    title: { type: "string" },
    count: { type: "number", description: "How many" },
  });
  const key = await keyWith("app", {
    types: { [`app.${app}.*`]: "write", "core.note": "read" },
  });
  const device = await joined(
    [
      {
        id: changed,
        fields: { title: { type: "string" }, mood: { type: "string" } },
      },
      // Keys in another order, and the defaults the server writes out written
      // out here.
      {
        version: 0,
        fields: {
          count: {
            description: "How many",
            searchable: true,
            required: false,
            type: "number",
          },
          title: { searchable: true, type: "string" },
        },
        id: untidy,
      },
    ],
    key,
  );
  const report = value(await device.hydrate(["core.note"], "library"));
  expect(report.replaced_types).toEqual([changed]);
  expect(report.unreplaced_types).toEqual([]);
  const held = await client.getType(changed);
  expect(Object.keys(held.data.fields).sort()).toEqual(["mood", "title"]);

  const written = async (id: string) =>
    (await audit.listAudit({ action: "type.replace", resource_id: id })).data
      .data.length;
  // The witness for the absence: the changed type's replacement is audited.
  expect(await written(changed)).toBe(1);
  expect(await written(untidy)).toBe(0);

  // Once replaced it is held as declared, so the next hydration writes nothing.
  const again = value(await device.hydrate(["core.note"], "library"));
  expect(again.replaced_types).toEqual([]);
  expect(await written(changed)).toBe(1);
});

it("keeps what the server holds of a type it will not replace, says why, and finishes the hydration", async () => {
  const app = appName();
  const other = `${appName()}x`;
  const stricter = `app.${app}.stricter`;
  const foreign = `app.${other}.entry`;
  await register(stricter, { title: { type: "string" } });
  await register(foreign, { title: { type: "string" } });
  const key = await keyWith("app-refused", {
    types: { [`app.${app}.*`]: "write", "core.note": "read" },
  });
  const device = await joined(
    [
      // Needs `schema.write`, which this key does not hold.
      { id: stricter, fields: { title: { type: "string", required: true } } },
      // Outside the key's type map.
      {
        id: foreign,
        fields: { title: { type: "string" }, extra: { type: "string" } },
      },
    ],
    key,
  );
  const report = value(await device.hydrate(["core.note"], "library"));
  expect(report.replaced_types).toEqual([]);
  expect(
    Object.fromEntries(report.unreplaced_types.map((t) => [t.id, t.code])),
  ).toEqual({ [stricter]: "forbidden", [foreign]: "type_not_permitted" });
  expect(report.unreplaced_types.every((t) => t.message.length > 0)).toBe(true);
  expect(value(await device.status()).hydration).toBe("complete");
  const kept = await client.getType(stricter);
  expect(kept.data.fields["title"]?.required ?? false).toBe(false);
  expect(Object.keys((await client.getType(foreign)).data.fields)).toEqual([
    "title",
  ]);
});
