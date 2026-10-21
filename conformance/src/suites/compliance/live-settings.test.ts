import { createServer } from "node:http";
import { expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

it(
  "starts disabled work after a live choice and stops it again without restarting",
  async () => {
    let pings = 0;
    let status = 503;
    const receiver = createServer((_req, res) => {
      pings++;
      res.writeHead(status).end();
    });
    await new Promise<void>((resolve) =>
      receiver.listen(0, "127.0.0.1", resolve),
    );
    let server: FreshServer | undefined;
    try {
      const address = receiver.address();
      if (!address || typeof address === "string")
        throw new Error("No listener");
      server = await bootFreshServer("live-settings", {
        MARFA_ENRICHMENT_ENABLED: "false",
        MARFA_ENRICHMENT_INTERVAL_MS: "3600000",
        MARFA_HEARTBEAT_ENABLED: "false",
        MARFA_HEARTBEAT_INTERVAL_MS: "3600000",
        MARFA_HEARTBEAT_URL: `http://127.0.0.1:${String(address.port)}/receiver`,
      });
      const client = new MarfaClient({
        baseUrl: server.apiUrl,
        apiKey: server.workingKey,
      });
      const operator = new MarfaClient({
        baseUrl: server.apiUrl,
        apiKey: server.managementKey,
      });
      const seed = async (text: string) => {
        const blob = await client.uploadBlob(Buffer.from(text), "text/plain");
        expect(blob.status).toBe(201);
        const item = await client.createItem({
          type: "core.file",
          properties: { blob_ref: blob.data.hash, mime_type: "text/plain" },
        });
        expect(item.status).toBe(201);
        return item.data.item.id;
      };
      const first = await seed("Readable once enabled");
      expect((await operator.runHousekeeping("enrichment-sweep")).status).toBe(
        200,
      );
      expect(
        (await client.getItem(first)).data.item.properties.extracted_text,
      ).toBeUndefined();
      expect(pings).toBe(0);
      expect(
        (
          await client.patchConfig({
            enrichment_enabled: true,
            heartbeat_enabled: true,
          })
        ).status,
      ).toBe(200);
      expect((await operator.runHousekeeping("enrichment-sweep")).status).toBe(
        200,
      );
      expect(
        (await client.getItem(first)).data.item.properties.extracted_text,
      ).toBe("Readable once enabled");
      expect((await operator.runHousekeeping("heartbeat")).status).toBe(200);
      expect(pings).toBe(1);
      status = 200;
      expect((await operator.runHousekeeping("heartbeat")).status).toBe(200);
      expect(pings).toBe(2);
      const second = await seed("Kept for a future run");
      expect(
        (
          await client.patchConfig({
            enrichment_enabled: null,
            heartbeat_enabled: false,
          })
        ).status,
      ).toBe(200);
      expect((await operator.runHousekeeping("enrichment-sweep")).status).toBe(
        200,
      );
      expect((await operator.runHousekeeping("heartbeat")).status).toBe(200);
      expect(pings).toBe(2);
      expect(
        (await client.getItem(second)).data.item.properties.extracted_text,
      ).toBeUndefined();
    } finally {
      await server?.stop();
      await new Promise<void>((resolve, reject) =>
        receiver.close((err) => {
          if (err) reject(err);
          else resolve();
        }),
      );
    }
  },
  3 * FRESH_SERVER_TIMEOUT_MS,
);
