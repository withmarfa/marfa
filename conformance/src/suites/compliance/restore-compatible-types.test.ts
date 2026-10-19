import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { listTarGzEntries, tarGz } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

let source: FreshServer;
let archive: Uint8Array;
const first = "user.compatible_first";
const second = "user.compatible_second";
const shape = {
  label: "Compatible",
  description: "A compatible type.",
  fields: { title: { type: "string" as const, required: true } },
};
const parent = "user.inherited_parent";
const child = "user.inherited_child";
const allTypes = [first, second, parent, child];
const ids: string[] = [];

beforeAll(async () => {
  source = await bootFreshServer("compatible-source");
  const client = new MarfaClient({
    baseUrl: source.apiUrl,
    apiKey: source.workingKey,
  });
  for (const schema of [
    { id: first, ...shape },
    { id: second, ...shape, compatible_with: [first] },
    { id: parent, ...shape },
    {
      id: child,
      parent,
      fields: {},
      display_hints: { title_field: "title", body_field: "title" },
      link_field: "title",
      merge_policy: { fields: { title: "last_writer_wins" as const } },
    },
  ]) {
    const registered = await client.registerType(schema);
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  }
  const replaced = await client.replaceType(first, {
    ...shape,
    compatible_with: [second],
  });
  expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);
  for (const type of allTypes) {
    const created = await client.createItem({
      type,
      properties: { title: type },
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    ids.push(created.data.item.id);
  }
  const exported = await fetch(`${source.apiUrl}/export?format=archive`, {
    headers: { Authorization: `Bearer ${source.workingKey}` },
  });
  expect(exported.status).toBe(200);
  archive = new Uint8Array(await exported.arrayBuffer());
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await source?.stop();
});

describe("compatible type archives", () => {
  it(
    "refuses a target change that breaks a reader and restores the accepted registry",
    async () => {
      const origin = await bootFreshServer("dependent-source");
      const destination = await bootFreshServer("dependent-destination");
      try {
        const client = new MarfaClient({
          baseUrl: origin.apiUrl,
          apiKey: origin.workingKey,
        });
        expect(
          (await client.registerType({ id: "user.target", ...shape })).status,
        ).toBe(201);
        expect(
          (
            await client.registerType({
              id: "user.reader",
              ...shape,
              compatible_with: ["user.target"],
            })
          ).status,
        ).toBe(201);
        const refused = await client.replaceType("user.target", {
          ...shape,
          fields: { title: { type: "integer", required: true } },
        });
        expect(refused.status, JSON.stringify(refused.error)).toBe(422);
        expect(refused.error?.error).toMatchObject({
          code: "compatible_with_violation",
          details: { dependent_type_ids: ["user.reader"] },
        });
        for (const force of [false, true]) {
          const deleted = await client.deleteType("user.target", force);
          expect(deleted.status).toBe(422);
          expect(deleted.error?.error).toMatchObject({
            code: "compatible_with_violation",
            details: { dependent_type_ids: ["user.reader"] },
          });
        }
        const exported = await fetch(`${origin.apiUrl}/export?format=archive`, {
          headers: { Authorization: `Bearer ${origin.workingKey}` },
        });
        expect(exported.status).toBe(200);
        const bytes = new Uint8Array(await exported.arrayBuffer());
        const owner = new MarfaClient({
          baseUrl: destination.apiUrl,
          ownerCookie: destination.ownerCookie,
        });
        const restored = await owner.restoreArchive(bytes);
        expect(restored.status, JSON.stringify(restored.error)).toBe(200);
        expect(restored.data).toMatchObject({ types_registered: 2 });
        const worker = new MarfaClient({
          baseUrl: destination.apiUrl,
          apiKey: destination.workingKey,
        });
        expect((await worker.getType("user.target")).data).toMatchObject({
          fields: shape.fields,
        });
        expect((await worker.getType("user.reader")).data).toMatchObject({
          compatible_with: ["user.target"],
        });
        expect((await client.replaceType("user.reader", shape)).status).toBe(
          200,
        );
        expect(
          (
            await client.replaceType("user.target", {
              ...shape,
              fields: { title: { type: "integer", required: true } },
            })
          ).status,
        ).toBe(200);
      } finally {
        await origin.stop();
        await destination.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it.each([
    "missing target",
    "incompatible field",
    "malformed declaration",
    "missing parent",
    "parent cycle",
    "display hint",
    "link field",
    "merge field",
    "inherited shape",
    "inherited thumbnail",
    "unknown required field",
  ])(
    "refuses an archive with %s without leaving registrations behind",
    async (fault) => {
      const destination = await bootFreshServer("compatible-refusal");
      try {
        const owner = new MarfaClient({
          baseUrl: destination.apiUrl,
          ownerCookie: destination.ownerCookie,
        });
        const worker = new MarfaClient({
          baseUrl: destination.apiUrl,
          apiKey: destination.workingKey,
        });
        const broken = tarGz(
          listTarGzEntries(archive).map((entry) => {
            if (entry.name !== "types.ndjson") return entry;
            const lines = entry.body
              .toString()
              .trim()
              .split("\n")
              .map((line) => {
                const row = JSON.parse(line) as {
                  type: {
                    id: string;
                    compatible_with: unknown;
                    fields: Record<string, unknown>;
                    parent?: string;
                    display_hints?: { title_field: string };
                    link_field?: string;
                    merge_policy?: { fields: Record<string, string> };
                    required?: string[];
                  };
                };
                if (row.type.id === first) {
                  if (fault === "missing target")
                    row.type.compatible_with = ["user.absent_target"];
                  else if (fault === "incompatible field")
                    row.type.fields.title = { type: "integer", required: true };
                  else if (fault === "malformed declaration")
                    row.type.compatible_with = [42];
                }
                if (row.type.id === child) {
                  if (fault === "missing parent")
                    row.type.parent = "user.absent_parent";
                  if (fault === "display hint")
                    row.type.display_hints = { title_field: "absent" };
                  if (fault === "link field") row.type.link_field = "absent";
                  if (fault === "merge field")
                    row.type.merge_policy = {
                      fields: { absent: "last_writer_wins" },
                    };
                  if (fault === "inherited shape")
                    row.type.fields.title = { type: "integer", required: true };
                  if (fault === "inherited thumbnail")
                    row.type.fields.preview = { type: "thumbnail" };
                  if (fault === "unknown required field")
                    row.type.required = ["absent"];
                }
                if (row.type.id === parent) {
                  if (fault === "parent cycle") row.type.parent = child;
                  if (fault === "inherited thumbnail")
                    row.type.fields.cover = { type: "thumbnail" };
                }
                return JSON.stringify(row);
              });
            return { name: entry.name, body: lines.join("\n") + "\n" };
          }),
        );
        const refused = await owner.restoreArchive(broken);
        expect(refused.status, JSON.stringify(refused.error)).toBe(400);
        expect(refused.error?.error.code).toBe(
          fault === "missing parent" || fault === "parent cycle"
            ? "validation_error"
            : "invalid_schema",
        );
        for (const type of allTypes)
          expect((await worker.getType(type)).status).toBe(404);
        for (const id of ids)
          expect((await worker.getItem(id)).status).toBe(404);
        const restored = await owner.restoreArchive(archive);
        expect(restored.status, JSON.stringify(restored.error)).toBe(200);
        expect(restored.data).toMatchObject({
          types_registered: 4,
          imported: 4,
        });
      } finally {
        await destination.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it.each([false, true])(
    "merges compatible registrations into a non-empty store (conflict: %s)",
    async (conflict) => {
      const destination = await bootFreshServer("compatible-merge");
      try {
        const worker = new MarfaClient({
          baseUrl: destination.apiUrl,
          apiKey: destination.workingKey,
        });
        const owner = new MarfaClient({
          baseUrl: destination.apiUrl,
          ownerCookie: destination.ownerCookie,
        });
        const existing = {
          id: parent,
          ...shape,
          ...(conflict
            ? {
                fields: { title: { type: "integer" as const, required: true } },
              }
            : {}),
        };
        expect((await worker.registerType(existing)).status).toBe(201);
        const reader = "user.existing_reader";
        expect(
          (
            await worker.registerType({
              id: reader,
              fields: existing.fields,
              compatible_with: [parent],
            })
          ).status,
        ).toBe(201);
        const restored = await owner.restoreArchive(archive);
        expect(restored.status, JSON.stringify(restored.error)).toBe(
          conflict ? 409 : 200,
        );
        if (conflict) {
          expect(restored.error?.error).toMatchObject({
            code: "conflict",
            details: { conflicting_ids: [parent] },
          });
          for (const type of [first, second, child])
            expect((await worker.getType(type)).status).toBe(404);
        } else {
          expect(restored.data).toMatchObject({
            types_registered: 3,
            types_skipped: 1,
            imported: 4,
          });
        }
        expect((await worker.getType(parent)).data).toMatchObject({
          fields: existing.fields,
        });
        expect((await worker.getType(reader)).data).toMatchObject({
          compatible_with: [parent],
        });
      } finally {
        await destination.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it.each([false, true])(
    "round-trips accepted registrations into an empty store (reversed: %s)",
    async (reversed) => {
      const destination = await bootFreshServer("compatible-destination");
      try {
        const owner = new MarfaClient({
          baseUrl: destination.apiUrl,
          ownerCookie: destination.ownerCookie,
        });
        const worker = new MarfaClient({
          baseUrl: destination.apiUrl,
          apiKey: destination.workingKey,
        });
        const bytes = reversed
          ? tarGz(
              listTarGzEntries(archive).map((entry) =>
                entry.name === "types.ndjson"
                  ? {
                      name: entry.name,
                      body:
                        entry.body
                          .toString()
                          .trim()
                          .split("\n")
                          .reverse()
                          .join("\n") + "\n",
                    }
                  : entry,
              ),
            )
          : archive;
        const restored = await owner.restoreArchive(bytes);
        expect(restored.status, JSON.stringify(restored.error)).toBe(200);
        expect(restored.data).toMatchObject({
          types_registered: 4,
          imported: 4,
        });
        for (const [type, target] of [
          [first, second],
          [second, first],
        ]) {
          const read = await worker.getType(type!);
          expect(read.status).toBe(200);
          expect(read.data).toMatchObject({
            id: type,
            compatible_with: [target],
          });
        }
        const inherited = await worker.getType(child);
        expect(inherited.status).toBe(200);
        expect(inherited.data).toMatchObject({
          parent,
          display_hints: { title_field: "title", body_field: "title" },
          link_field: "title",
          merge_policy: { fields: { title: "last_writer_wins" } },
        });
        for (const [index, type] of allTypes.entries()) {
          const read = await worker.getItem(ids[index]!);
          expect(read.status).toBe(200);
          expect(read.data.item).toMatchObject({
            type,
            properties: { title: type },
          });
          const created = await worker.createItem({
            type,
            properties: { title: "After restore" },
          });
          expect(created.status, JSON.stringify(created.error)).toBe(201);
        }
        const again = await owner.restoreArchive(bytes);
        expect(again.status, JSON.stringify(again.error)).toBe(200);
        expect(again.data).toMatchObject({
          types_registered: 0,
          types_skipped: 4,
          duplicates: 4,
        });
      } finally {
        await destination.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
