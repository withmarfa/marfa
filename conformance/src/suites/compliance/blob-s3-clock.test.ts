import { expect, it } from "vitest";
import { bootFreshServer } from "../../utils/fresh-server.js";
import { DAY_MS, HOUR_MS, runJob } from "../../utils/moved-clock.js";
import { clientsFor, ownObjectStore } from "../../utils/own-blob-server.js";

/**
 * A link signed at 12.9 s carries the date 12 s, so it lives a tenth of a
 * second less than its lifetime says. A one-second link can therefore be dead
 * before a slow runner fetches it; this one outlives that by two seconds.
 */
const LINK_TTL_S = 3;

/** When a presigned link stops working: its `X-Amz-Date` plus `X-Amz-Expires`. */
function diesAtMs(url: string): number {
  const query = new URL(url).searchParams;
  const signed = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(
    query.get("X-Amz-Date") ?? "",
  );
  if (!signed) throw new Error("the link carries no X-Amz-Date");
  const [, y, mo, d, h, mi, s] = signed.map(Number);
  return (
    Date.UTC(y!, mo! - 1, d!, h!, mi!, s!) +
    Number(query.get("X-Amz-Expires")) * 1000
  );
}

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
      const link = await operator.getBlobUrl(upload.data.hash, LINK_TTL_S);
      expect(link.status).toBe(200);
      expect(link.data.expires_in).toBe(LINK_TTL_S);
      expect(new URL(link.data.url).host).toBe(
        new URL(process.env.S3_ENDPOINT!).host,
      );
      const live = await fetch(link.data.url);
      expect(live.status).toBe(200);
      expect(new Uint8Array(await live.arrayBuffer())).toEqual(bytes);
      // The link dies at its signing date, truncated to the second, plus its
      // lifetime. That instant is on real time, not on the server's moved
      // clock, or it would be a day or an hour away.
      const dies = diesAtMs(link.data.url);
      expect(dies - Date.now()).toBeLessThanOrEqual(LINK_TTL_S * 1000);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, dies - Date.now()) + 500),
      );
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
