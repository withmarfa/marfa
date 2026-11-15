import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  DAY_MS,
  jobs,
  movedClock,
  QUIET_SCHEDULE,
  quiet,
  runJob,
} from "../../utils/moved-clock.js";
import { DISK_ONLY } from "../../utils/own-blob-server.js";

/**
 * What a connector keeps on the instance, which no housekeeping job bounds.
 * A source's state document stays until the connector or an owner clears it,
 * and an agreement stays as long as its item does: it goes when the item is
 * purged, by `trash-purge`, as it would by hand.
 *
 * The clock moves a year past every retention, and each job the instance
 * lists runs. The witness that the jobs delete what they are set to is the
 * item in the bin, which `trash-purge` purges, with the agreement it had.
 */

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

describe("housekeeping and what a connector keeps", () => {
  let server: FreshServer;
  let minter: MarfaClient;
  let clock: ReturnType<typeof movedClock>;

  beforeAll(async () => {
    server = await bootFreshServer("housekeeping-connector-data", {
      ...DISK_ONLY,
      ...QUIET_SCHEDULE,
    });
    minter = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.workingKey,
    });
    clock = movedClock(server);
    await quiet(server, ["trash-purge", "credential-cleanup"]);
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  async function note(by: MarfaClient, title: string): Promise<string> {
    const created = await by.createItem({
      type: "core.note",
      properties: { title, body: title },
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    return created.data.item.id;
  }

  /** A key of the source, as a connector holds it. */
  async function mint(
    source: string,
  ): Promise<{ client: MarfaClient; keyId: string }> {
    const minted = await minter.createKey({
      label: `${source}-${randomUUID()}`,
      source,
      default_tier: "library",
      type_permissions: { "core.note": "write" },
    });
    expect(minted.status, JSON.stringify(minted.error)).toBe(201);
    return {
      client: new MarfaClient({
        baseUrl: server.apiUrl,
        apiKey: minted.data.key,
      }),
      keyId: minted.data.id,
    };
  }

  /** The key's registration of the source, with the hold taken. */
  async function register(
    held: { client: MarfaClient; keyId: string },
    source: string,
    process: string,
  ): Promise<{ client: MarfaClient; id: string; keyId: string }> {
    const registered = await held.client.registerConnector({ name: source });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const taken = await held.client.takeConnectorHold(
      registered.data.id,
      process,
    );
    expect(taken.status).toBe(200);
    return { ...held, id: registered.data.id };
  }

  it(
    "keeps a source's state document and the agreements of its items through every job, and removes an agreement with its purged item",
    async () => {
      const source = `connector-data-${randomUUID()}`;
      const process = randomUUID();
      const first = await register(await mint(source), source, process);
      const kept = await note(first.client, "kept");
      const binned = await note(first.client, "binned");
      const state = { cursor: "page-17", seen: [1, 2, 3] };
      const wrote = await first.client.replaceConnectorState(first.id, {
        process,
        state,
      });
      expect(wrote.status, JSON.stringify(wrote.error)).toBe(200);
      const agreed = await first.client.writeConnectorAgreements(first.id, {
        process,
        set: [kept, binned].map((item_id) => ({
          item_id,
          waiting: true,
          record: { etag: item_id },
        })),
      });
      expect(agreed.status, JSON.stringify(agreed.error)).toBe(200);
      expect(agreed.data.written).toBe(2);
      expect((await first.client.deleteItem(binned)).status).toBe(200);
      const before = await first.client.lookupConnectorAgreements(first.id, [
        kept,
        binned,
      ]);
      expect(before.data.data.map((row) => row.item_id).sort()).toEqual(
        [kept, binned].sort(),
      );

      // A year and more past every retention, with every job run.
      await clock.advance(400 * DAY_MS);
      const listed = Object.keys(await jobs(server));
      expect(listed).toContain("trash-purge");
      expect(listed).toContain("credential-cleanup");
      for (const name of listed) {
        const run = await runJob(server, name);
        expect(run.outcome, `${name}: ${String(run.error)}`).toBe("ok");
      }

      // The state is as it was, the agreement of the item that stands stays,
      // and the one of the item purged went with it.
      const read = await first.client.getConnectorState(first.id);
      expect(read.status, JSON.stringify(read.error)).toBe(200);
      expect(read.data.state).toEqual(state);
      const found = await first.client.lookupConnectorAgreements(first.id, [
        kept,
        binned,
      ]);
      expect(found.data.data.map((row) => row.item_id)).toEqual([kept]);
      const listing = await first.client.listConnectorAgreements(first.id);
      expect(listing.data.data.map((row) => row.item_id)).toEqual([kept]);
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});
