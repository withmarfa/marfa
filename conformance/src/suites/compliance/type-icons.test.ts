import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import {
  listTarGzEntries,
  readTarGzEntry,
  tarGz,
} from "../../utils/archive.js";
import type { TestContext, TypeSchema } from "../../client/types.js";
import {
  createTestContext,
  getManagementClient,
  getOwnerClient,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";

let client: MarfaClient;
let owner: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "type-icons",
  ));
  owner = getOwnerClient();
});

afterAll(async () => {
  await cleanup(ctx);
});

let minted = 0;
/** A fresh custom type with a title and a body field. */
async function register(
  extra: Partial<TypeSchema> = {},
  suffix = "",
): Promise<string> {
  minted += 1;
  const id = `user.icons-${ctx.runId}-${String(minted)}${suffix}`;
  const registered = await client.registerType({
    id,
    fields: { heading: { type: "string" }, text: { type: "string" } },
    ...extra,
  });
  expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
  return id;
}

function setIcon(who: MarfaClient, id: string, icon: unknown) {
  return who.rawRequest<{ type: TypeSchema }>(`/types/${id}/icon`, {
    method: "PUT",
    body: { icon },
  });
}

function clearIcon(who: MarfaClient, id: string) {
  return who.rawRequest<{ type: TypeSchema }>(`/types/${id}/icon`, {
    method: "DELETE",
  });
}

async function iconOf(id: string): Promise<string | undefined> {
  const read = await client.getType(id);
  expect(read.ok).toBe(true);
  return read.data.display_hints?.icon;
}

describe("a type's icon", () => {
  it("refuses a display_hints.icon that is not a Lucide name on every door that takes a definition", async () => {
    const id = await register({ display_hints: { icon: "star" } });
    expect(await iconOf(id)).toBe("star");

    for (const bad of ["Star", "STAR", "not-a-lucide-icon", "github", ""]) {
      const fields = { heading: { type: "string" as const } };
      const posted = await client.registerType({
        id: `user.icons-bad-${ctx.runId}`,
        fields,
        display_hints: { icon: bad },
      });
      expect(posted.status, `POST /types with ${bad}`).toBe(400);
      expect(posted.error?.error.code).toBe("invalid_schema");
      expect(JSON.stringify(posted.error)).toContain("display_hints.icon");

      const replaced = await client.replaceType(id, {
        id,
        fields,
        display_hints: { icon: bad },
      });
      expect(replaced.status, `PUT /types/{id} with ${bad}`).toBe(400);
      expect(replaced.error?.error.code).toBe("invalid_schema");
      expect(JSON.stringify(replaced.error)).toContain("display_hints.icon");

      const normalized = await client.rawRequest("/types/normalize", {
        method: "POST",
        body: {
          id: `user.icons-norm-${ctx.runId}`,
          fields,
          display_hints: { icon: bad },
        },
      });
      expect(normalized.status, `POST /types/normalize with ${bad}`).toBe(400);
      expect(JSON.stringify(normalized.error)).toContain("display_hints.icon");
    }
    // The refused replacements left the type as it was.
    expect(await iconOf(id)).toBe("star");
  });

  it("stores a body field's value as sent, whatever Markdown it holds", async () => {
    const id = await register({
      display_hints: { title_field: "heading", body_field: "text" },
    });
    for (const text of [
      "# Heading\n\n- one\n- **two**",
      "<b>not markdown</b>",
      "```\n",
    ]) {
      const made = await client.createItem({
        type: id,
        source: ctx.source,
        properties: { heading: "Quote", text },
      });
      expect(made.ok, JSON.stringify(made.error)).toBe(true);
      expect(made.data.item.properties.text).toBe(text);
      trackItem(ctx, made.data.item.id);
    }
  });

  it("lists the hints a type declares and not those it inherits", async () => {
    const parent = await register({
      display_hints: { title_field: "heading", icon: "star" },
    });
    minted += 1;
    const child = `${parent}.child`;
    expect(
      (
        await client.registerType({
          id: child,
          parent,
          fields: {},
          display_hints: { body_field: "text" },
        })
      ).ok,
    ).toBe(true);
    const listed = await client.listTypes();
    const found = listed.data.data.find((type) => type.id === child);
    expect(found?.display_hints).toEqual({ body_field: "text" });
    // The read of the type itself resolves each hint.
    expect((await client.getType(child)).data.display_hints).toEqual({
      title_field: "heading",
      body_field: "text",
      icon: "star",
    });
  });
});

describe("the owner's icon for a type", () => {
  it("sets the owner's icon for a type and reads it back", async () => {
    const id = await register({ display_hints: { icon: "star" } });
    const set = await setIcon(owner, id, "heart");
    expect(set.status, JSON.stringify(set.error)).toBe(200);
    await expectMatchesSchema("PUT", "/types/{id}/icon", 200, set.data);
    expect(set.data.type.display_hints?.icon).toBe("heart");
    expect(await iconOf(id)).toBe("heart");
  });

  it("clears the owner's icon, and clearing again changes nothing", async () => {
    const id = await register({ display_hints: { icon: "star" } });
    expect((await setIcon(owner, id, "heart")).status).toBe(200);
    const cleared = await clearIcon(owner, id);
    expect(cleared.status, JSON.stringify(cleared.error)).toBe(200);
    await expectMatchesSchema("DELETE", "/types/{id}/icon", 200, cleared.data);
    expect(cleared.data.type.display_hints?.icon).toBe("star");
    const again = await clearIcon(owner, id);
    expect(again.status).toBe(200);
    expect(await iconOf(id)).toBe("star");
  });

  it("answers the owner's icon in place of the author's, on the read, the list and a subtype", async () => {
    const parent = await register({ display_hints: { icon: "star" } });
    const inheriting = `${parent}.inheriting`;
    const own = `${parent}.own`;
    expect(
      (await client.registerType({ id: inheriting, parent, fields: {} })).ok,
    ).toBe(true);
    expect(
      (
        await client.registerType({
          id: own,
          parent,
          fields: {},
          display_hints: { icon: "moon" },
        })
      ).ok,
    ).toBe(true);
    expect((await setIcon(owner, parent, "heart")).status).toBe(200);

    expect(await iconOf(parent)).toBe("heart");
    const listed = await client.listTypes();
    expect(
      listed.data.data.find((type) => type.id === parent)?.display_hints?.icon,
    ).toBe("heart");
    // A child with no icon of its own follows its parent's, and one with its
    // own keeps it.
    expect(await iconOf(inheriting)).toBe("heart");
    expect(await iconOf(own)).toBe("moon");
    // The owner's icon for the child itself beats both.
    expect((await setIcon(owner, own, "sun")).status).toBe(200);
    expect(await iconOf(own)).toBe("sun");
  });

  it("keeps the owner's icon through a replacement of the type", async () => {
    const id = await register({ display_hints: { icon: "star" } });
    expect((await setIcon(owner, id, "heart")).status).toBe(200);
    const replaced = await client.replaceType(id, {
      id,
      version: 2,
      fields: { heading: { type: "string" }, text: { type: "string" } },
      display_hints: { icon: "moon" },
    });
    expect(replaced.ok, JSON.stringify(replaced.error)).toBe(true);
    expect(await iconOf(id)).toBe("heart");
    // The replacement did not copy the choice into the definition.
    expect((await clearIcon(owner, id)).status).toBe(200);
    expect(await iconOf(id)).toBe("moon");
  });

  it("does not bake the owner's icon into the definition when a read is written back", async () => {
    const id = await register({ display_hints: { icon: "box" } });
    expect((await setIcon(owner, id, "package")).status).toBe(200);
    const read = await client.getType(id);
    expect(read.ok).toBe(true);
    expect(read.data.display_hints?.icon).toBe("package");
    const written = await client.replaceType(id, read.data);
    expect(written.ok, JSON.stringify(written.error)).toBe(true);
    expect((await clearIcon(owner, id)).status).toBe(200);
    expect(await iconOf(id)).toBe("box");

    const bare = await register();
    expect((await setIcon(owner, bare, "package")).status).toBe(200);
    const bareRead = await client.getType(bare);
    const bareWritten = await client.replaceType(bare, bareRead.data);
    expect(bareWritten.ok, JSON.stringify(bareWritten.error)).toBe(true);
    expect((await clearIcon(owner, bare)).status).toBe(200);
    expect(await iconOf(bare)).toBeUndefined();
  });

  it("normalizes on the author's side, with the author's icon in resolved_type", async () => {
    const id = await register({ display_hints: { icon: "box" } });
    expect((await setIcon(owner, id, "package")).status).toBe(200);
    const normalized = await client.rawRequest<{
      resolved_type: TypeSchema | null;
    }>("/types/normalize", {
      method: "POST",
      body: { id, fields: { heading: { type: "string" } } },
    });
    expect(normalized.status).toBe(200);
    expect(normalized.data.resolved_type?.display_hints?.icon).toBe("box");
    expect(await iconOf(id)).toBe("package");
  });

  it("refuses a name outside the pinned release and a type nothing registered, and keeps the earlier choice", async () => {
    const id = await register({ display_hints: { icon: "star" } });
    expect((await setIcon(owner, id, "heart")).status).toBe(200);
    for (const bad of ["Heart", "not-a-lucide-icon", "github", ""]) {
      const refused = await setIcon(owner, id, bad);
      expect(refused.status, JSON.stringify(bad)).toBe(400);
      expect(refused.error?.error.code).toBe("invalid_schema");
    }
    // A body with no string icon is not a name at all.
    for (const bad of [7, null]) {
      const refused = await setIcon(owner, id, bad);
      expect(refused.status, JSON.stringify(bad)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }
    const refused = await setIcon(owner, id, "Heart");
    expect(JSON.stringify(refused.error)).toContain("icon");
    expect(await iconOf(id)).toBe("heart");

    const missing = await setIcon(
      owner,
      `user.icons-missing-${ctx.runId}`,
      "heart",
    );
    expect(missing.status).toBe(404);
    expect(missing.error?.error.code).toBe("type_not_found");
    const clearedMissing = await clearIcon(
      owner,
      `user.icons-missing-${ctx.runId}`,
    );
    expect(clearedMissing.status).toBe(404);
  });

  it("allows a key with schema.write on the type and refuses one without", async () => {
    const id = await register();
    const mint = async (label: string, body: Record<string, unknown>) => {
      const made = await client.createKey({
        label,
        source: `${ctx.source}-${label}`,
        ...body,
      });
      expect(made.ok, JSON.stringify(made.error)).toBe(true);
      trackKey(ctx, made.data.id);
      return new MarfaClient({ baseUrl: apiUrl, apiKey: made.data.key });
    };
    const allowed = await mint("icons-allowed", {
      permissions: ["schema.write"],
      type_permissions: { [id]: "write" },
    });
    const noPermission = await mint("icons-no-permission", {
      permissions: [],
      type_permissions: { [id]: "write" },
    });
    const wrongType = await mint("icons-wrong-type", {
      permissions: ["schema.write"],
      type_permissions: { "core.note": "write" },
    });

    expect((await setIcon(allowed, id, "heart")).status).toBe(200);
    expect(await iconOf(id)).toBe("heart");
    for (const refused of [noPermission, wrongType]) {
      const set = await setIcon(refused, id, "sun");
      expect(set.status).toBe(403);
      const cleared = await clearIcon(refused, id);
      expect(cleared.status).toBe(403);
    }
    expect(await iconOf(id)).toBe("heart");
    expect((await clearIcon(allowed, id)).status).toBe(200);

    // A key a connector is registered under is held to the same rule: it
    // changes the icon with schema.write on the type, and not without.
    const registered = await allowed.registerConnector({
      name: `${ctx.runId} icons`,
    });
    expect(registered.status).toBe(201);
    try {
      expect((await setIcon(allowed, id, "moon")).status).toBe(200);
      expect(await iconOf(id)).toBe("moon");
      expect((await clearIcon(allowed, id)).status).toBe(200);
      expect(await iconOf(id)).toBeUndefined();
    } finally {
      await getManagementClient().deleteConnectorState(registered.data.id);
    }
  });

  it("carries the owner's icons in an archive and adds back those the instance lacks, replacing none", async () => {
    const id = await register();
    expect((await setIcon(owner, id, "box")).status).toBe(200);
    const archive = await client.exportArchive({ source: ctx.source });
    expect(archive.status).toBe(200);
    const lines = (readTarGzEntry(archive.data, "types.ndjson") ?? "")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const carried = lines.filter((line) => "type_icon" in line);
    expect(carried.map((line) => line.type_icon)).toContainEqual({
      type_id: id,
      icon: "box",
    });
    const manifest = JSON.parse(
      readTarGzEntry(archive.data, "manifest.json") ?? "{}",
    ) as { type_icon_count: number };
    expect(manifest.type_icon_count).toBe(carried.length);

    // An icon the owner chose since the export stays.
    expect((await setIcon(owner, id, "sun")).status).toBe(200);
    const kept = await owner.restoreArchive(archive.data);
    expect(kept.ok, JSON.stringify(kept.error)).toBe(true);
    expect(kept.data.type_icons_skipped).toBeGreaterThanOrEqual(1);
    expect(await iconOf(id)).toBe("sun");

    // With none chosen, the archive's is added.
    expect((await clearIcon(owner, id)).status).toBe(200);
    const added = await owner.restoreArchive(archive.data);
    expect(added.ok, JSON.stringify(added.error)).toBe(true);
    expect(added.data.type_icons_added).toBeGreaterThanOrEqual(1);
    expect(await iconOf(id)).toBe("box");
    expect((await clearIcon(owner, id)).status).toBe(200);
  });

  it("refuses an archive whose icon line names no Lucide icon or no type, and writes nothing", async () => {
    const id = await register();
    const archive = await client.exportArchive({ source: ctx.source });
    expect(archive.status).toBe(200);
    for (const line of [
      { type_id: id, icon: "Not-An-Icon" },
      { type_id: `user.icons-nowhere-${ctx.runId}`, icon: "box" },
    ]) {
      const bad = tarGz(
        listTarGzEntries(archive.data).map((entry) => ({
          name: entry.name,
          body:
            entry.name === "types.ndjson"
              ? entry.body.toString("utf8") +
                `${JSON.stringify({ type_icon: line })}\n`
              : entry.body,
        })),
      );
      const refused = await owner.restoreArchive(bad);
      expect(refused.status, JSON.stringify(line)).toBe(400);
      expect(refused.error?.error.code).toBe("invalid_schema");
    }
    expect(await iconOf(id)).toBeUndefined();
  });

  it("discards the owner's icon with the type", async () => {
    const id = await register({ display_hints: { icon: "star" } });
    expect((await setIcon(owner, id, "heart")).status).toBe(200);
    const removed = await client.deleteType(id);
    expect(removed.ok, JSON.stringify(removed.error)).toBe(true);
    const again = await client.registerType({
      id,
      fields: { heading: { type: "string" } },
    });
    expect(again.ok, JSON.stringify(again.error)).toBe(true);
    expect(await iconOf(id)).toBeUndefined();
  });

  it("records the owner's icon change in the audit log", async () => {
    const id = await register();
    expect((await setIcon(owner, id, "heart")).status).toBe(200);
    expect((await clearIcon(owner, id)).status).toBe(200);
    const rows = await client.listAudit({
      resource_type: "type",
      resource_id: id,
    });
    expect(rows.ok).toBe(true);
    const actions = rows.data.data.map((row) => row.action);
    expect(actions).toContain("type.icon.set");
    expect(actions).toContain("type.icon.clear");
  });
});
