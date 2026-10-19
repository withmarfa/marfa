import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import { fileOf, requireBinary } from "./harness.js";

/**
 * A file queued under one key and sent under the key that replaced it
 * (`queue-and-verdicts/upload-sent-as-writer`), against a real server and the
 * real binary: the server refuses a file write from a credential that neither
 * sent its bytes nor may read them (`blobs/proof-file-refused`).
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
beforeAll(async () => {
  ({ client, ctx, apiUrl } = await createTestContext(
    "device",
    "upload-credential",
  ));
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
});

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

async function keyHolding(
  label: string,
  typePermissions: Record<string, string>,
): Promise<{ key: string; client: MarfaClient }> {
  const minted = await client.createKey({
    label: `${ctx.source}-${label}`,
    source: `${ctx.source}-${label}`,
    type_permissions: typePermissions,
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  return {
    key: minted.data.key,
    client: new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key }),
  };
}

it("sends a taken upload again under the key that replaced its sender, before the file waiting on it", async () => {
  // The first key may upload, through its note grant, but not write a file,
  // as a folder's key made without `core.file` may not.
  const first = await keyHolding("first", { "core.note": "write" });
  const second = await keyHolding("second", {
    "core.note": "write",
    "core.file": "write",
  });
  const store = newStore("upload-credential");
  const before = new CliDevice({
    binary: requireBinary(),
    store,
    url: apiUrl,
    key: first.key,
  });
  value(await before.hydrate(["core.note"], "library"));
  const bytes = `the bytes of a photo ${ctx.runId}\n`;
  const queued = value(
    await before.addFile(fileOf("photo.txt", bytes), { type: "core.file" }),
  );
  const upload = queued.find((write) => write.kind === "upload_blob");
  const file = queued.find((write) => write.kind === "create_item");
  expect(upload?.blob, JSON.stringify(queued)).toBeTruthy();
  value(await before.drain());
  const held = value(await before.queue());
  // The witness: the bytes went up under the first key and the file did not.
  expect(held.find((write) => write.id === upload?.id)?.verdict).toBe(
    "accepted",
  );
  expect(held.find((write) => write.id === file?.id)?.verdict).not.toBe(
    "accepted",
  );

  const after = new CliDevice({
    binary: requireBinary(),
    store,
    url: apiUrl,
    key: second.key,
  });
  // The second key reaches more, so the copy is made again under it, and
  // keeps the writes still waiting.
  value(await after.hydrate(["core.note"], "library"));
  const drained = value(await after.drain());
  const settled = value(await after.queue());
  expect(
    settled.find((write) => write.id === file?.id)?.verdict,
    JSON.stringify(drained),
  ).toBe("accepted");
  const id = settled.find((write) => write.id === file?.id)?.item_id;
  if (id) trackItem(ctx, id);

  const read = await second.client.downloadBlob(upload!.blob!);
  expect(
    read.status,
    "the file went out under a key that never sent its bytes, so nobody may read them",
  ).toBe(200);
  expect(new TextDecoder().decode(read.data as ArrayBuffer)).toBe(bytes);
});
