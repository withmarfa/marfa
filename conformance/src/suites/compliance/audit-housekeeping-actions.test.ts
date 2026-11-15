import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  DAY_MS,
  movedClock,
  operatorOf,
  QUIET_SCHEDULE,
  quiet,
  runJob,
  writerOf,
} from "../../utils/moved-clock.js";

/**
 * The names of the audit actions that the enrichment sweep and the version
 * thinning job write.
 *
 * A server of its own: enrichment is off on the shared one, a job needs a
 * moved clock, and the claim that no entry of the action existed before the
 * job ran is a claim about the whole log.
 */
let server: FreshServer;
let writer: MarfaClient;
let operator: MarfaClient;
let clock: ReturnType<typeof movedClock>;

beforeAll(async () => {
  server = await bootFreshServer("audit-housekeeping-actions", {
    ...QUIET_SCHEDULE,
    MARFA_ENRICHMENT_ENABLED: "true",
    MARFA_VERSION_RECENT_DAYS: "1",
    MARFA_VERSION_DAILY_SNAPSHOT_DAYS: "2",
    MARFA_VERSION_WEEKLY_SNAPSHOT_DAYS: "20",
  });
  writer = writerOf(server);
  operator = operatorOf(server);
  clock = movedClock(server);
  await quiet(server, ["enrichment-sweep", "version-thinning"]);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

/** The entries of one action for one resource that the log holds as housekeeping. */
async function entries(action: string, resourceId: string) {
  const page = await operator.listAudit({
    action,
    resource_id: resourceId,
    kind: "housekeeping",
    limit: 200,
  });
  expect(page.status, JSON.stringify(page.error)).toBe(200);
  return page.data.data;
}

describe("the names of the audit actions that housekeeping jobs write", () => {
  it("names the enrichment sweep's write of a file item item.enrich, as housekeeping", async () => {
    const uploaded = await writer.uploadBlob(
      Buffer.from("text the sweep reads"),
      "text/plain",
    );
    expect(uploaded.status).toBe(201);
    const created = await writer.createItem({
      type: "core.file",
      properties: {
        blob_ref: uploaded.data.hash,
        mime_type: "text/plain",
        title: "audited enrichment",
      },
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    const id = created.data.item.id;
    expect(await entries("item.enrich", id)).toEqual([]);

    expect((await runJob(server, "enrichment-sweep")).outcome).toBe("ok");
    // The witness: the sweep did write the item, so the entry is the job's.
    const read = await writer.getItem(id);
    expect(read.data.item.properties.extracted_text).toBe(
      "text the sweep reads",
    );
    const written = await entries("item.enrich", id);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ key_id: null });
  });

  it("names the thinning job's removal of versions item.versions_thinned, as housekeeping", async () => {
    // Out of the minute before a UTC midnight, so the writes share a date.
    const intoDay = clock.now() % DAY_MS;
    if (intoDay > DAY_MS - 120_000) {
      await clock.advance(DAY_MS - intoDay + 1_000);
    }
    const created = await writer.createItem({
      type: "core.note",
      properties: { title: "v1", body: "thinned" },
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    const id = created.data.item.id;
    for (let n = 0; n < 4; n += 1) {
      const current = await writer.getItem(id);
      const updated = await writer.updateItem(id, {
        properties: { title: `v${String(current.data.item.version + 1)}` },
        version: current.data.item.version,
      });
      expect(updated.status, JSON.stringify(updated.error)).toBe(200);
    }
    expect(await entries("item.versions_thinned", id)).toEqual([]);
    const before = await writer.getVersions(id);
    expect(before.data.data.length).toBeGreaterThan(1);

    await clock.advance(1.5 * DAY_MS);
    expect((await runJob(server, "version-thinning")).outcome).toBe("ok");
    // The witness: the job did remove versions.
    const after = await writer.getVersions(id);
    expect(after.data.data.map((v) => v.version)).toEqual([4]);
    const written = await entries("item.versions_thinned", id);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ key_id: null });
  });
});
