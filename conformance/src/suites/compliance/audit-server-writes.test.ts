import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { waitFor } from "../../utils/wait.js";

/**
 * A write the server makes on its own account has no credential to name.
 *
 * A server of its own, with the orphan sweep's grace at zero so that the run
 * after a report purges, and with no other file writing blobs under it.
 */
let server: FreshServer | undefined;

beforeAll(async () => {
  server = await bootFreshServer("audit-server-writes", {
    MARFA_BLOB_CLEANUP_GRACE_MS: "0",
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

/** One run of a job, again while the server's own run holds its name. */
async function run(name: string): Promise<void> {
  const operator = new MarfaClient({
    baseUrl: server!.apiUrl,
    apiKey: server!.managementKey,
  });
  await waitFor(
    `${name} to run`,
    async () => {
      const ran = await operator.runHousekeeping(name);
      if (ran.status === 409) return undefined;
      expect(ran.status, JSON.stringify(ran.error)).toBe(200);
      expect(ran.data.outcome, ran.data.error ?? "").toBe("ok");
      return true;
    },
    30_000,
  );
}

describe("the audit log's record of the server's own writes", () => {
  it("records the server's own writes with no key", async () => {
    const writer = new MarfaClient({
      baseUrl: server!.apiUrl,
      apiKey: server!.workingKey,
    });
    const key = await writer.getCurrentKey();
    expect(key.ok, JSON.stringify(key.error)).toBe(true);
    const upload = await writer.uploadBlob(
      new TextEncoder().encode("an upload nothing names, purged by the sweep"),
      "text/plain",
    );
    expect(upload.ok, JSON.stringify(upload.error)).toBe(true);
    const hash = upload.data.hash;

    // The first run reports the blob as an orphan and the second purges it.
    await run("blob-orphans");
    await run("blob-orphans");

    const entriesFor = async (action: string) => {
      const listed = await writer.listAudit({ action, resource_id: hash });
      expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
      return listed.data.data;
    };
    // The witness: a write a credential makes names that credential, so the
    // absence of one on the purge is the purge's.
    const uploaded = await entriesFor("blob.upload");
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]!.key_id).toBe(key.data.id);

    const purged = await entriesFor("blob.purge");
    expect(purged).toHaveLength(1);
    expect(purged[0]).toMatchObject({
      key_id: null,
      resource_type: "blob",
      resource_id: hash,
    });
  });
});
