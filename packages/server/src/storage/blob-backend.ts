import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// BlobBackend interface
// ---------------------------------------------------------------------------

export interface BlobBackend {
  put(key: string, bytes: Buffer, mimeType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  getPresignedUrl?(key: string, ttlSeconds: number): Promise<string>;
}

// ---------------------------------------------------------------------------
// Filesystem implementation
// ---------------------------------------------------------------------------

/**
 * Filesystem-based blob storage. Content-addressed by hash.
 * Files are stored in a two-level directory structure using the first
 * 4 characters of the hex digest as a prefix (e.g., blobs/e3b0/e3b0c44...).
 */
export class FilesystemBlobBackend implements BlobBackend {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = resolve(basePath);
    if (!existsSync(this.basePath)) {
      mkdirSync(this.basePath, { recursive: true });
    }
  }

  private safePath(key: string): string {
    const hex = key.replace("sha256:", "");
    const prefix = hex.slice(0, 4);
    const path = join(this.basePath, prefix, hex);
    const resolved = resolve(path);
    if (!resolved.startsWith(this.basePath)) {
      throw new Error("Invalid blob key");
    }
    return resolved;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- interface requires mimeType param
  async put(key: string, bytes: Buffer, _mimeType?: string): Promise<void> {
    const path = this.safePath(key);
    const dir = join(path, "..");
    await mkdir(dir, { recursive: true });
    await writeFile(path, bytes);
  }

  async get(key: string): Promise<Buffer | null> {
    const path = this.safePath(key);
    try {
      return await readFile(path);
    } catch (err: unknown) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.safePath(key));
      return true;
    } catch {
      return false;
    }
  }
}

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
