// Client
export { MymeClient } from "./client.js";
export type {
  ClientConfig,
  UpdateOptions,
  ListFilters,
  SearchFilters,
  MetadataInput,
} from "./client.js";

// Errors
export {
  MymeError,
  NotFoundError,
  ValidationError,
  ConflictError,
  UnauthorizedError,
  ForbiddenError,
} from "./errors.js";

// Conflict types
export type {
  ConflictStrategy,
  ConflictData,
  ConflictResolver,
} from "./conflict.js";

// Re-export key types from @myme/shared
export type {
  Item,
  CreateItemInput,
  Metadata,
  Version,
  Thread,
  ApiKey,
  CreateKeyInput,
  PaginatedResult,
  SearchResult,
  ConflictSnapshot,
  ItemState,
} from "@myme/shared";
export type { TypeSchema } from "@myme/shared";
