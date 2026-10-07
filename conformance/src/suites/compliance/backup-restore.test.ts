import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { parseEnvFile } from "../../utils/target.js";
import { bootServer, stopServer } from "../../../scripts/marfa-server.js";

/**
 * An instance restored from a copy of its data directory taken while it was
 * writing: the instance chapter's `instance/image-*` and `instance/salt-*`
 * rules.
 *
 * The copy is an image of the directory at one instant, which is what a
 * volume snapshot or an APFS snapshot (and so Time Machine) takes. The
 * server's whole process group is stopped while the directory is copied, so
 * no write lands between one file and the next, and then resumed, so the
 * image is taken of an instance that is mid-write rather than at rest.
 */

let original: FreshServer;
const restoredStates: string[] = [];

beforeAll(async () => {
  original = await bootFreshServer("backup-original");
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  for (const state of restoredStates.splice(0)) {
    await stopServer({ state });
    rmSync(state, { recursive: true, force: true });
  }
  await original.stop();
}, FRESH_SERVER_TIMEOUT_MS);

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

interface Written {
  id: string;
  hash: string;
  bytes: Uint8Array;
}

/** Writes a note naming a fresh blob, again and again, until stopped. */
function writeContinuously(client: MarfaClient): {
  acknowledged: Written[];
  /** Resolves with the writer's failure, if it has one, so a wait on the
   *  writer ends with the reason rather than at the test's timeout. */
  failed: Promise<never>;
  stop: () => Promise<void>;
} {
  const acknowledged: Written[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const bytes = randomBytes(2_000 + acknowledged.length);
      const upload = await client.uploadBlob(bytes, "application/octet-stream");
      if (!upload.ok)
        throw new Error(`upload refused: ${JSON.stringify(upload)}`);
      const note = await client.createItem({
        type: "core.note",
        source: "backup-original",
        properties: { body: `![bytes](${upload.data.hash})` },
      });
      if (!note.ok) throw new Error(`note refused: ${JSON.stringify(note)}`);
      acknowledged.push({
        id: note.data.item.id,
        hash: upload.data.hash,
        bytes,
      });
    }
  })();
  const failed = loop.then(() => new Promise<never>(() => undefined));
  // Read through `stop`, and through the wait that races it.
  failed.catch(() => undefined);
  return {
    acknowledged,
    failed,
    stop: async () => {
      running = false;
      await loop;
    },
  };
}

/** The directory the server writes to, copied while the server is stopped. */
function imageOf(server: FreshServer): string {
  const state = dirname(server.sqlitePath);
  const group = Number(readFileSync(join(state, "server.pid"), "utf8").trim());
  const image = mkdtempSync(join(tmpdir(), "marfa-backup-image-"));
  restoredStates.push(image);
  process.kill(-group, "SIGSTOP");
  try {
    cpSync(state, image, {
      recursive: true,
      // What the running process owns rather than what it holds.
      filter: (source) => !/server\.(pid|log)$/.test(source),
    });
  } finally {
    process.kill(-group, "SIGCONT");
  }
  return image;
}

async function bootRestored(
  image: string,
): Promise<{ client: MarfaClient; apiUrl: string }> {
  await bootServer({ state: image, port: await freePort() });
  const env = parseEnvFile(readFileSync(join(image, "env"), "utf8"));
  const baseUrl = env.MARFA_API_URL;
  if (!baseUrl) throw new Error("the restored boot wrote no server address");
  // The key the original minted before the image was taken, which only
  // works if the restored database carries it and the instance's salt is
  // the same.
  return {
    client: new MarfaClient({ baseUrl, apiKey: original.workingKey }),
    apiUrl: baseUrl,
  };
}

describe("restoring a copy of the data directory taken while the instance was writing", () => {
  // The witness that the salt is part of what a restore needs: the same
  // image, started with another salt, holds the key and refuses it.
  it(
    "refuses a key it holds when started with a different API_KEY_SALT",
    async () => {
      const image = imageOf(original);
      process.env.API_KEY_SALT = "another-salt-".padEnd(40, "x");
      let restored: { client: MarfaClient; apiUrl: string };
      try {
        restored = await bootRestored(image);
      } finally {
        delete process.env.API_KEY_SALT;
      }

      const refused = await restored.client.listItems({ limit: 1 });

      expect(refused.ok).toBe(false);
      expect(refused.status).toBe(401);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "answers every write the instance had acknowledged before the copy began, and every blob they name",
    async () => {
      const client = new MarfaClient({
        baseUrl: original.apiUrl,
        apiKey: original.workingKey,
      });
      const writes = writeContinuously(client);
      try {
        for (const target of [25, 70]) {
          while (writes.acknowledged.length < target) {
            await Promise.race([
              writes.failed,
              new Promise((resolve) => setTimeout(resolve, 10)),
            ]);
          }
          const before = writes.acknowledged.slice();
          const image = imageOf(original);

          const { client: restored, apiUrl } = await bootRestored(image);

          expect((await fetch(`${apiUrl}/health`)).status).toBe(200);
          for (const written of before) {
            const item = await restored.getItem(written.id);
            expect(item.ok).toBe(true);
            const blob = await restored.downloadBlob(written.hash);
            expect(blob.ok).toBe(true);
            if (blob.ok) {
              expect(
                Buffer.from(blob.data).equals(Buffer.from(written.bytes)),
              ).toBe(true);
            }
          }
          // A working instance, not only a readable one.
          const next = await restored.createItem({
            type: "core.note",
            source: "backup-original",
            properties: { body: "written after the restore" },
          });
          expect(next.ok).toBe(true);
        }
      } finally {
        await writes.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
