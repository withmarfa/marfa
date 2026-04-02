import { createGraphQLError } from "graphql-yoga";
import { getTypeSchema, TYPE_REGISTRY } from "@myme/shared";
import type { ItemState } from "@myme/shared";
import {
  gqlCheckAuth,
  gqlCheckTypeAccess,
  computeTypeFilter,
  type GraphQLContext,
} from "../context.js";

export const queryResolvers = {
  item: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
    gqlCheckAuth(ctx.apiKey);
    const tid = ctx.apiKey?.tenant_id;
    const item = await ctx.storage.items.get(args.id, tid);
    if (!item) return null;
    gqlCheckTypeAccess(ctx.apiKey, item.type, "read");
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
    gqlCheckAuth(ctx.apiKey);
    if (args.type)
      gqlCheckTypeAccess(ctx.apiKey, args.type.replace(".*", ""), "read");

    return ctx.storage.items.list({
      tenantId: ctx.apiKey?.tenant_id,
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
    gqlCheckAuth(ctx.apiKey);
    if (args.type) gqlCheckTypeAccess(ctx.apiKey, args.type, "read");

    return ctx.storage.search.search(args.query, {
      tenantId: ctx.apiKey?.tenant_id,
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
    gqlCheckAuth(ctx.apiKey);
    return ctx.storage.threads.list(
      args.limit ?? 50,
      args.cursor,
      ctx.apiKey?.tenant_id,
    );
  },

  thread: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
    gqlCheckAuth(ctx.apiKey);
    return ctx.storage.threads.get(args.id, ctx.apiKey?.tenant_id);
  },

  types: (_: unknown, _args: unknown, ctx: GraphQLContext) => {
    gqlCheckAuth(ctx.apiKey);
    return Array.from(TYPE_REGISTRY.values());
  },

  type: (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
    gqlCheckAuth(ctx.apiKey);
    const schema = getTypeSchema(args.id);
    if (!schema) {
      throw createGraphQLError(`Type "${args.id}" not found`, {
        extensions: { code: "type_not_found" },
      });
    }
    return schema;
  },
};
