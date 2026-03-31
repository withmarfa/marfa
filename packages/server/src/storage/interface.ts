import type {
  Item,
  CreateItemInput,
  UpdateItemInput,
  Metadata,
  Version,
  Thread,
  ApiKey,
  CreateKeyInput,
  PaginatedResult,
  SearchResult,
  ConflictResponse,
  ItemState,
} from "@myme/shared";
import type { TypeSchema } from "@myme/shared";

// ---------------------------------------------------------------------------
// Filter types
// ---------------------------------------------------------------------------

export type ItemSortField = "created_at" | "updated_at" | "timestamp";
export type SortDirection = "asc" | "desc";

export interface ItemFilters {
  type?: string;
  state?: ItemState;
  source?: string;
  parent_id?: string;
  thread_id?: string;
  tags?: string[];
  allowed_types?: string[];
  sort?: ItemSortField;
  direction?: SortDirection;
  limit?: number;
  cursor?: string;
}

export interface SearchFilters {
  type?: string;
  state?: ItemState;
  allowed_types?: string[];
  limit?: number;
}

// ---------------------------------------------------------------------------
// Cursor utilities (keyset pagination)
// ---------------------------------------------------------------------------

interface CursorPayload {
  v: string;
  id: string;
}

export function encodeCursor(sortValue: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: sortValue, id })).toString(
    "base64url",
  );
}

export function decodeCursor(cursor: string): CursorPayload {
  return JSON.parse(
    Buffer.from(cursor, "base64url").toString("utf-8"),
  ) as CursorPayload;
}

// ---------------------------------------------------------------------------
// Sub-store interfaces
// ---------------------------------------------------------------------------

export interface ItemStore {
  create(input: CreateItemInput): Item;
  get(id: string): Item | null;
  list(filters: ItemFilters): PaginatedResult<Item>;
  update(id: string, input: UpdateItemInput): Item | ConflictResponse;
  delete(id: string): void;
  restore(id: string): Item;
  transition(id: string, state: ItemState): Item;
}

export interface MetadataStore {
  get(itemId: string): Metadata;
  set(itemId: string, tags: string[], about: string[]): Metadata;
  merge(itemId: string, tags?: string[], about?: string[]): Metadata;
  addTags(itemId: string, tags: string[]): Metadata;
  removeTag(itemId: string, tag: string): Metadata;
}

export interface VersionStore {
  create(
    itemId: string,
    version: number,
    properties: Record<string, unknown>,
    deviceId?: string,
  ): Version;
  list(itemId: string): Version[];
  getByVersion(itemId: string, version: number): Version | null;
}

export interface ThreadStore {
  create(): Thread;
  get(id: string): Thread | null;
  list(limit: number, cursor?: string): PaginatedResult<Thread>;
  touch(id: string): void;
  getItems(threadId: string): Item[];
}

export interface TypeStore {
  list(): TypeSchema[];
  get(id: string): TypeSchema | undefined;
}

export interface SearchStore {
  search(query: string, filters: SearchFilters): SearchResult[];
  index(itemId: string, properties: Record<string, unknown>): void;
  remove(itemId: string): void;
}

export interface KeyStore {
  create(input: CreateKeyInput, keyHash: string): ApiKey;
  list(): ApiKey[];
  validate(
    keyHash: string,
  ): (ApiKey & { key_hash: string; revoked_at: string | null }) | null;
  revoke(id: string): void;
  updateLastUsed(id: string): void;
  count(): number;
}

export interface BlobStore {
  register(
    hash: string,
    mimeType: string,
    size: number,
    storagePath: string,
  ): void;
  get(
    hash: string,
  ): { mime_type: string; size: number; storage_path: string } | null;
}

// ---------------------------------------------------------------------------
// Aggregate storage interface
// ---------------------------------------------------------------------------

export interface Storage {
  items: ItemStore;
  metadata: MetadataStore;
  versions: VersionStore;
  threads: ThreadStore;
  types: TypeStore;
  search: SearchStore;
  keys: KeyStore;
  blobs: BlobStore;
  close(): void;
}
