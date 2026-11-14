import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  archiveLines,
  archiveManifest,
  editLineFile,
  itemsArchive,
  listEntries,
} from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  clientsFor,
  DISK_ONLY,
  everythingClient,
} from "../../utils/own-blob-server.js";
import { QUIET_TUNING, tuning } from "../../utils/tuning.js";
import { v7 as uuidv7 } from "uuid";

/**
 * What a restore says about itself: the enforcement settings an archive
 * carries, the reporting settings a server with no receiver still takes, what
 * it leaves out, and the old instance's backup folder; and what it holds an
 * item's extensions to.
 */

const ENFORCEMENT = {
  strict_mode: { types: ["core.note"] },
  source_allowlist: { types: ["core.note"], sources: ["listed"] },
  source_filter: { types: ["core.note"], sources: ["listed"] },
};

let origin: FreshServer;
let target: FreshServer;
let heard: ReturnType<typeof createServer>;

beforeAll(async () => {
  heard = createServer((_req, res) => res.writeHead(200).end());
  await new Promise<void>((resolve) => heard.listen(0, "127.0.0.1", resolve));
  const address = heard.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  origin = await bootFreshServer("restore-says-origin", {
    ...tuning(...QUIET_TUNING, "interval.heartbeat=3600000"),
    MARFA_HEARTBEAT_URL: `http://127.0.0.1:${String(address.port)}/receiver`,
  });
  target = await bootFreshServer("restore-says-target", DISK_ONLY);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await origin?.stop();
  await target?.stop();
  await new Promise<void>((resolve) => heard.close(() => resolve()));
}, FRESH_SERVER_TIMEOUT_MS);

const localOf = (server: FreshServer) =>
  new MarfaClient({
    baseUrl: server.apiUrl,
    controlSocket: server.controlSocket,
  });

const withSettings = (settings: Record<string, unknown>) =>
  editLineFile(itemsArchive([]), "instance", (text) =>
    Object.entries(settings).reduce(
      (lines, [key, value]) =>
        `${lines}${JSON.stringify({ setting: { key, value } })}\n`,
      text,
    ),
  );

describe("what a restore says", () => {
  it("restores the enforcement settings onto an instance with none, skips them on one that has them, and does not carry the name", async () => {
    const { operator } = clientsFor(origin);
    const set = await operator.patchConfig({
      name: "Origin library",
      enforcement: ENFORCEMENT,
      heartbeat_enabled: true,
    });
    expect(set.status, JSON.stringify(set.error)).toBe(200);
    const exported = await (await everythingClient(origin)).exportArchive();
    expect(exported.status).toBe(200);

    const lines = archiveLines<Record<string, unknown>>(
      exported.data,
      "instance",
    );
    expect(lines).toContainEqual({ enforcement: ENFORCEMENT });
    expect(archiveManifest(exported.data).enforcement_count).toBe(1);
    const keys = lines.flatMap((line) =>
      line.setting ? [(line.setting as { key: string }).key] : [],
    );
    expect(keys).not.toContain("name");
    expect(keys).toContain("heartbeat_enabled");

    const owner = localOf(target);
    const first = await owner.restoreArchive(exported.data);
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    expect(first.data.enforcement_added).toBe(1);
    expect(first.data.enforcement_skipped).toBe(0);
    expect(first.data.settings_without_receiver).toEqual(["heartbeat_enabled"]);
    expect(first.data.not_restored.map((one) => one.kind)).toEqual([
      "sign_in",
      "keys",
      "apps",
      "webhooks",
      "inbound_endpoints",
      "connector_keys",
      "addresses",
      "name",
      "logs",
    ]);
    expect(first.data.not_restored.find((one) => one.kind === "name")).toEqual({
      kind: "name",
      message: expect.stringContaining("name"),
    });
    expect(
      first.data.not_restored.find((one) => one.kind === "inbound_endpoints")
        ?.message,
    ).toContain("address");

    const config = (await clientsFor(target).operator.getConfig())
      .data as unknown as Record<string, unknown>;
    expect(config.enforcement).toEqual(ENFORCEMENT);
    expect(config.name).toBeUndefined();

    const again = await owner.restoreArchive(exported.data);
    expect(again.status, JSON.stringify(again.error)).toBe(200);
    expect(again.data.enforcement_added).toBe(0);
    expect(again.data.enforcement_skipped).toBe(1);
  });

  it("names the old instance's backup folder as safe to delete after a restore into another instance, and not after a restore into the same one", async () => {
    const exported = await (await everythingClient(origin)).exportArchive();
    expect(exported.status).toBe(200);
    const originId = archiveManifest(exported.data).instance_id as string;
    expect(originId).toMatch(/^[0-9a-f-]{36}$/);

    const restored = await localOf(target).restoreArchive(exported.data);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.previous_instance).toEqual({
      instance_id: originId,
      safe_to_delete: [`backups/${originId}`, `files/${originId}`],
    });

    const own = await (await everythingClient(target)).exportArchive();
    const same = await localOf(target).restoreArchive(own.data);
    expect(same.status, JSON.stringify(same.error)).toBe(200);
    expect(same.data.previous_instance).toBeUndefined();
  });

  it("restores a reporting setting that is turned on where no receiver is set, names it, and still refuses turning it on again from off", async () => {
    const bare = await bootFreshServer("restore-says-bare", DISK_ONLY);
    try {
      const owner = localOf(bare);
      const { operator } = clientsFor(bare);
      for (const key of ["heartbeat_enabled", "error_reporting_enabled"]) {
        const restored = await owner.restoreArchive(
          withSettings({ [key]: true }),
        );
        expect(restored.status, JSON.stringify(restored.error)).toBe(200);
        expect(restored.data.settings_without_receiver).toContain(key);
        // The reported value is accepted by the same server.
        expect((await operator.patchConfig({ [key]: true })).status).toBe(200);
        expect((await operator.patchConfig({ [key]: false })).status).toBe(200);
        const refused = await operator.patchConfig({ [key]: true });
        expect(refused.status).toBe(400);
        expect(refused.error?.error.details?.errors).toEqual([
          { path: key, message: expect.any(String) },
        ]);
      }
    } finally {
      await bare.stop();
    }
  });

  it("names an archived item whose extension sits in a reserved namespace or is over 100 KB, and restores nothing of the archive", async () => {
    const owner = localOf(target);
    const withExtension = (
      namespace: string,
      data: Record<string, unknown>,
    ) => {
      const id = uuidv7();
      const archive = editLineFile(
        itemsArchive([
          { id, type: "core.note", source: "restore-says", properties: {} },
        ]),
        "items",
        (text) =>
          text
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => {
              const held = JSON.parse(line) as {
                metadata: { extensions: Record<string, unknown> };
              };
              held.metadata.extensions = { [namespace]: data };
              return `${JSON.stringify(held)}\n`;
            })
            .join(""),
      );
      return { id, archive };
    };
    for (const [namespace, data] of [
      ["core", { a: 1 }],
      ["marfa", { a: 1 }],
      ["system", { a: 1 }],
      ["restoresays", { big: "x".repeat(102_400) }],
    ] as const) {
      const { id, archive } = withExtension(namespace, data);
      const refused = await owner.restoreArchive(archive);
      expect(
        refused.status,
        `${namespace}: ${JSON.stringify(refused.data)}`,
      ).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(refused.error?.error.details).toMatchObject({
        item_id: id,
        namespace,
      });
      expect((await (await everythingClient(target)).getItem(id)).status).toBe(
        404,
      );
    }

    // The witness: an ordinary namespace within the size restores.
    const fine = withExtension("restoresays", { small: "x" });
    const restored = await owner.restoreArchive(fine.archive);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.imported).toBe(1);
  });

  it("names no entry of an archive with a colon, so each extracts on Windows", async () => {
    const working = clientsFor(origin).working;
    const blob = await working.uploadBlob(
      Buffer.from("colon free"),
      "text/plain",
    );
    expect(blob.status).toBe(201);
    const made = await working.createItem({
      type: "core.file",
      properties: { blob_ref: blob.data.hash, mime_type: "text/plain" },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const exported = await (await everythingClient(origin)).exportArchive();
    const names = listEntries(exported.data).map((entry) => entry.name);
    expect(names).toContain(`blobs/${blob.data.hash.replace("sha256:", "")}`);
    expect(names.filter((name) => name.includes(":"))).toEqual([]);
    const restored = await localOf(target).restoreArchive(exported.data);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.blobs_missing).toEqual([]);
  });
});
