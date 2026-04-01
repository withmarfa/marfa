import {
  ProtocolError,
  ErrorCode,
  getTypeSchema,
  TYPE_REGISTRY,
} from "@myme/shared";
import type { ItemState } from "@myme/shared";
import { checkAuth, checkTypeAccess, computeTypeFilter } from "../../middleware/auth.js";
import type { GraphQLContext } from "../context.js";

export const queryResolvers = {
  item: async (
    _: unknown,
    args: { id: string },
    ctx: GraphQLContext,
  ) => {
    checkAuth(ctx.apiKey);
    const item = await ctx.storage.items.get(args.id);
    if (!item) return null;
    checkTypeAccess(ctx.apiKey, item.type, "read");
    return item;
  },

  items: async (
    _: unknown,
    args: {
      type?: string;
      state?: string;
      source?: string;
      filter?: string;
      limit?: number;
      cursor?: string;
    },
    ctx: GraphQLContext,
  ) => {
    checkAuth(ctx.apiKey);
    if (args.type) checkTypeAccess(ctx.apiKey, args.type.replace(".*", ""), "read");

    return ctx.storage.items.list({
      type: args.type,
      state: args.state as ItemState | undefined,
      source: args.source,
      filter: args.filter,
      allowed_types: computeTypeFilter(ctx.apiKey),
      limit: args.limit ? Math.min(args.limit, 200) : 50,
      cursor: args.cursor,
    });
  },

  search: async (
    _: unknown,
    args: { query: string; type?: string; state?: string; limit?: number },
    ctx: GraphQLContext,
  ) => {
    checkAuth(ctx.apiKey);
    if (args.type) checkTypeAccess(ctx.apiKey, args.type, "read");

    return ctx.storage.search.search(args.query, {
      type: args.type,
      state: args.state as ItemState | undefined,
      allowed_types: computeTypeFilter(ctx.apiKey),
      limit: args.limit ? Math.min(args.limit, 100) : 20,
    });
  },

  threads: async (
    _: unknown,
    args: { limit?: number; cursor?: string },
    ctx: GraphQLContext,
  ) => {
    checkAuth(ctx.apiKey);
    return ctx.storage.threads.list(args.limit ?? 50, args.cursor);
  },

  thread: async (
    _: unknown,
    args: { id: string },
    ctx: GraphQLContext,
  ) => {
    checkAuth(ctx.apiKey);
    return ctx.storage.threads.get(args.id);
  },

  types: (
    _: unknown,
    _args: unknown,
    ctx: GraphQLContext,
  ) => {
    checkAuth(ctx.apiKey);
    return Array.from(TYPE_REGISTRY.values());
  },

  type: (
    _: unknown,
    args: { id: string },
    ctx: GraphQLContext,
  ) => {
    checkAuth(ctx.apiKey);
    const schema = getTypeSchema(args.id);
    if (!schema) {
      throw new ProtocolError(ErrorCode.TYPE_NOT_FOUND, `Type "${args.id}" not found`);
    }
    return schema;
  },
};
