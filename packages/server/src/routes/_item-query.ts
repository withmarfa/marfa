/**
 * The query a folder's `query` and a view's `query` share: which items a
 * saved setting names. One schema builder and one check, so the two doors
 * accept and refuse the same shapes.
 */
import { z } from "@hono/zod-openapi";
import type { ZodType } from "zod";
import {
  ErrorCode,
  MarfaError,
  getTypeSchema,
  isSystemType,
  isValidId,
  isValidTypeIdentifier,
  parseFilter,
} from "@withmarfa/shared";

export function settingRefusal(
  code: ErrorCode,
  path: string,
  message: string,
): MarfaError {
  return new MarfaError(code, message, { errors: [{ path, message }] });
}

export function assertKnownType(path: string, id: string): void {
  if (!isValidTypeIdentifier(id)) {
    throw settingRefusal(
      ErrorCode.VALIDATION_ERROR,
      path,
      `Invalid type identifier: ${id}`,
    );
  }
  if (isSystemType(id)) {
    throw settingRefusal(
      ErrorCode.VALIDATION_ERROR,
      path,
      `${id} is a system type, which no item door writes`,
    );
  }
  if (getTypeSchema(id) === undefined) {
    throw settingRefusal(ErrorCode.UNKNOWN_TYPE, path, `Unknown type: ${id}`);
  }
}

/** The words that differ between the settings that hold a query. */
interface QueryWords {
  /** The OpenAPI component name. */
  name: string;
  description: string;
  types: string;
  tier: string;
  state: string;
  filter: string;
  beneath: string;
}

export function itemQuerySchema<T extends ZodType>(words: QueryWords, tier: T) {
  return z
    .strictObject({
      types: z.array(z.string()).max(100).optional().describe(words.types),
      tier: tier.optional().describe(words.tier),
      state: z
        .array(z.enum(["active", "archived"]))
        .min(1)
        .optional()
        .describe(words.state),
      filter: z.string().optional().describe(words.filter),
      beneath: z.string().optional().describe(words.beneath),
    })
    .openapi(words.name, { description: words.description });
}

export interface ItemQuery {
  types?: string[] | undefined;
  state?: ("active" | "archived")[] | undefined;
  filter?: string | undefined;
  beneath?: string | undefined;
}

/**
 * Refuses what the schema cannot see, naming the part at `<setting>.<part>`:
 * a type nothing registered or a `system.*` one, a filter the listing grammar
 * refuses, and a `beneath` that is not an item id.
 */
export function assertItemQuery(setting: string, query: ItemQuery): void {
  query.types?.forEach((id, i) => {
    assertKnownType(`${setting}.types.${String(i)}`, id);
  });
  if (query.filter !== undefined) {
    try {
      parseFilter(query.filter);
    } catch (err) {
      if (!(err instanceof MarfaError)) throw err;
      throw settingRefusal(
        ErrorCode.VALIDATION_ERROR,
        `${setting}.filter`,
        err.message,
      );
    }
  }
  if (query.beneath !== undefined && !isValidId(query.beneath)) {
    throw settingRefusal(
      ErrorCode.VALIDATION_ERROR,
      `${setting}.beneath`,
      `Invalid item id: ${query.beneath}`,
    );
  }
}
