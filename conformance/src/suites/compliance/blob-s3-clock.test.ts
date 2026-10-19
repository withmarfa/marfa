import { expect, it } from "vitest";
import { bootFreshServer } from "../../utils/fresh-server.js";
import { DAY_MS, HOUR_MS, runJob } from "../../utils/moved-clock.js";
import { clientsFor, ownObjectStore } from "../../utils/own-blob-server.js";

it("expires store-signed links on real time with a boot offset and later clock moves", async () => {
  const server = await bootFreshServer("blob-s3-clock", {
    ...ownObjectStore(),
    MARFA_TEST_CLOCK_OFFSET_MS: String(DAY_MS),
    MARFA_BLOB_CLEANUP_INTERVAL_MS: "0",
  });
  try {
    const { operator, working } = clientsFor(server);
    for (const step of [0, HOUR_MS]) {
      await server.advanceClock(step);
      const bytes = new TextEncoder().encode(`real-time link ${step}`);
      const upload = await working.uploadBlob(bytes, "text/plain");
      expect(upload.status).toBe(201);
      expect(
        (
          await working.createItem({
            type: "core.note",
            properties: { body: `![blob](${upload.data.hash})` },
          })
        ).status,
      ).toBe(201);
      await runJob(server, "blob-replicate");
      const link = await operator.getBlobUrl(upload.data.hash, 1);
      expect(link.status).toBe(200);
      expect(link.data.expires_in).toBe(1);
      expect(new URL(link.data.url).host).toBe(
        new URL(process.env.S3_ENDPOINT!).host,
      );
      const live = await fetch(link.data.url);
      expect(live.status).toBe(200);
      expect(new Uint8Array(await live.arrayBuffer())).toEqual(bytes);
      await new Promise((resolve) => setTimeout(resolve, 2200));
      const expired = await fetch(link.data.url);
      expect(expired.ok).toBe(false);
      expect(await expired.text()).not.toContain(
        new TextDecoder().decode(bytes),
      );
    }
  } finally {
    await server.stop();
  }
});
