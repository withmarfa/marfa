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

// Re-export key types from @mymehq/shared
export type {
  Item,
  CreateItemInput,
  Metadata,
  Version,
  ApiKey,
  CreateKeyInput,
  PaginatedResult,
  SearchResult,
  ConflictSnapshot,
  ItemState,
} from "@mymehq/shared";
export type { TypeSchema } from "@mymehq/shared";
