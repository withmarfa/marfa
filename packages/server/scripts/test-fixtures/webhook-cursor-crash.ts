import { serve } from "@hono/node-server";
import { join } from "node:path";
import type { AppConfig } from "../../src/config.js";
import { createSqliteStorage } from "../../src/storage/sqlite/index.js";
import { createBlobLayer } from "../../src/storage/blob-layer.js";
import { ensureInstanceId } from "../../src/storage/instance-id.js";
import { createApp } from "../../src/app.js";
import { BackgroundJobs } from "../../src/background-jobs/scheduler.js";
import { initEventLog } from "../../src/pubsub.js";
import { registerBackgroundJobs } from "../../src/background-jobs/registrations.js";

process.once(
  "message",
  (message: { dir: string; config: AppConfig; automatic?: boolean }) => {
    void (async () => {
      const storage = await createSqliteStorage(join(message.dir, "test.db"));
      const config = {
        ...message.config,
        blobPath: join(message.dir, "blobs"),
      };
      const blobs = await createBlobLayer(storage, config);
      const backgroundJobs = new BackgroundJobs(storage.backgroundJobs, {
        pollIntervalMs: message.automatic ? 1_000 : 3_600_000,
      });
      const app = createApp(
        storage,
        blobs,
        backgroundJobs,
        config,
        await ensureInstanceId(storage.settings),
      );
      initEventLog(storage.eventLog);
      let armed = false;
      const list = storage.outboundWebhooks.listAfter.bind(
        storage.outboundWebhooks,
      );
      storage.outboundWebhooks.listAfter = async (after, limit, context) => {
        if (armed) {
          process.send?.({ kind: "blocked" });
          await new Promise(() => undefined);
        }
        return list(after, limit, context);
      };
      registerBackgroundJobs(backgroundJobs, storage, blobs, {
        ...config,
        webhookAllowPrivateAddresses: true,
      });
      await backgroundJobs.start();
      await backgroundJobs.runNow("webhook-schedule");
      serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
        process.send?.({
          kind: "ready",
          url: `http://127.0.0.1:${String(info.port)}`,
        });
      });
      process.on("message", (command: { kind: string }) => {
        if (command.kind === "arm") {
          armed = true;
          process.send?.({ kind: "armed" });
        }
        if (command.kind === "pass") {
          void (async () => {
            const scheduled = await backgroundJobs.runNow("webhook-schedule");
            await backgroundJobs.runNow("webhook-poll");
            process.send?.({ kind: "passed", scheduled });
          })();
        }
      });
    })();
  },
);
