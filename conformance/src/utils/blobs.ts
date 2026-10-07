import type { MarfaClient } from "../client/api.js";
import type {
  ApiResponse,
  BlobUploadResponse,
  TestContext,
} from "../client/types.js";
import { trackItem } from "./setup.js";

/**
 * Uploads bytes and writes a note whose body links them, so the uploading
 * key may read them back: a blob is read through an item that references it
 * (`blobs.md` 15, 16). A note rather than a file, so no enrichment is asked
 * to read the bytes.
 */
export async function uploadReferenced(
  client: MarfaClient,
  ctx: TestContext,
  data: Uint8Array,
  mimeType: string,
): Promise<ApiResponse<BlobUploadResponse>> {
  const upload = await client.uploadBlob(data, mimeType);
  if (!upload.ok) return upload;
  await referenceBlob(client, ctx, upload.data.hash);
  return upload;
}

/** Writes a note whose body links the blob, so the key that holds the bytes
 *  may read them back. */
export async function referenceBlob(
  client: MarfaClient,
  ctx: TestContext,
  hash: string,
): Promise<void> {
  const note = await client.createItem({
    type: "core.note",
    source: ctx.source,
    properties: { body: `![bytes](${hash})` },
  });
  if (!note.ok) {
    throw new Error(
      `could not reference ${hash}: ${JSON.stringify(note.error)}`,
    );
  }
  trackItem(ctx, note.data.item.id);
}
