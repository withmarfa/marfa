import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Filesystem-based blob storage. Content-addressed by hash.
 * Files are stored in a two-level directory structure using the first
 * 4 characters of the hex digest as a prefix (e.g., blobs/e3b0/e3b0c44...).
 */
export class FilesystemBlobBackend {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = resolve(basePath);
    if (!existsSync(this.basePath)) {
      mkdirSync(this.basePath, { recursive: true });
    }
  }

  private safePath(key: string): string {
    // key is the full hash string (sha256:<hex>)
    // Strip the prefix for the filename
    const hex = key.replace("sha256:", "");
    // Two-level directory: first 4 chars as prefix
    const prefix = hex.slice(0, 4);
    const path = join(this.basePath, prefix, hex);
    // Path traversal protection
    const resolved = resolve(path);
    if (!resolved.startsWith(this.basePath)) {
      throw new Error("Invalid blob key");
    }
    return resolved;
  }

  put(key: string, bytes: Buffer): void {
    const path = this.safePath(key);
    const dir = join(path, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, bytes);
  }

  get(key: string): Buffer | null {
    const path = this.safePath(key);
    if (!existsSync(path)) return null;
    return readFileSync(path);
  }

  exists(key: string): boolean {
    return existsSync(this.safePath(key));
  }
}
