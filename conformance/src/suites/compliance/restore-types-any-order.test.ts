import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { editLineFile } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

let source: FreshServer;
let archive: Uint8Array;
const shape = {
  label: "Restored",
  description: "A restored type.",
  fields: { title: { type: "string" as const, required: true } },
};
const parent = "user.inherited_parent";
const child = "user.inherited_child";
const allTypes = [parent, child];
const ids: string[] = [];

beforeAll(async () => {
  source = await bootFreshServer("restore-order-source");
  const client = new MarfaClient({
    baseUrl: source.apiUrl,
    apiKey: source.workingKey,
  });
  for (const schema of [
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

describe("type archives", () => {
  it(
    "restores a type of an older archive that carries compatible_with, without the key",
    async () => {
      const destination = await bootFreshServer("restore-order-older");
      try {
        const owner = new MarfaClient({
          baseUrl: destination.apiUrl,
          controlSocket: destination.controlSocket,
        });
        const worker = new MarfaClient({
          baseUrl: destination.apiUrl,
          apiKey: destination.workingKey,
        });
        const older = editLineFile(archive, "instance", (text) => {
          const lines = text
            .trim()
            .split("\n")
            .map((line) => {
              const row = JSON.parse(line) as {
                type?: { id: string; compatible_with?: string[] };
              };
              if (row.type?.id === child) row.type.compatible_with = [parent];
              return JSON.stringify(row);
            });
          return lines.join("\n") + "\n";
        });
        const restored = await owner.restoreArchive(older);
        expect(restored.status, JSON.stringify(restored.error)).toBe(200);
        expect(restored.data).toMatchObject({
          types_registered: 2,
          imported: 2,
        });
        const read = await worker.getType(child);
        expect(read.status).toBe(200);
        expect(read.data).toMatchObject({ id: child, parent });
        expect(read.data).not.toHaveProperty("compatible_with");
      } finally {
        await destination.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it.each([
    "missing parent",
    "parent cycle",
    "display hint",
    "link field",
    "merge field",
    "inherited shape",
    "inherited thumbnail",
    "unknown required field",
    "unread key",
  ])(
    "refuses an archive with %s without leaving registrations behind",
    async (fault) => {
      const destination = await bootFreshServer("restore-order-refusal");
      try {
        const owner = new MarfaClient({
          baseUrl: destination.apiUrl,
          controlSocket: destination.controlSocket,
        });
        const worker = new MarfaClient({
          baseUrl: destination.apiUrl,
          apiKey: destination.workingKey,
        });
        const broken = editLineFile(archive, "instance", (text) => {
          const lines = text
            .trim()
            .split("\n")
            .map((line) => {
              const row = JSON.parse(line) as {
                type?: {
                  id: string;
                  fields: Record<string, unknown>;
                  parent?: string;
                  display_hints?: { title_field: string };
                  link_field?: string;
                  merge_policy?: { fields: Record<string, string> };
                  required?: string[];
                  unread_rule?: boolean;
                };
              };
              if (row.type === undefined) return line;
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
                if (fault === "unread key") row.type.unread_rule = true;
              }
              if (row.type.id === parent) {
                if (fault === "parent cycle") row.type.parent = child;
                if (fault === "inherited thumbnail")
                  row.type.fields.cover = { type: "thumbnail" };
              }
              return JSON.stringify(row);
            });
          return lines.join("\n") + "\n";
        });
        const refused = await owner.restoreArchive(broken);
        // The status and code `POST /types` answers the same definition with.
        expect(refused.status, JSON.stringify(refused.error)).toBe(400);
        expect(refused.error?.error.code).toBe(
          fault === "missing parent" || fault === "parent cycle"
            ? "validation_error"
            : fault === "inherited shape"
              ? "inheritance_violation"
              : "invalid_schema",
        );
        for (const type of allTypes)
          expect((await worker.getType(type)).status).toBe(404);
        for (const id of ids)
          expect((await worker.getItem(id)).status).toBe(404);
        const restored = await owner.restoreArchive(archive);
        expect(restored.status, JSON.stringify(restored.error)).toBe(200);
        expect(restored.data).toMatchObject({
          types_registered: 2,
          imported: 2,
        });
      } finally {
        await destination.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it.each([false, true])(
    "merges registrations into a non-empty store (conflict: %s)",
    async (conflict) => {
      const destination = await bootFreshServer("restore-order-merge");
      try {
        const worker = new MarfaClient({
          baseUrl: destination.apiUrl,
          apiKey: destination.workingKey,
        });
        const owner = new MarfaClient({
          baseUrl: destination.apiUrl,
          controlSocket: destination.controlSocket,
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
        const restored = await owner.restoreArchive(archive);
        expect(restored.status, JSON.stringify(restored.error)).toBe(
          conflict ? 409 : 200,
        );
        if (conflict) {
          expect(restored.error?.error).toMatchObject({
            code: "conflict",
            details: { conflicting_ids: [parent] },
          });
          expect((await worker.getType(child)).status).toBe(404);
        } else {
          expect(restored.data).toMatchObject({
            types_registered: 1,
            types_skipped: 1,
            imported: 2,
          });
        }
        expect((await worker.getType(parent)).data).toMatchObject({
          fields: existing.fields,
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
      const destination = await bootFreshServer("restore-order-destination");
      try {
        const owner = new MarfaClient({
          baseUrl: destination.apiUrl,
          controlSocket: destination.controlSocket,
        });
        const worker = new MarfaClient({
          baseUrl: destination.apiUrl,
          apiKey: destination.workingKey,
        });
        const bytes = reversed
          ? editLineFile(
              archive,
              "instance",
              (text) => text.trim().split("\n").reverse().join("\n") + "\n",
            )
          : archive;
        const restored = await owner.restoreArchive(bytes);
        expect(restored.status, JSON.stringify(restored.error)).toBe(200);
        expect(restored.data).toMatchObject({
          types_registered: 2,
          imported: 2,
        });
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
          types_skipped: 2,
          duplicates: 2,
        });
      } finally {
        await destination.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
