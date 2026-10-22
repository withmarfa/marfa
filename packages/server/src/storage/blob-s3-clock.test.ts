import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { advanceClock, installDateShim, resetClockForTests } from "../clock.js";
import { S3BlobStore } from "./blob-s3.js";

afterEach(resetClockForTests);

it("signs requests and links on real time before and after clock moves", async () => {
  const dates: string[] = [];
  const peer = createServer((request, response) => {
    dates.push(String(request.headers["x-amz-date"]));
    // The SDK sets its signing clock from the Date header of each answer,
    // which has one-second resolution, so a later signature can lag real
    // time by up to a second plus the time since that answer, more than the
    // bound below allows. With no header the signing clock is real time.
    response.sendDate = false;
    response.writeHead(200, { "content-length": "0" });
    response.end();
  });
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const address = peer.address();
  if (!address || typeof address === "string") throw new Error("no listener");
  const systemDate = Date;
  try {
    advanceClock(86_400_000);
    installDateShim();
    const store = new S3BlobStore({
      bucket: "clock-test",
      region: "us-east-1",
      endpoint: `http://127.0.0.1:${String(address.port)}`,
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
    });
    for (const step of [0, 3_600_000]) {
      advanceClock(step);
      const before = systemDate.now();
      await store.has("sha256:abc");
      const link = new URL(await store.link("sha256:abc", 1, "text/plain"));
      const parse = (value: string) =>
        Date.parse(
          value.replace(
            /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
            "$1-$2-$3T$4:$5:$6Z",
          ),
        );
      for (const date of [
        dates.at(-1)!,
        link.searchParams.get("X-Amz-Date")!,
      ]) {
        expect(parse(date)).toBeGreaterThanOrEqual(before - 1000);
        expect(parse(date)).toBeLessThanOrEqual(systemDate.now());
      }
    }
  } finally {
    peer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      peer.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
});
