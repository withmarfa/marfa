import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { RestoreArchiveResponse } from "../../client/types.js";
import { archiveManifest } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { DISK_ONLY, everythingClient } from "../../utils/own-blob-server.js";

/**
 * A restore reading an archive an earlier release wrote.
 *
 * The archive is `fixtures/archive-version-4/marfa-0.0.104.tar`, the file the
 * published v0.0.104 release exported at archive version 4, frozen in the
 * repository; its README says how it was made. No operation can make an
 * earlier release's archive, and every build after it restores the same file,
 * so a field or a line kind a later build adds within version 4 is absent from
 * it. The fixture names no version a build writes: it stays a version 4
 * archive when a build writes a later one.
 */

const ARCHIVE = new Uint8Array(
  readFileSync(
    join(
      import.meta.dirname,
      "fixtures",
      "archive-version-4",
      "marfa-0.0.104.tar",
    ),
  ),
);

const NOTE = "01a20e7d-fd36-77ef-bd1f-bcc86458e43d";
const TRASHED_NOTE = "01a20e7d-fd55-7300-a2a4-3a9c8193a9e0";
const FILE = "01a20e7d-fd2a-7428-8016-8699cdae3474";
const EDGE = "01a20e7d-fda8-71a8-b9d6-06f6ef9a8a96";
const BLOB =
  "sha256:0812ef137c851f1cdf53fa64b6a4bc99f33cf3a27ef465b0531bdd5b01495bd1";

interface Manifest {
  version: number;
  format: string;
  written_by: string;
  [count: string]: number | string;
}

/** What a restore answers for each count the manifest names, by that count. */
const ARRIVED: Record<string, (answer: Record<string, any>) => number> = {
  item_count: (answer) => answer.imported,
  edge_count: (answer) => answer.edges_imported,
  row_count: (answer) => answer.rows_imported,
  blob_count: (answer) => answer.blobs_imported,
  type_count: (answer) => answer.types_registered,
  edge_type_count: (answer) => answer.edge_types_registered,
  type_icon_count: (answer) => answer.type_icons_added,
  source_count: (answer) => answer.sources_added,
  setting_count: (answer) => answer.settings_added,
  enforcement_count: (answer) => answer.enforcement_added.length / 3,
  connector_state_count: (answer) => answer.connector_states_added,
  connector_agreement_count: (answer) => answer.connector_agreements_added,
  app_vendor_count: (answer) => answer.app_vendors_added,
  connector_mapping_count: (answer) => answer.connector_mappings_added,
};

let target: FreshServer;
let answer: RestoreArchiveResponse & Record<string, any>;

beforeAll(async () => {
  target = await bootFreshServer("restore-release-archive", DISK_ONLY);
  const local = new MarfaClient({
    baseUrl: target.apiUrl,
    controlSocket: target.controlSocket,
  });
  const restored = await local.restoreArchive(ARCHIVE);
  expect(restored.status, JSON.stringify(restored.error)).toBe(200);
  answer = restored.data;
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await target?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

describe("restoring an archive an earlier release wrote", () => {
  it("restores everything the manifest of a version 4 archive from v0.0.104 counts, whatever version this build writes", async () => {
    // The witness: the file is a release's version 4 archive that holds every
    // kind of entry and line, each counted, so an arrival below is not zero
    // for want of something to restore.
    const manifest = archiveManifest<Manifest>(ARCHIVE);
    expect(manifest.format).toBe("marfa-archive");
    expect(manifest.version).toBe(4);
    expect(manifest.written_by).toBe("marfa-server 0.0.104");
    const counts = Object.entries(manifest).filter(([name]) =>
      name.endsWith("_count"),
    );
    expect(counts.length).toBe(18);
    for (const [name, count] of counts) {
      expect(count, name).toBeGreaterThan(0);
    }

    expect(answer.entries_skipped).toEqual([]);
    expect(answer.line_kinds_skipped).toEqual([]);
    expect(answer.duplicates).toBe(0);
    expect(answer.edges_skipped).toBe(0);
    expect(answer.rows_skipped).toBe(0);
    for (const [name, arrived] of Object.entries(ARRIVED)) {
      expect(arrived(answer), name).toBe(manifest[name]);
    }
    // The settings of a plugin's connector: two values, and the secret left to
    // set again.
    expect(manifest.connector_setting_count).toBe(3);
    expect(answer.connector_secrets_to_set).toEqual([
      { plugin: "example-tracker", name: "token" },
    ]);
    const operator = await everythingClient(target);
    const plugin = await operator.getPlugin("example-tracker");
    expect(plugin.status, JSON.stringify(plugin.error)).toBe(200);
    expect(plugin.data.version).toBe("1.0.0");
    const settings = await operator.getConnectorSettings("example-tracker");
    expect(settings.status, JSON.stringify(settings.error)).toBe(200);
    expect(
      Object.fromEntries(
        settings.data.settings.map((one: Record<string, unknown>) => [
          one.name,
          one.value,
        ]),
      ),
    ).toMatchObject({
      feed_url: "https://tracker.example/feed",
      every: 15,
    });
    const mapping = await operator.getConnectorMapping("example-tracker");
    expect(mapping.status, JSON.stringify(mapping.error)).toBe(200);
    expect(mapping.data.version).toBe(2);
    expect(mapping.data.rewrites).toHaveLength(1);
  });

  it("restores a note with its two versions, tags and extension, the edge to its file, the file's bytes and a trashed note", async () => {
    const operator = await everythingClient(target);
    const note = await operator.getItem(NOTE);
    expect(note.status, JSON.stringify(note.error)).toBe(200);
    expect(note.data.item.version).toBe(2);
    expect(note.data.item.properties).toEqual({
      title: "Example note",
      body: "Second draft.",
    });
    expect([...note.data.metadata.tags].sort()).toEqual(["archive", "example"]);
    expect(note.data.metadata.extensions).toEqual({
      example: { colour: "blue" },
    });
    const versions = await operator.getVersions(NOTE);
    expect(versions.status, JSON.stringify(versions.error)).toBe(200);
    expect(versions.data.data.map((one) => one.version)).toContain(1);
    expect(
      versions.data.data.find((one) => one.version === 1)?.properties,
    ).toEqual({ title: "Example note", body: "First draft." });

    const edge = await operator.getEdge(EDGE);
    expect(edge.status, JSON.stringify(edge.error)).toBe(200);
    expect(edge.data.edge).toMatchObject({
      from_id: NOTE,
      to_id: FILE,
      edge_type: "references",
    });

    const bytes = await operator.downloadBlob(BLOB);
    expect(bytes.status).toBe(200);
    expect(new TextDecoder().decode(bytes.data)).toBe(
      "A small example file.\n",
    );

    const trashed = await operator.getItem(TRASHED_NOTE, "trashed");
    expect(trashed.status, JSON.stringify(trashed.error)).toBe(200);
    expect(trashed.data.item.state).toBe("trashed");
  });
});
