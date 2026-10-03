import { afterAll, beforeAll, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { MarfaClient } from "../../client/api.js";
import type { ApiKeyRequest, TestContext } from "../../client/types.js";
import { CliDevice, CliFolder, newStore } from "../../device/cli-adapter.js";
import type { Outcome, QueuedWrite } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackKey,
  trackFolder,
} from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
beforeAll(async () => {
  ({ client, ctx, apiUrl } = await createTestContext(
    "device",
    "grant-recovery",
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

it.each(["edit", "create", "metadata", "edge", "extension"] as const)(
  "sends a real %s after its key's grant is restored",
  async (kind) => {
    const rights: Partial<ApiKeyRequest> = {
      type_permissions: { "core.note": "write" },
      edge_permissions: { "*": "write" },
      metadata_permissions: { "*": "read" },
      extension_permissions: { "*": "write" },
    };
    const minted = await client.createKey({
      label: `${ctx.source}-${kind}`,
      source: `${ctx.source}-${kind}`,
      default_tier: "library",
      ...rights,
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { title: kind, body: "before narrowing" },
    });
    expect(seed.ok, JSON.stringify(seed.error)).toBe(true);
    trackItem(ctx, seed.data.item.id);
    const target = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { title: "target", body: "target" },
    });
    expect(target.ok, JSON.stringify(target.error)).toBe(true);
    trackItem(ctx, target.data.item.id);
    const store = newStore("grant-live");
    const device = new CliDevice({
      binary: requireBinary(),
      store,
      url: apiUrl,
      key: minted.data.key,
    });
    try {
      value(await device.hydrate(["core.note"], "library"));
      let write: QueuedWrite;
      const id = seed.data.item.id;
      switch (kind) {
        case "edit":
          write = value(
            await device.update(id, {
              version: seed.data.item.version,
              properties: { body: "saved offline" },
            }),
          );
          break;
        case "create":
          write = value(
            await device.create({
              type: "core.note",
              properties: { title: "new offline", body: "saved offline" },
            }),
          );
          break;
        case "metadata":
          write = value(
            await device.writeMetadata(id, ["saved-offline"], "replace"),
          );
          break;
        case "edge":
          write = value(
            await device.createEdge({
              source: id,
              target: target.data.item.id,
              type: "references",
            }),
          );
          break;
        case "extension":
          write = value(
            await device.writeExtension(id, "notes", { body: "saved offline" }),
          );
          break;
      }
      const narrowed: Partial<ApiKeyRequest> =
        kind === "edge"
          ? { edge_permissions: { "*": "read" } }
          : kind === "extension"
            ? { extension_permissions: { "*": "read" } }
            : { type_permissions: { "core.note": "read" } };
      const changed = await client.updateKey(minted.data.id, narrowed);
      expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
      const refused = value(await device.drain());
      expect(refused.verdicts[0]).toMatchObject({
        id: write.id,
        verdict: "blocked",
        reason: "credential_refused",
        refusal: { grant: { level: "write" } },
      });
      const held = value(await device.queue()).find(
        (row) => row.id === write.id,
      );
      expect(held?.body).toEqual(write.body);
      expect(held?.idempotency_key).toBe(write.idempotency_key);
      expect(value(await device.drain()).verdicts[0]?.verdict).toBe("blocked");
      const restored = await client.updateKey(minted.data.id, rights);
      expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
      expect(value(await device.drain()).verdicts[0]?.verdict).toBe("accepted");
      expect(
        value(await device.queue()).find((row) => row.id === write.id)
          ?.idempotency_key,
      ).toBe(write.idempotency_key);
      if (kind === "create") trackItem(ctx, write.item_id ?? "");
      switch (kind) {
        case "edit":
        case "create": {
          const read = await client.getItem(write.item_id ?? id);
          expect(read.ok, JSON.stringify(read.error)).toBe(true);
          expect(read.data.item.properties.body).toBe("saved offline");
          break;
        }
        case "metadata": {
          const read = await client.getMetadata(id);
          expect(read.ok, JSON.stringify(read.error)).toBe(true);
          expect(read.data.metadata.tags).toContain("saved-offline");
          break;
        }
        case "edge": {
          const read = await client.getEdge(write.edge_id ?? "");
          expect(read.ok, JSON.stringify(read.error)).toBe(true);
          expect(read.data.edge.target_id).toBe(target.data.item.id);
          break;
        }
        case "extension": {
          const read = await client.getItemExtension(id, "notes");
          expect(read.ok, JSON.stringify(read.error)).toBe(true);
          expect(read.data.data).toEqual({ body: "saved offline" });
          break;
        }
      }
    } finally {
      rmSync(dirname(store), { recursive: true, force: true });
    }
  },
);

it("keeps a folder's edit and create and sends both when its grant returns", async () => {
  const minted = await client.createKey({
    label: `${ctx.source}-folder`,
    source: `${ctx.source}-folder`,
    type_permissions: { "*": "write" },
    edge_permissions: { "*": "write" },
    metadata_permissions: { "*": "read" },
    default_tier: "library",
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  const settings = await client.createFolder({
    title: "grant recovery",
    search: { types: ["core.note"], tier: "library" },
    defaults: { type: "core.note", tier: "library" },
  });
  expect(settings.ok, JSON.stringify(settings.error)).toBe(true);
  trackFolder(ctx, settings.data.item.id);
  const dir = mkdtempSync(join(tmpdir(), "marfa-grant-folder-"));
  const folder = new CliFolder(dir, {
    binary: requireBinary(),
    url: apiUrl,
    key: minted.data.key,
    registry: join(dir, ".registry.json"),
  });
  try {
    value(await folder.add(settings.data.item.id));
    value(await folder.hydrate());
    const first = join(dir, "first.md");
    writeFileSync(first, "# First\n\noriginal text\n");
    const seeded = value(await folder.push());
    const created = seeded.drain.verdicts.find(
      (row) => row.kind === "create_item",
    );
    expect(created?.verdict).toBe("accepted");
    trackItem(ctx, created?.item_id ?? "");
    writeFileSync(
      first,
      readFileSync(first, "utf8").replace(
        "original text",
        "edited while offline",
      ),
    );
    writeFileSync(
      join(dir, "second.md"),
      "# Second\n\ncreated while offline\n",
    );
    const narrowed = await client.updateKey(minted.data.id, {
      type_permissions: { "*": "write", "core.note": "read" },
    });
    expect(narrowed.ok, JSON.stringify(narrowed.error)).toBe(true);
    const blocked = value(await folder.push());
    const itemWrites = blocked.drain.verdicts.filter((row) =>
      ["create_item", "update_item"].includes(row.kind),
    );
    expect(itemWrites.map((row) => row.verdict)).toEqual([
      "blocked",
      "blocked",
    ]);
    expect(
      itemWrites.every((row) => row.refusal?.code === "type_not_permitted"),
    ).toBe(true);
    expect(readFileSync(first, "utf8")).toContain("edited while offline");
    expect(readFileSync(join(dir, "second.md"), "utf8")).toContain(
      "created while offline",
    );
    const waitingFiles = value(await folder.status()).files.filter((file) =>
      ["first.md", "second.md"].includes(file.path),
    );
    expect(waitingFiles).toHaveLength(2);
    for (const file of waitingFiles) {
      expect(file).toMatchObject({
        status: "waiting",
        flag: "credential_refused",
      });
      expect(file.reason).toContain("type_not_permitted");
      expect(file.reason).toContain("core.note");
    }
    const restored = await client.updateKey(minted.data.id, {
      type_permissions: { "*": "write" },
    });
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    const landed = value(await folder.push());
    for (const write of itemWrites) {
      expect(
        landed.drain.verdicts.find((row) => row.id === write.id)?.verdict,
      ).toBe("accepted");
      trackItem(ctx, write.item_id ?? "");
      const read = await client.getItem(write.item_id ?? "");
      expect(read.ok, JSON.stringify(read.error)).toBe(true);
      expect(read.data.item.properties.body).toContain("while offline");
    }
  } finally {
    await folder.remove();
    rmSync(dir, { recursive: true, force: true });
  }
});
