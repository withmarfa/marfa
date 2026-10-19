import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
} from "../../utils/fresh-server.js";
import { jobs, operatorOf, writerOf } from "../../utils/moved-clock.js";

describe("background jobs after the requesting key is revoked", () => {
  it.each(["enrichment-sweep", "webhook-schedule", "webhook-poll"])(
    "finishes and records %s independently of the requesting key",
    async (name) => {
      let deliveries = 0;
      const receiver = createServer((request, response) => {
        request.resume();
        deliveries += 1;
        response.writeHead(204).end();
      });
      await new Promise<void>((resolve) =>
        receiver.listen(0, "127.0.0.1", resolve),
      );
      const address = receiver.address();
      if (!address || typeof address === "string")
        throw new Error("receiver did not bind");
      let server: Awaited<ReturnType<typeof bootFreshServer>> | undefined;
      try {
        server = await bootFreshServer("background-authority", {
          MARFA_HOUSEKEEPING_POLL_INTERVAL_MS: "3600000",
          MARFA_ENRICHMENT_ENABLED: "true",
          MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES: "true",
        });
        const operator = operatorOf(server);
        const writer = writerOf(server);
        const webhook = await writer.createWebhook({
          url: `http://127.0.0.1:${String(address.port)}/receive`,
          events: ["item.updated"],
        });
        expect(webhook.status).toBe(201);
        const text = "a document for background extraction";
        const blob = await writer.uploadBlob(
          new TextEncoder().encode(text),
          "text/plain",
        );
        expect(blob.status).toBe(201);
        const file = await writer.createItem({
          type: "core.file",
          properties: { blob_ref: blob.data.hash, mime_type: "text/plain" },
        });
        expect(file.status).toBe(201);

        if (name !== "enrichment-sweep") {
          expect(
            (await operator.runHousekeeping("enrichment-sweep")).data.result,
          ).toMatchObject({ extracted: 1 });
        }
        if (name === "webhook-poll") {
          expect(
            (await operator.runHousekeeping("webhook-schedule")).data.result,
          ).toMatchObject({ scheduled: 1 });
        }
        {
          const minted = await operator.createKey({
            label: `run ${name}`,
            source: `background-${name}`,
            permissions: ["instance.maintain"],
          });
          expect(minted.status).toBe(201);
          const caller = new MarfaClient({
            baseUrl: server.apiUrl,
            apiKey: minted.data.key,
          });
          const hold = `hold:housekeeping:${name}`;
          await server.setFault(hold);
          const pending = caller.runHousekeeping(name);
          try {
            await server.waitForHold(hold);
            expect((await jobs(server))[name]?.running_since).not.toBeNull();
            expect((await operator.revokeKey(minted.data.id)).status).toBe(200);
          } finally {
            await server.clearFault(hold);
          }
          const finished = await pending;
          expect(finished.status).toBe(200);
          expect(
            finished.data.outcome,
            `${name}: ${finished.data.error ?? ""}`,
          ).toBe("ok");
          expect((await jobs(server))[name]).toMatchObject({
            running_since: null,
            last_outcome: "ok",
          });
          expect((await caller.runHousekeeping(name)).status).toBe(401);
          if (name === "enrichment-sweep") {
            expect(finished.data.result).toMatchObject({
              extracted: 1,
              failed: 0,
            });
            const read = await writer.getItem(file.data.item.id);
            expect(read.status).toBe(200);
            expect(read.data.item.properties.extracted_text).toBe(text);
          } else if (name === "webhook-schedule") {
            expect(finished.data.result).toMatchObject({ scheduled: 1 });
          } else {
            expect(finished.data.result).toMatchObject({ attempted: 1 });
            expect(deliveries).toBe(1);
          }
        }
      } finally {
        await server?.stop();
        receiver.closeAllConnections();
        await new Promise<void>((resolve) => receiver.close(() => resolve()));
      }
    },
    4 * FRESH_SERVER_TIMEOUT_MS,
  );
});
