import { serve } from "@hono/node-server";
import { join } from "node:path";
import type { AppConfig } from "../../src/config.js";
import { createSqliteStorage } from "../../src/storage/sqlite/index.js";
import { createBlobLayer } from "../../src/storage/blob-layer.js";
import { ensureInstanceId } from "../../src/storage/instance-id.js";
import { createApp } from "../../src/app.js";
import { BackgroundJobs } from "../../src/background-jobs/scheduler.js";
import { initEventLog } from "../../src/pubsub.js";

/**
 * A server that stops a restore partway through, inside its transaction, and
 * says so, for its parent to kill it there. `stopAfter` absent, it serves
 * normally.
 */
process.once(
  "message",
  (message: { dir: string; config: AppConfig; stopAfter?: number }) => {
    void (async () => {
      const storage = await createSqliteStorage(join(message.dir, "test.db"));
      const config = {
        ...message.config,
        blobPath: join(message.dir, "blobs"),
      };
      const blobs = await createBlobLayer(storage, config);
      const backgroundJobs = new BackgroundJobs(storage.backgroundJobs, {
        pollIntervalMs: 3_600_000,
      });
      const app = createApp(
        storage,
        blobs,
        backgroundJobs,
        config,
        await ensureInstanceId(storage.settings),
      );
      initEventLog(storage.eventLog);
      const { stopAfter } = message;
      if (stopAfter !== undefined) {
        const metadata = storage.metadata;
        const setExtensions = metadata.setExtensions.bind(metadata);
        let written = 0;
        metadata.setExtensions = async (id, extensions, proofFor) => {
          const result = await setExtensions(id, extensions, proofFor);
          written += 1;
          if (written === stopAfter) {
            process.send?.({ kind: "stopped", written });
            await new Promise(() => undefined);
          }
          return result;
        };
      }
      serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
        process.send?.({
          kind: "ready",
          url: `http://127.0.0.1:${String(info.port)}`,
        });
      });
    })();
  },
);
