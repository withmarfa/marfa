/**
 * Blobs API — pass-through to `@mymehq/sdk`.
 *
 * Blobs are content-addressed (sha256) and don't have meaningful local
 * optimistic state in v0.1: an upload either succeeds (the hash is
 * usable everywhere) or fails (the caller retries). Future work: a
 * `_myme_blob_queue` mirroring the Swift SDK's `PendingBlobModel`.
 */

import type { MymeClient } from "@mymehq/sdk";

export interface BlobsApiOptions {
  sdk: MymeClient;
}

export class BlobsApi {
  constructor(private readonly options: BlobsApiOptions) {}

  upload(
    data: Uint8Array | ArrayBuffer,
    mimeType: string,
  ): Promise<{ hash: string }> {
    return this.options.sdk.blobs.upload(data, mimeType);
  }

  download(hash: string): Promise<ArrayBuffer> {
    return this.options.sdk.blobs.download(hash);
  }

  exists(hash: string): Promise<boolean> {
    return this.options.sdk.blobs.exists(hash);
  }

  url(hash: string): string {
    return this.options.sdk.blobs.url(hash);
  }
}
